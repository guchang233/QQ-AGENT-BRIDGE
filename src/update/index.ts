import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { ROOT } from '../config.ts';
import { getJson, download, envProxy } from './net.ts';
import type { Bridge } from '../bridge.ts';

/**
 * 自动更新：从 GitHub Release 获取新版本。
 *   - 发布包安装（解压即用）：下载 → 解压到 .update/ 预备 → 重启时由 bin/qab.mjs 在加载程序前替换文件（自动备份，失败回滚）
 *   - git / npm 安装：只提示，给出更新命令
 */
export type InstallType = 'package' | 'git' | 'npm';
export type Phase = 'idle' | 'checking' | 'downloading' | 'preparing' | 'staged' | 'error';

export interface UpdateStatus {
  current: string; installType: InstallType; supervised: boolean;
  phase: Phase; checkedAt: number; error: string;
  latest: string; hasUpdate: boolean; notes: string; url: string; publishedAt: string; asset: string; assetSize: number;
  progress: number; stagedVersion: string; lastUpdate: { from: string; to: string; at: number } | null; lastFailure: string;
  hint: string;
}

export const UPDATE_DIR = path.join(ROOT, '.update');
export const currentVersion = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version as string;
export const installType = (): InstallType => (ROOT.split(path.sep).includes('node_modules') ? 'npm' : fs.existsSync(path.join(ROOT, '.git')) ? 'git' : 'package');
export const platformTag = () => `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;

/** 语义化版本比较（含预发布：1.0.0-beta.1 < 1.0.0） */
export function compareVersions(a: string, b: string) {
  const parse = (v: string) => { const [core, pre = ''] = v.replace(/^v/, '').split('-', 2); return { nums: core.split('.').map((x) => Number(x) || 0), pre }; };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) > (y.nums[i] ?? 0) ? 1 : -1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre.localeCompare(y.pre, 'en', { numeric: true });
}

/** 从 Release 的附件里挑安装包：优先当前平台的免安装包，其次通用包 */
export function pickAsset(assets: { name: string; browser_download_url: string; size: number; digest?: string | null }[], tag: string) {
  const v = tag.replace(/^v/, '');
  return assets.find((a) => a.name === `qq-agent-bridge-v${v}-${platformTag()}.zip`) ?? assets.find((a) => a.name === `qq-agent-bridge-v${v}.zip`);
}

const readJson = (f: string) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

export class Updater extends EventEmitter {
  private release: any = null;
  private timer?: NodeJS.Timeout;
  state: UpdateStatus;

  constructor(private bridge: Bridge) {
    super();
    const type = installType();
    const last = readJson(path.join(UPDATE_DIR, 'last-update.json'));
    const failed = readJson(path.join(UPDATE_DIR, 'failed.json'));
    this.state = {
      current: currentVersion(), installType: type, supervised: process.env.QAB_SUPERVISED === '1',
      phase: 'idle', checkedAt: 0, error: '', latest: '', hasUpdate: false, notes: '', url: '', publishedAt: '', asset: '', assetSize: 0,
      progress: 0, stagedVersion: readJson(path.join(UPDATE_DIR, 'pending.json'))?.version ?? '',
      lastUpdate: last && last.at > Date.now() - 86_400_000 ? last : null, lastFailure: failed?.error ?? '',
      hint: type === 'git' ? '源码安装：在程序目录运行 git pull && npm install 后重启'
        : type === 'npm' ? 'npm 安装：运行 npm install -g qq-agent-bridge@latest 后重启' : '',
    };
  }

  private get cfg() { return this.bridge.config.update; }
  private get proxy() { return this.cfg.proxy || envProxy(); }
  private set(patch: Partial<UpdateStatus>) { Object.assign(this.state, patch); this.emit('status', this.state); }

  start() {
    const loop = async () => {
      if (this.cfg.check) {
        await this.check().catch(() => {});
        if (this.state.hasUpdate && this.cfg.autoInstall && this.state.installType === 'package' && this.state.stagedVersion !== this.state.latest) {
          await this.install().catch(() => {});
        }
      }
      this.timer = setTimeout(loop, this.cfg.checkIntervalHours * 3_600_000);
    };
    this.timer = setTimeout(loop, 60_000); // 启动 1 分钟后第一次检查，不拖慢启动
  }
  stop() { clearTimeout(this.timer); }

  async check() {
    if (this.state.phase === 'downloading' || this.state.phase === 'preparing') return this.state;
    this.set({ phase: 'checking', error: '' });
    try {
      const api = `https://api.github.com/repos/${this.cfg.repo}`;
      const rel = this.cfg.prerelease
        ? (await getJson<any[]>(`${api}/releases?per_page=10`, { proxy: this.proxy })).find((r) => !r.draft)
        : await getJson(`${api}/releases/latest`, { proxy: this.proxy });
      if (!rel) throw new Error('还没有发布任何版本');
      this.release = rel;
      const latest = String(rel.tag_name).replace(/^v/, '');
      const asset = pickAsset(rel.assets ?? [], rel.tag_name);
      const hasUpdate = compareVersions(latest, this.state.current) > 0;
      const wasKnown = this.state.latest === latest;
      this.set({ phase: this.state.stagedVersion ? 'staged' : 'idle', checkedAt: Date.now(), latest, hasUpdate, notes: String(rel.body ?? '').slice(0, 4000),
        url: rel.html_url, publishedAt: rel.published_at, asset: asset?.name ?? '', assetSize: asset?.size ?? 0 });
      if (hasUpdate && !wasKnown) {
        this.bridge.activity({ kind: 'info', actor: '更新', title: `发现新版本 v${latest}`, detail: `当前 v${this.state.current}。${this.state.installType === 'package' ? '可在控制台「设置」一键更新' : this.state.hint}` });
        if (this.cfg.notifyOwner) {
          for (const o of this.bridge.config.owners) {
            await this.bridge.send({ kind: 'plugin', name: 'updater' } as any, `private:${o}`, `QQ-Agent Bridge 有新版本 v${latest}（当前 v${this.state.current}）\n${rel.html_url}`).catch(() => {});
          }
        }
      }
    } catch (e: any) {
      const msg = /HTTP 404/.test(e.message) ? `仓库 ${this.cfg.repo} 还没有发布版本` : e.message;
      this.set({ phase: 'error', error: msg, checkedAt: Date.now() });
      throw new Error(msg);
    }
    return this.state;
  }

  /** 下载并预备新版本；返回后需要重启才生效（由 start.bat 启动时会自动重启） */
  async install() {
    if (this.state.installType !== 'package') throw new Error(this.state.hint);
    if (this.state.phase === 'downloading' || this.state.phase === 'preparing') throw new Error('正在更新中');
    if (!this.release || !this.state.hasUpdate) await this.check();
    if (!this.state.hasUpdate) throw new Error('已经是最新版本');
    const rel = this.release;
    const asset = pickAsset(rel.assets ?? [], rel.tag_name);
    if (!asset) throw new Error(`v${this.state.latest} 没有可用的安装包（需要 qq-agent-bridge-v${this.state.latest}.zip）`);
    const version = this.state.latest;
    try {
      fs.mkdirSync(UPDATE_DIR, { recursive: true });
      // 1. 下载（可选镜像加速）并校验
      this.set({ phase: 'downloading', progress: 0, error: '' });
      const zip = path.join(UPDATE_DIR, asset.name);
      const url = this.cfg.mirror ? this.cfg.mirror.replace(/\/?$/, '/') + asset.browser_download_url : asset.browser_download_url;
      let last = 0;
      const sha = await download(url, zip, { proxy: this.cfg.mirror ? '' : this.proxy, onProgress: (got, total) => {
        const p = total ? Math.floor((got / total) * 100) : 0;
        if (p !== last) { last = p; this.set({ progress: p }); }
      } });
      const expect = String(asset.digest ?? '').replace(/^sha256:/, '');
      if (expect && expect !== sha) throw new Error('安装包校验失败（sha256 不一致），已放弃');

      // 2. 解压到预备目录
      this.set({ phase: 'preparing' });
      const staging = path.join(UPDATE_DIR, 'staging');
      fs.rmSync(staging, { recursive: true, force: true });
      fs.mkdirSync(staging, { recursive: true });
      extractZip(zip, staging);
      fs.rmSync(zip, { force: true });
      const top = fs.readdirSync(staging);
      const dir = top.length === 1 ? path.join(staging, top[0]) : staging;
      const pkg = readJson(path.join(dir, 'package.json'));
      if (pkg?.name !== 'qq-agent-bridge' || !fs.existsSync(path.join(dir, 'bin', 'qab.mjs'))) throw new Error('安装包内容不正确');
      if (pkg.version !== version) throw new Error(`安装包版本 ${pkg.version} 与发布版本 ${version} 不符`);

      // 3. 通用包没有依赖：依赖有变化时先在预备目录装好（不影响正在运行的程序）
      if (!fs.existsSync(path.join(dir, 'node_modules'))) {
        const same = fileEq(path.join(dir, 'package-lock.json'), path.join(ROOT, 'package-lock.json'));
        if (!same) await npmCi(dir);
      }
      fs.writeFileSync(path.join(UPDATE_DIR, 'pending.json'), JSON.stringify({ version, from: this.state.current, dir, at: Date.now() }, null, 1));
      fs.rmSync(path.join(UPDATE_DIR, 'failed.json'), { force: true });
      this.set({ phase: 'staged', stagedVersion: version, progress: 100, lastFailure: '' });
      this.bridge.activity({ kind: 'info', actor: '更新', title: `v${version} 已下载，${this.state.supervised ? '即将重启完成更新' : '重启后生效'}`, detail: '' });
      if (this.state.supervised) setTimeout(() => this.emit('restart'), 3000);
    } catch (e: any) {
      this.set({ phase: 'error', error: e.message });
      throw e;
    }
    return this.state;
  }

  /** 取消已预备的更新 */
  cancel() {
    fs.rmSync(path.join(UPDATE_DIR, 'pending.json'), { force: true });
    fs.rmSync(path.join(UPDATE_DIR, 'staging'), { recursive: true, force: true });
    this.set({ phase: 'idle', stagedVersion: '' });
  }
}

function fileEq(a: string, b: string) {
  try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; }
}

/** 解压 zip：Windows 10+/macOS 自带 bsdtar；Linux 用 unzip / bsdtar / python 兜底 */
export function extractZip(zip: string, dest: string) {
  const tries: [string, string[]][] = process.platform === 'win32'
    ? [[path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dest]]]
    : [['bsdtar', ['-xf', zip, '-C', dest]], ['unzip', ['-q', '-o', zip, '-d', dest]], ['python3', ['-m', 'zipfile', '-e', zip, dest]], ['tar', ['-xf', zip, '-C', dest]]];
  let lastErr: any;
  for (const [cmd, args] of tries) {
    try { execFileSync(cmd, args, { stdio: 'ignore' }); return; } catch (e) { lastErr = e; }
  }
  throw new Error(`解压失败（需要 tar/unzip）：${lastErr?.message ?? ''}`);
}

function npmCi(dir: string) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: dir, shell: process.platform === 'win32', stdio: 'ignore' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`安装依赖失败（npm ci 退出码 ${code}）`))));
    p.on('error', (e) => reject(new Error(`安装依赖失败：${e.message}`)));
  });
}
