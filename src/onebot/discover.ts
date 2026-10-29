import fs from 'node:fs';
import path from 'node:path';

export interface SnowLumaAccount {
  uin: string;
  file: string;
  http?: { host: string; port: number; token: string };
  ws?: { host: string; port: number; token: string };
}

/** 读取 SnowLuma 的 per-account OneBot 配置（HTTP 与 WS 的 token 可能不同）。 */
export function readSnowLumaAccounts(home: string): SnowLumaAccount[] {
  if (!home) return [];
  const dir = path.join(home, 'config');
  let files: string[] = [];
  try { files = fs.readdirSync(dir); } catch { return []; }
  const out: SnowLumaAccount[] = [];
  for (const f of files) {
    const m = /^onebot_(\d+)\.json$/i.exec(f);
    if (!m) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const nets = j?.networks ?? {};
      const h = nets.httpServers?.[0];
      const w = nets.wsServers?.[0];
      const host = (x: any) => (!x?.host || x.host === '0.0.0.0' ? '127.0.0.1' : String(x.host));
      out.push({
        uin: m[1],
        file: path.join(dir, f),
        http: h ? { host: host(h), port: Number(h.port) || 3000, token: String(h.accessToken ?? '') } : undefined,
        ws: w ? { host: host(w), port: Number(w.port) || 3001, token: String(w.accessToken ?? '') } : undefined,
      });
    } catch { /* 单个文件损坏不影响其它账号 */ }
  }
  return out;
}

export async function probeHttp(baseUrl: string, token: string, timeoutMs = 5000) {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/get_login_info`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body: any = await res.json().catch(() => ({}));
    if (res.ok && body.retcode === 0) return { ok: true as const, data: body.data as { user_id: number; nickname: string } };
    return { ok: false as const, error: `HTTP ${res.status} retcode=${body.retcode ?? '?'} ${body.wording ?? body.message ?? ''}`.trim() };
  } catch (e: any) {
    return { ok: false as const, error: e?.cause?.code || e?.message || String(e) };
  }
}

export interface DiscoverResult {
  ok: boolean;
  wsUrl?: string;
  httpUrl?: string;
  wsToken?: string;
  httpToken?: string;
  self?: { user_id: number; nickname: string };
  accounts: SnowLumaAccount[];
  tried: { source: string; url: string; error?: string }[];
}

/**
 * 不猜 token：逐个候选真去问 get_login_info，谁能通就用谁。
 * 候选顺序：显式配置 → SnowLuma 各账号配置文件。
 */
export async function discover(opts: { httpUrl: string; wsUrl: string; httpToken?: string; wsToken?: string; snowlumaHome?: string }): Promise<DiscoverResult> {
  const accounts = readSnowLumaAccounts(opts.snowlumaHome ?? '');
  const tried: DiscoverResult['tried'] = [];
  const candidates: { source: string; httpUrl: string; httpToken: string; wsUrl: string; wsToken: string }[] = [];
  candidates.push({ source: 'config', httpUrl: opts.httpUrl, httpToken: opts.httpToken || opts.wsToken || '', wsUrl: opts.wsUrl, wsToken: opts.wsToken || opts.httpToken || '' });
  for (const a of accounts) {
    if (!a.http) continue;
    candidates.push({
      source: `snowluma:${a.uin}`,
      httpUrl: `http://${a.http.host}:${a.http.port}`,
      httpToken: a.http.token,
      wsUrl: a.ws ? `ws://${a.ws.host}:${a.ws.port}` : opts.wsUrl,
      wsToken: a.ws?.token ?? a.http.token,
    });
  }
  for (const c of candidates) {
    const r = await probeHttp(c.httpUrl, c.httpToken);
    tried.push({ source: c.source, url: c.httpUrl, error: r.ok ? undefined : r.error });
    if (r.ok) return { ok: true, wsUrl: c.wsUrl, httpUrl: c.httpUrl, wsToken: c.wsToken, httpToken: c.httpToken, self: r.data, accounts, tried };
  }
  // HTTP 全不通时，仍返回第一个账号的 WS 参数，交给 WS 客户端去重连
  const a = accounts.find((x) => x.ws);
  return {
    ok: false, accounts, tried,
    wsUrl: a?.ws ? `ws://${a.ws.host}:${a.ws.port}` : opts.wsUrl,
    wsToken: a?.ws?.token ?? opts.wsToken,
    httpUrl: a?.http ? `http://${a.http.host}:${a.http.port}` : opts.httpUrl,
    httpToken: a?.http?.token ?? opts.httpToken,
  };
}
