import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { createLogger } from '../util/log.ts';

const log = createLogger('onebot');

export class OneBotError extends Error {
  constructor(public action: string, public retcode: number, message: string, public data?: unknown) {
    super(`${action} 失败 (retcode=${retcode}): ${message}`);
  }
}

export interface OneBotEndpoints {
  wsUrl: string;
  wsToken: string;
  httpUrl: string;
  httpToken: string;
}

export type ConnState = 'idle' | 'connecting' | 'open' | 'closed';

interface Pending { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; action: string }

/**
 * OneBot v11 客户端：WS Universal 为主通道（事件 + echo 动作），WS 不可用时动作降级走 HTTP。
 * 事件：'event' (raw)、'state' (ConnState)、'lifecycle'
 */
export class OneBotClient extends EventEmitter {
  state: ConnState = 'idle';
  lastEventAt = 0;
  connectedAt = 0;
  lastError = '';
  private ws?: WebSocket;
  private pending = new Map<string, Pending>();
  private seq = 0;
  private retry = 0;
  private stopped = false;
  private reconnectTimer?: NodeJS.Timeout;

  constructor(public ep: OneBotEndpoints, private opts: { timeoutMs: number; reconnectMaxMs: number }) {
    super();
    this.setMaxListeners(50);
  }

  setEndpoints(ep: OneBotEndpoints) {
    const changed = ep.wsUrl !== this.ep.wsUrl || ep.wsToken !== this.ep.wsToken;
    this.ep = ep;
    if (changed && !this.stopped) { this.ws?.terminate(); }
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('客户端已停止')); }
    this.pending.clear();
  }

  private setState(s: ConnState) {
    if (this.state === s) return;
    this.state = s;
    this.emit('state', s);
  }

  private connect() {
    if (this.stopped) return;
    this.setState('connecting');
    const headers: Record<string, string> = {};
    if (this.ep.wsToken) headers.authorization = `Bearer ${this.ep.wsToken}`;
    const ws = new WebSocket(this.ep.wsUrl, { headers, handshakeTimeout: 8000 });
    this.ws = ws;
    ws.on('open', () => {
      this.retry = 0;
      this.connectedAt = Date.now();
      this.lastError = '';
      log.info(`已连接 ${this.ep.wsUrl}`);
      this.setState('open');
    });
    ws.on('message', (buf) => this.onMessage(buf.toString()));
    ws.on('unexpected-response', (_req, res) => {
      this.lastError = `握手被拒绝 HTTP ${res.statusCode}${res.statusCode === 401 || res.statusCode === 403 ? '（token 错误？）' : ''}`;
    });
    ws.on('error', (e: any) => { this.lastError = e?.code || e?.message || String(e); });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.setState('closed');
      for (const [echo, p] of this.pending) {
        // WS 断开时，未完成动作改走 HTTP 重试一次
        clearTimeout(p.timer);
        this.pending.delete(echo);
        p.reject(Object.assign(new Error('WS 连接断开'), { retryHttp: true }));
      }
      if (this.stopped) return;
      const delay = Math.min(this.opts.reconnectMaxMs, 1000 * 2 ** Math.min(this.retry++, 5));
      log.warn(`连接断开${this.lastError ? `（${this.lastError}）` : ''}，${Math.round(delay / 1000)}s 后重连`);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });
  }

  private onMessage(text: string) {
    let data: any;
    try { data = JSON.parse(text); } catch { return; }
    if (data && data.echo !== undefined && this.pending.has(String(data.echo))) {
      const p = this.pending.get(String(data.echo))!;
      this.pending.delete(String(data.echo));
      clearTimeout(p.timer);
      if (data.status === 'failed' || (typeof data.retcode === 'number' && data.retcode !== 0 && data.retcode !== 1)) {
        p.reject(new OneBotError(p.action, data.retcode, data.wording || data.message || data.msg || '未知错误', data.data));
      } else p.resolve(data.data);
      return;
    }
    if (data && data.post_type) {
      this.lastEventAt = Date.now();
      this.emit('event', data);
    }
  }

  /** 调用 OneBot 动作。WS 在线优先走 WS，否则 HTTP。 */
  async call<T = any>(action: string, params: Record<string, unknown> = {}, timeoutMs = this.opts.timeoutMs): Promise<T> {
    if (this.ws && this.state === 'open') {
      try {
        return await this.callWs<T>(action, params, timeoutMs);
      } catch (e: any) {
        if (!e?.retryHttp) throw e;
      }
    }
    return this.callHttp<T>(action, params, timeoutMs);
  }

  private callWs<T>(action: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const echo = `qab-${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new OneBotError(action, -1, `超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(echo, { resolve, reject, timer, action });
      this.ws!.send(JSON.stringify({ action, params, echo }), (err) => {
        if (err) { clearTimeout(timer); this.pending.delete(echo); reject(Object.assign(err, { retryHttp: true })); }
      });
    });
  }

  private async callHttp<T>(action: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    if (!this.ep.httpUrl) throw new OneBotError(action, -1, 'OneBot 未连接（WS 断开且未配置 HTTP）');
    let res: Response;
    try {
      res = await fetch(`${this.ep.httpUrl.replace(/\/+$/, '')}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.ep.httpToken ? { authorization: `Bearer ${this.ep.httpToken}` } : {}) },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e: any) {
      throw new OneBotError(action, -1, `OneBot 不可达：${e?.cause?.code || e?.message || e}`);
    }
    const body: any = await res.json().catch(() => null);
    if (!body) throw new OneBotError(action, res.status, `HTTP ${res.status}`);
    if (body.status === 'failed' || (body.retcode !== 0 && body.retcode !== 1)) {
      throw new OneBotError(action, body.retcode ?? res.status, body.wording || body.message || `HTTP ${res.status}`, body.data);
    }
    return body.data as T;
  }
}
