/**
 * 插件包：一个 zip，内含 plugin.json 和入口文件（打包好的 JS，或 TS）。
 *
 * 安装分两步：先解压到暂存区并检查（名称、版本、API 版本、权限），把结果给用户看；
 * 用户确认后再放进 plugins/<名称>。已安装的同名插件先备份，插件数据（data/plugins/<名称>）不受影响。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { API_VERSION } from '../sdk.ts';
import { extractZip } from '../update/index.ts';
import { download, envProxy } from '../update/net.ts';

export interface PackageManifest {
  name: string;
  displayName?: string;
  version?: string;
  description?: string;
  author?: string;
  apiVersion?: number;
  permissions?: string[];
  main?: string;
}
export interface Inspected {
  id: string;
  manifest: PackageManifest;
  /** 已安装的同名插件版本（没有为 null） */
  installed: string | null;
  /** 不能安装的原因（能装为空） */
  problems: string[];
  /** 提醒但不阻止 */
  warnings: string[];
}

const NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;
const ENTRIES = ['index.js', 'index.mjs', 'index.ts', 'index.mts'];
const KNOWN_PERMS = ['send', 'onebot', 'history', 'memory', 'agent-tools', 'http'];
const MAX_BYTES = 20 * 1024 * 1024;

export class PluginPackages {
  constructor(private dataDir: string, private pluginsDir: () => string, private installedVersion: (name: string) => string | null | undefined) {}

  private staging(id = '') { return path.join(this.dataDir, '.plugin-staging', id); }

  /** 检查上传的 zip */
  inspectBuffer(buf: Buffer): Inspected {
    if (buf.length > MAX_BYTES) throw new Error(`插件包太大（${Math.round(buf.length / 1048576)} MB，上限 20 MB）`);
    if (buf.subarray(0, 2).toString('latin1') !== 'PK') throw new Error('不是 zip 文件');
    this.cleanup();
    const id = crypto.randomBytes(8).toString('hex');
    const dir = this.staging(id);
    fs.mkdirSync(dir, { recursive: true });
    const zip = path.join(this.staging(), `${id}.zip`);
    fs.writeFileSync(zip, buf);
    try { extractZip(zip, dir); } finally { fs.rmSync(zip, { force: true }); }
    return this.inspectDir(id);
  }

  /** 下载并检查（只接受 https） */
  async inspectUrl(url: string): Promise<Inspected> {
    if (!/^https:\/\/[^\s]+$/i.test(url)) throw new Error('只支持 https:// 开头的地址');
    fs.mkdirSync(this.staging(), { recursive: true });
    const tmp = path.join(this.staging(), `dl-${crypto.randomBytes(6).toString('hex')}.zip`);
    try {
      await download(url, tmp, { proxy: envProxy(), timeoutMs: 60_000 });
      return this.inspectBuffer(fs.readFileSync(tmp));
    } finally { fs.rmSync(tmp, { force: true }); }
  }

