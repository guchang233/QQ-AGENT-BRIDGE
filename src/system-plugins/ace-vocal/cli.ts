import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** 调用官方 CLI 失败时的分类错误。message 可以直接给 Agent 或 QQ。 */
export class AceError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'LOGIN' | 'UNSUPPORTED' | 'CLI' | 'BAD_SCORE' | 'OUTPUT' | 'RATE', message: string) {
    super(message);
    this.name = 'AceError';
  }
}

export const LOGIN_HINT = 'ACE Studio 还没登录。请打开软件，用你自己的账号登录后再试。插件不会代你登录，也不会读取登录令牌。';
export const OPEN_HINT = '连不上 ACE Studio。请先打开软件并登录，再在偏好设置 → 通用 → 外部代理确认 acestudio-cli 可用。';

export interface RunResult { code: number; stdout: string; stderr: string }
export interface Runner {
  (args: string[], opts?: { stdin?: string; timeoutMs?: number }): Promise<RunResult>;
}

const CLI_NAME = 'acestudio-cli';

export function defaultCliCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') {
    const pf = env.ProgramFiles || 'C:\\Program Files';
    const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    return [path.join(pf, 'ACE Studio', `${CLI_NAME}.exe`), path.join(pf86, 'ACE Studio', `${CLI_NAME}.exe`)];
  }
  if (platform === 'darwin') return ['/Applications/ACE Studio.app/Contents/Helpers/acestudio-cli'];
  return [];
}

/** 只接受配置路径，或文件名恰好是 acestudio-cli 的安装位置。Agent 不能改这个路径。 */
export function resolveCliPath(configured: string, deps?: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; exists?: (p: string) => boolean }): string {
  const platform = deps?.platform ?? process.platform;
  const env = deps?.env ?? process.env;
  const exists = deps?.exists ?? fs.existsSync;
  const cfg = configured.trim();
  if (cfg) {
    if (!exists(cfg) || !fsStatIsFile(cfg, exists)) throw new AceError('NOT_FOUND', `配置的 acestudio-cli 不存在：${cfg}`);
    return cfg;
  }
  for (const c of defaultCliCandidates(platform, env)) if (exists(c)) return c;
  const pathEnv = env.PATH || env.Path || '';
  const exts = platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, CLI_NAME + ext);
      if (exists(p)) return p;
    }
  }
  throw new AceError('NOT_FOUND', '没有找到 acestudio-cli。请安装 ACE Studio，在偏好设置 → 通用 → 外部代理复制 CLI 路径，填到本插件的「CLI 路径」。');
}

function fsStatIsFile(p: string, exists: (p: string) => boolean): boolean {
  if (exists !== fs.existsSync) return exists(p);
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

export function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

export function looksLikePath(arg: string): boolean {
  if (!arg || arg.startsWith('-')) return false;
  if (path.isAbsolute(arg) || arg.includes('/') || arg.includes('\\')) return true;
  return /\.(wav|mp3|flac|mid|midi|json|acep|ufdata|txt)$/i.test(arg);
}

/** 参数里的路径必须落在插件数据目录里，避免 CLI 被指去读写任意文件。 */
export function assertArgPath(arg: string, dataDir: string) {
  const check = (value: string) => {
    if (!looksLikePath(value)) return;
    const abs = path.isAbsolute(value) ? value : path.resolve(dataDir, value);
    if (!isInside(dataDir, abs)) throw new AceError('OUTPUT', '路径必须在插件数据目录内');
  };
  if (arg.startsWith('--') && arg.includes('=')) check(arg.slice(arg.indexOf('=') + 1));
  else check(arg);
}

export function explainFailure(text: string): { code: 'LOGIN' | 'CLI'; message: string } | undefined {
  if (/请先登录|尚未登录|没有登录|未登录|需要登录|please (?:log|sign) in|log(?:in| in) required|sign[- ]in required|not authenticated|authentication required|unauthorized|\b401\b/i.test(text)) {
    return { code: 'LOGIN', message: LOGIN_HINT };
  }
  if (/not running|未运行|没有运行|请先打开|connection refused|econnrefused|无法连接/i.test(text)) {
    return { code: 'CLI', message: OPEN_HINT };
  }
  return undefined;
}

export function spawnCli(bin: string, args: string[], opts: { stdin?: string; timeoutMs: number }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { reject(e); return; }
    const cap = 1_000_000;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let settled = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
    child.stdout?.on('data', (d: Buffer) => { outLen += d.length; if (outLen <= cap) out.push(d); });
    child.stderr?.on('data', (d: Buffer) => { errLen += d.length; if (errLen <= cap) err.push(d); });
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new AceError('CLI', `acestudio-cli 超过 ${Math.round(opts.timeoutMs / 1000)} 秒还没有返回：${args.join(' ')}`)));
    }, opts.timeoutMs);
    child.on('error', (e: NodeJS.ErrnoException) => finish(() => {
      if (e.code === 'ENOENT') reject(new AceError('NOT_FOUND', '找不到 acestudio-cli。请安装 ACE Studio，或在插件配置里填写 CLI 路径。'));
      else reject(new AceError('CLI', e.message));
    }));
    child.on('close', (code) => finish(() => resolve({
      code: code ?? 1,
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(err).toString('utf8'),
    })));
    if (opts.stdin) child.stdin?.write(opts.stdin);
    child.stdin?.end();
  });
}
