import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import YAML from 'yaml';
import { createLogger } from '../../util/log.ts';

const log = createLogger('dsh');

/**
 * DeepSeek Harness (DSH) Web API 客户端（协议对齐 DSH 0.2.x，参考 qq-bridge 的实测结论）：
 * - RPC：POST /api/<ns>/<method>，信封 {type:'client-request', rpcId, method, payload:{args}}
 * - 鉴权：用 ~/.dsh/.credentials.yaml 中的 browser-session 密钥离线签发 Cookie（不依赖进程启动 token）；
 *   或用显式配置的 launch token 交换 Cookie（仅回环地址）
 * - 事件：/api/remote.mux WebSocket；每个会话一条 session/follow 流，审批/提问走 $events 流
 *
 * 事件：'event'(sessionId, event) 'approval'(req) 'question'(req) 'connected' 'disconnected'
 */
export interface DshOptions { baseUrl: string; authToken?: string; allowRemote?: boolean; dshHome?: string; timeoutMs?: number }

const WRAP: Record<string, string | null> = {
  'session/list': '_request', 'session/create': 'request', 'session/prompt': 'request', 'session/cancel': 'request',
  'session/selectModel': 'request', 'session/rename': 'request', 'session/updateQueue': 'request', 'session/follow': 'request',
  'session/projections': 'request', 'session/modelCatalog': 'request',
  'workspace/create': 'request', 'workspace/rename': 'request', 'workspace/archiveSession': 'request',
  'agentPresets/list': null, 'settings/describe': null,
};

export function dshHome(override?: string) { return override || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'); }

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function isLoopback(baseUrl: string) {
  try {
    const h = new URL(baseUrl).hostname.toLowerCase();
    return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(h);
  } catch { return false; }
}

/** 读取 DSH 的浏览器会话签名密钥（32 字节）。 */
export function readSessionSecret(home: string): Buffer | null {
  try {
    const doc = YAML.parse(fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8'));
    const rec = doc?.records?.['client-connection/browser-session'];
    if (rec?.kind !== 'grant' || rec?.payload?.version !== 1 || typeof rec.payload.secret !== 'string') return null;
    const buf = Buffer.from(rec.payload.secret.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    return buf.length === 32 ? buf : null;
  } catch { return null; }
}

export function mintCookie(baseUrl: string, secret: Buffer, lifetimeMs = 3600_000): string {
  const authority = new URL(baseUrl).host;
  const issuedAt = Date.now();
  const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt: issuedAt + lifetimeMs }), 'utf8'));
  const sig = b64url(createHmac('sha256', secret).update(body).digest());
  return `dsh-auth-${b64url(createHash('sha256').update(authority).digest())}=v1.${body}.${sig}`;
}

/**
 * 本机 DSH 进程正在监听的端口。DSH 桌面版启动 host 时用 --port 0（随机端口，每次重启都变），
 * 所以静态的 3080 在桌面版上连不上（3080 是 `dsh web` 的默认端口）。
 */