  /** 解压后的目录可能多套了一层文件夹；找到 plugin.json 所在的那层 */
  private rootOf(id: string) {
    const dir = this.staging(id);
    if (fs.existsSync(path.join(dir, 'plugin.json'))) return dir;
    const subs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('__MACOSX'));
    if (subs.length === 1 && fs.existsSync(path.join(dir, subs[0].name, 'plugin.json'))) return path.join(dir, subs[0].name);
    throw new Error('插件包里没有 plugin.json（插件包必须带 plugin.json，写明 name、version、apiVersion、permissions）');
  }

  private inspectDir(id: string): Inspected {
    const root = this.rootOf(id);
    let m: PackageManifest;
    try { m = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8')); } catch (e: any) { throw new Error(`plugin.json 格式不对：${e.message}`); }
    const problems: string[] = [];
    const warnings: string[] = [];
    if (!m || typeof m !== 'object') throw new Error('plugin.json 格式不对');
    if (!NAME_RE.test(String(m.name ?? ''))) problems.push('name 只能是小写字母、数字和短横线，以字母开头（2～41 个字符）');
    if (m.apiVersion == null) problems.push(`缺少 apiVersion（当前 QAB 支持 ${API_VERSION}）`);
    else if (Number(m.apiVersion) !== API_VERSION) problems.push(`插件按插件 API v${m.apiVersion} 编写，当前 QAB 支持 v${API_VERSION}`);
    if (!Array.isArray(m.permissions)) problems.push('缺少 permissions（需要的权限列表，不需要任何权限就写 []）');
    else for (const p of m.permissions) if (!KNOWN_PERMS.includes(p)) warnings.push(`未知权限「${p}」，会被忽略`);
    const main = m.main ?? ENTRIES.find((f) => fs.existsSync(path.join(root, f)));
    if (!main) problems.push('找不到入口文件（index.js / index.ts，或在 plugin.json 的 main 里写明）');
    else if (path.isAbsolute(main) || path.normalize(main).startsWith('..') || !fs.existsSync(path.join(root, main))) problems.push(`入口文件 ${main} 不存在`);
    if (fs.existsSync(path.join(root, 'package.json')) && !fs.existsSync(path.join(root, 'node_modules'))) {
      const deps = Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies ?? {});
      if (deps.length) warnings.push(`插件声明了依赖（${deps.join('、')}）但包里没有 node_modules。插件包应该把依赖打包进去，否则可能加载失败`);
    }
    return { id, manifest: m, installed: NAME_RE.test(String(m.name)) ? this.installedVersion(m.name) ?? null : null, problems, warnings };
  }

  /** 确认安装：放进 plugins/<名称>；同名旧版先备份 */
  install(id: string): { name: string; dir: string; backup?: string } {
    if (!/^[0-9a-f]{16}$/.test(id) || !fs.existsSync(this.staging(id))) throw new Error('安装包已过期，请重新上传');
    const info = this.inspectDir(id);
    if (info.problems.length) throw new Error(info.problems.join('；'));
    const name = info.manifest.name;
    const base = this.pluginsDir();
    fs.mkdirSync(base, { recursive: true });
    const dest = path.join(base, name);
    let backup: string | undefined;
    if (fs.existsSync(dest)) {
      backup = path.join(this.dataDir, '.plugin-backup', `${name}-${Date.now()}`);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      move(dest, backup);
    }
    move(this.rootOf(id), dest);
    fs.rmSync(this.staging(id), { recursive: true, force: true });
    return { name, dir: dest, backup };
  }

  /** 卸载：删掉插件代码；keepData=false 时连同 data/plugins/<名称> 一起删 */
  uninstall(name: string, entry: string | undefined, keepData: boolean) {
    if (!NAME_RE.test(name) && !/^[\w.-]+$/.test(name)) throw new Error('插件名不对');
    const base = path.resolve(this.pluginsDir());
    const dir = path.join(base, name);
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) fs.rmSync(dir, { recursive: true, force: true });
    else if (entry && path.dirname(path.resolve(entry)) === base) fs.rmSync(entry, { force: true }); // 单文件插件
    else throw new Error(`没有在 ${base} 里找到插件「${name}」，随程序发布的插件不能卸载`);
    if (!keepData) fs.rmSync(path.join(this.dataDir, 'plugins', name), { recursive: true, force: true });
  }

  /** 暂存区里超过 1 小时的东西清掉 */
  cleanup() {
    const dir = this.staging();
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir)) {
      const p = path.join(dir, e);
      try { if (Date.now() - fs.statSync(p).mtimeMs > 3_600_000) fs.rmSync(p, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
  }
}

/** 移动目录；数据目录和插件目录不在同一个盘时 rename 会失败，改成复制再删除 */
function move(from: string, to: string) {
  try { fs.renameSync(from, to); } catch (e: any) {
    if (e?.code !== 'EXDEV') throw e;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

/** 把插件目录打成 zip（qab plugin pack）。需要 plugin.json。 */
export function packPlugin(dir: string, out?: string): string {
  const src = path.resolve(dir);
  const mf = path.join(src, 'plugin.json');
  if (!fs.existsSync(mf)) throw new Error(`${src} 里没有 plugin.json`);
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  const file = path.resolve(out ?? `${m.name ?? path.basename(src)}-${m.version ?? '0.0.0'}.zip`);
  fs.rmSync(file, { force: true });
  const tries: [string, string[]][] = process.platform === 'win32'
    ? [[path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-cf', file, '-C', src, '.']]]
    : [['bsdtar', ['--format', 'zip', '-cf', file, '-C', src, '.']], ['zip', ['-qr', file, '.']]];
  let last: any;
  for (const [cmd, args] of tries) {
    try { execFileSync(cmd, args, { cwd: src, stdio: 'ignore' }); return file; } catch (e) { last = e; }
  }
  throw new Error(`打包失败（需要 tar 或 zip）：${last?.message ?? ''}`);
}