export function localDshPorts(): number[] {
  if (process.platform !== 'win32') return [];
  try {
    const tl = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    const NL = String.fromCharCode(10);
    const pids = new Set(tl.split(NL).filter((l) => /deepseek harness|dsh/i.test(l)).map((l) => l.split('","')[1]?.replace(/"/g, '')).filter(Boolean));
    if (!pids.size) return [];
    const ns = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    const ports = new Set<number>();
    for (const l of ns.split(NL)) {
      const m = /^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(l);
      if (m && pids.has(m[2])) ports.add(Number(m[1]));
    }
    return [...ports];
  } catch { return []; }
}

/** 找出能用本机凭据通过只读探测的 DSH 地址；找不到返回空串。 */
export async function discoverDshBaseUrl(opts: Omit<DshOptions, 'baseUrl'>, prefer?: string): Promise<string> {
  const cands = [...new Set([...(prefer ? [prefer] : []), ...localDshPorts().map((p) => `http://127.0.0.1:${p}`), 'http://127.0.0.1:3080'])];
  for (const baseUrl of cands) {
    const c = new DshClient({ ...opts, baseUrl, timeoutMs: 4000 });
    if (await c.ping()) return baseUrl;
  }
  return '';
}

export class DshError extends Error { constructor(public code: string, message: string) { super(message); } }

export class DshClient extends EventEmitter {
  baseUrl: string;
  private cookie = '';
  private cookieExpires = 0;
  private ws?: WebSocket;
  private follows = new Set<string>();
  private streamOf = new Map<string, string>();     // sessionId -> streamId
  private sessionOf = new Map<string, string>();    // streamId -> sessionId
  private eventsStream = '';
  eventsClientId = '';
  connected = false;
  private stopped = true;
  private retry = 0;
  private timer?: NodeJS.Timeout;

  constructor(public opts: DshOptions) {
    super();
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
  }

  // ------------------------------------------------------------------ 鉴权
  private async auth(): Promise<string> {
    if (this.cookie && Date.now() < this.cookieExpires - 300_000) return this.cookie;
    const secret = readSessionSecret(dshHome(this.opts.dshHome));
    if (secret && isLoopback(this.baseUrl) && !this.opts.authToken) {
      this.cookie = mintCookie(this.baseUrl, secret);
      this.cookieExpires = Date.now() + 3600_000;
      return this.cookie;
    }
    if (!this.opts.authToken) {
      if (secret && isLoopback(this.baseUrl)) { this.cookie = mintCookie(this.baseUrl, secret); this.cookieExpires = Date.now() + 3600_000; return this.cookie; }
      throw new DshError('auth', `DSH 鉴权不可用：读不到 ${path.join(dshHome(this.opts.dshHome), '.credentials.yaml')} 中的会话密钥，也没有配置 authToken`);
    }
    if (!this.opts.allowRemote && !isLoopback(this.baseUrl)) throw new DshError('auth', '拒绝把 DSH 启动 token 发往非本机地址（需开启 allowRemote）');
    const u = new URL(this.baseUrl); u.pathname = '/'; u.search = ''; u.searchParams.set('token', this.opts.authToken);
    const res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    const sc = res.headers.get('set-cookie');
    await res.body?.cancel();
    if (!sc) throw new DshError('auth', `DSH token 交换失败：HTTP ${res.status}`);
    this.cookie = sc.split(';')[0];
    this.cookieExpires = Date.now() + 24 * 3600_000;
    return this.cookie;
  }

  // ------------------------------------------------------------------ RPC
  async call<T = any>(method: string, payload: any = {}, timeoutMs = this.opts.timeoutMs ?? 30_000): Promise<T> {
    const endpoint = method.replace(/\./g, '/');
    let body = payload;
    if (endpoint === 'session/prompt' && typeof body?.requestId !== 'string') body = { ...body, requestId: randomUUID() };
    const w = WRAP[endpoint];
    const args = w === null ? {} : w === undefined ? body : { [w]: body };
    const msg = { type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args } };
    for (let attempt = 0; attempt < 2; attempt++) {
      const cookie = await this.auth();
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}/api/${endpoint}`, {
          method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(msg), signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e: any) { throw new DshError('unreachable', `DSH 不可达（${this.baseUrl}）：${e?.cause?.code || e?.message}`); }
      if (res.status === 401 && attempt === 0) { this.cookie = ''; continue; }
      const full: any = await res.json().catch(() => null);
      if (!full || full.type !== 'server-response' || !full.result) throw new DshError('protocol', `${endpoint} 返回无效（HTTP ${res.status}）`);
      if (full.result.ok) return full.result.value as T;
      throw new DshError(full.result.error?.code ?? 'error', `${endpoint} 失败：${full.result.error?.code ?? ''} ${full.result.error?.message ?? ''}`.trim());
    }
    throw new DshError('auth', 'DSH 鉴权失败（401）');
  }

  async ping(): Promise<boolean> {
    try { await this.call('agentPresets/list', {}, 5000); return true; } catch { return false; }
  }

  // ------------------------------------------------------------------ 事件流
  start() { if (!this.stopped && (this.ws || this.timer)) return; this.stopped = false; void this.connect(); }
  stop() { this.stopped = true; clearTimeout(this.timer); this.timer = undefined; this.ws?.close(); this.ws = undefined; }

  follow(sessionId: string) {
    this.follows.add(sessionId);
    this.openFollow(sessionId);
  }
  unfollow(sessionId: string) { this.follows.delete(sessionId); }

  private async connect() {
    if (this.stopped) return;
    let cookie: string;
    try { cookie = await this.auth(); } catch (e: any) { this.scheduleReconnect(e.message); return; }
    const u = new URL('/api/remote.mux', this.baseUrl);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(u, { headers: { cookie } });
    this.ws = ws;
    ws.on('open', () => {
      this.connected = true; this.retry = 0;
      this.streamOf.clear(); this.sessionOf.clear(); this.eventsStream = ''; this.eventsClientId = '';
      log.info(`已连接 DSH 事件流 ${this.baseUrl}`);
      for (const s of this.follows) this.openFollow(s);
      this.eventsStream = randomUUID();
      ws.send(JSON.stringify({ type: 'open', streamId: this.eventsStream, endpoint: '$events', payload: { args: {} } }));
      this.emit('connected');
    });
    ws.on('message', (d) => this.onFrame(d.toString()));
    ws.on('unexpected-response', (_q, r) => { if (r.statusCode === 401) this.cookie = ''; });
    ws.on('error', () => { /* close 中处理 */ });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      const was = this.connected;
      this.connected = false;
      this.cookie = '';
      if (was) this.emit('disconnected');
      this.scheduleReconnect('连接关闭');
    });
  }

  private scheduleReconnect(why: string) {
    if (this.stopped) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.retry++, 5));
    if (this.retry <= 1 || this.retry % 5 === 0) log.warn(`DSH 事件流不可用（${why}），${Math.round(delay / 1000)}s 后重连`);
    this.timer = setTimeout(() => { this.timer = undefined; void this.connect(); }, delay);
  }

  private openFollow(sessionId: string) {
    if (!this.ws || !this.connected || this.streamOf.has(sessionId)) return;
    const streamId = randomUUID();
    this.streamOf.set(sessionId, streamId);
    this.sessionOf.set(streamId, sessionId);
    // maxMessages 只影响开场快照大小；快照单独作为 'snapshot' 抛出，绝不当作实时事件
    this.ws.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId }, maxMessages: 50 } } } }));
  }

  private onFrame(text: string) {
    let m: any;
    try { m = JSON.parse(text); } catch { return; }
    if (typeof m?.streamId !== 'string') return;
    if (m.streamId === this.eventsStream) {
      if (m.type === 'item') {
        const v = m.value ?? {};
        if (v.type === 'ready') this.eventsClientId = v.clientId;
        else if (v.type === 'waterfall' && v.event === 'approval/request') {
          this.emit('approval', { eventId: v.eventId, sessionId: v.agentId, toolName: v.request?.toolName, callId: v.request?.callId, reason: v.request?.reason });
        } else if (v.type === 'waterfall' && v.event === 'user-questions/request') {
          this.emit('question', { eventId: v.eventId, sessionId: v.agentId, questions: v.request?.questions ?? [] });
        }
      } else if (m.type === 'end' || m.type === 'error') { this.ws?.close(); }
      return;
    }
    const sid = this.sessionOf.get(m.streamId);
    if (!sid) return;
    if (m.type === 'item' && m.value?.type === 'event') this.emit('event', sid, m.value.event);
    else if (m.type === 'item' && m.value?.type === 'snapshot') this.emit('snapshot', sid, m.value);
    else if (m.type === 'end' || m.type === 'error') {
      this.streamOf.delete(sid); this.sessionOf.delete(m.streamId);
      if (m.error?.code === 'session/not-found') { this.follows.delete(sid); this.emit('session-gone', sid); return; }
      // 服务端结束了单条 follow：仍需要的会话 2 秒后重订，避免静默失联
      if (this.follows.has(sid)) setTimeout(() => this.openFollow(sid), 2000);
    }
  }

  /** 回复审批/提问。approval: value='allowed-once'|'rejected'；question: value={answers:[...]} */
  async respond(eventId: string, value: unknown) {
    if (!this.eventsClientId) throw new DshError('events', 'DSH 事件通道未就绪');
    return this.call('$events/result', { clientId: this.eventsClientId, eventId, outcome: { kind: 'result', value } });
  }
}
