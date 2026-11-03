/**
 * 首次设置向导的后端（设好密码、登录之后才能调用）。
 *
 * 向导顺序：设置密码 → 连接 SnowLuma → 接入 AI → 管理员与回复范围 → 试一试。
 * 密码放第一步：后面几步会读写 token、装 DSH 预设，必须先确认是机器的主人在操作。
 * token 只在后端用，不发给浏览器。
 */
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import type { Bridge } from '../bridge.ts';
import { guessSnowLumaHome, hasOneBotConfig, runningProcessPaths } from '../config.ts';
import { readSnowLumaAccounts, probeHttp, type SnowLumaAccount } from '../onebot/discover.ts';

/** WS 握手试一下：能连上、token 对不对 */
export function probeWs(url: string, token: string, timeoutMs = 4000): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: { ok: boolean; error?: string }) => { if (done) return; done = true; clearTimeout(t); try { ws.terminate(); } catch { /* 已关闭 */ } resolve(r); };
    const ws = new WebSocket(url, { headers: token ? { authorization: `Bearer ${token}` } : {}, handshakeTimeout: timeoutMs });
    const t = setTimeout(() => finish({ ok: false, error: '超时' }), timeoutMs + 500);
    ws.on('open', () => finish({ ok: true }));
    ws.on('unexpected-response', (_req, res) => finish({ ok: false, error: res.statusCode === 401 || res.statusCode === 403 ? 'token 不对' : `HTTP ${res.statusCode}` }));
    ws.on('error', (e: any) => finish({ ok: false, error: e?.code === 'ECONNREFUSED' ? '端口没有响应' : e?.message ?? String(e) }));
  });
}

const httpUrlOf = (a: SnowLumaAccount) => a.http && `http://${a.http.host}:${a.http.port}`;
const wsUrlOf = (a: SnowLumaAccount) => a.ws && `ws://${a.ws.host}:${a.ws.port}`;

/** 一个账号的检查结果：配置里有没有开 HTTP / WS 服务，开了的话能不能连上 */
async function checkAccount(a: SnowLumaAccount) {
  const [http, ws] = await Promise.all([
    a.http ? probeHttp(httpUrlOf(a)!, a.http.token, 4000) : Promise.resolve(null),
    a.ws ? probeWs(wsUrlOf(a)!, a.ws.token) : Promise.resolve(null),
  ]);
  return {
    uin: a.uin,
    http: a.http ? { url: httpUrlOf(a), ok: !!http?.ok, error: http && !http.ok ? http.error : undefined } : null,
    ws: a.ws ? { url: wsUrlOf(a), ok: !!ws?.ok, error: ws && !ws.ok ? ws.error : undefined } : null,
    nickname: http?.ok ? http.data.nickname : undefined,
  };
}

export function registerWizard(app: FastifyInstance, bridge: Bridge) {
  const setWizard = (v: 'pending' | 'done') => { const cfg = structuredClone(bridge.config); cfg.ui.wizard = v; bridge.updateConfig(cfg); };

  /** 找 SnowLuma：配置里的目录 → 正在运行的进程 → 常见位置；然后逐个账号检查 */
  app.post('/api/wizard/snowluma', async (req) => {
    const want = String((req.body as any)?.home ?? '').trim();
    let home = want || bridge.config.onebot.snowlumaHome;
    if (!hasOneBotConfig(home) && !want) home = guessSnowLumaHome();
    const valid = hasOneBotConfig(home);
    const running = runningProcessPaths().some((p) => /snowluma/i.test(p));
    const accounts = valid ? await Promise.all(readSnowLumaAccounts(home).map(checkAccount)) : [];
    return { home, valid, running, accounts };
  });

  /** 用某个 SnowLuma 账号：地址和 token 都从它的配置文件里读，用户不用手抄 */
  app.post('/api/wizard/snowluma/use', async (req, reply) => {
    const { home, uin } = (req.body ?? {}) as { home?: string; uin?: string };
    const a = readSnowLumaAccounts(String(home ?? '')).find((x) => x.uin === String(uin));
    if (!a) return reply.code(400).send({ error: '在这个 SnowLuma 目录里找不到这个账号的配置' });
    if (!a.http || !a.ws) return reply.code(400).send({ error: `账号 ${a.uin} 还没开${!a.http && !a.ws ? ' HTTP 和 WebSocket' : !a.http ? ' HTTP' : ' WebSocket'} 服务` });
    const cfg = structuredClone(bridge.config);
    Object.assign(cfg.onebot, { snowlumaHome: String(home), httpUrl: httpUrlOf(a), wsUrl: wsUrlOf(a), accessToken: a.ws.token, httpToken: a.http.token === a.ws.token ? '' : a.http.token, autoDiscover: true });
    // 新装的默认自动连接、断线重连，免得重启后机器人一直离线
    cfg.bot.autoConnect = cfg.bot.autoReconnect = true;
    bridge.updateConfig(cfg);
    return connectAndWait();
  });

  /** 不是 SnowLuma，或者想手动填：其他 OneBot v11 实现 */
  app.post('/api/wizard/onebot/manual', async (req, reply) => {
    const b = (req.body ?? {}) as { wsUrl?: string; httpUrl?: string; accessToken?: string; httpToken?: string };
    if (!b.wsUrl?.trim() || !b.httpUrl?.trim()) return reply.code(400).send({ error: 'WS 和 HTTP 地址都要填' });
    const cfg = structuredClone(bridge.config);
    Object.assign(cfg.onebot, { wsUrl: b.wsUrl.trim(), httpUrl: b.httpUrl.trim(), autoDiscover: false });
    if (b.accessToken) cfg.onebot.accessToken = b.accessToken;
    if (b.httpToken) cfg.onebot.httpToken = b.httpToken;
    cfg.bot.autoConnect = cfg.bot.autoReconnect = true;
    bridge.updateConfig(cfg);
    return connectAndWait();
  });

  /** 连上并等到拿到登录账号（最多 8 秒），把真实结果告诉向导 */
  async function connectAndWait() {
    bridge.disconnect();
    await bridge.rediscover().catch(() => {});
    await bridge.connect().catch(() => {});
    const t0 = Date.now();
    while (!bridge.self && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 200));
    const s = bridge.status();
    return { ok: !!bridge.self && s.connection === 'open', self: bridge.self ?? null, connection: s.connection, error: s.lastError ?? (bridge.self ? undefined : '8 秒内没有拿到登录信息') };
  }

  /** DSH 的情况：装没装、开没开、登录没、接入没 */
  app.get('/api/wizard/dsh', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { dshSetupStatus } = await import('../drivers/dsh/setup.ts');
    const { dshHome } = await import('../drivers/dsh/client.ts');
    const home = dshHome(bridge.config.drivers.dsh.dshHome || undefined);
    const st = dshSetupStatus(bridge);
    const d: any = bridge.drivers.get('dsh');
    let reachable = false;
    try { await d?.locate?.(); await d?.listPresets?.(); reachable = !!d; } catch { /* 没开，或者连不上 */ }
    return {
      installed: fs.existsSync(home), running: reachable, loggedIn: fs.existsSync(path.join(home, '.credentials.yaml')),
      connected: bridge.config.drivers.dsh.enabled && st.tokenReady && st.mcpRegistered, setup: st,
      model: { provider: bridge.config.drivers.dsh.provider, model: bridge.config.drivers.dsh.model, reasoningEffort: bridge.config.drivers.dsh.reasoningEffort },
    };
  });

  /** 管理员和回复范围一次存好 */
  app.post('/api/wizard/basics', async (req) => {
    const b = (req.body ?? {}) as { owners?: string[]; mode?: 'all' | 'allowlist'; enabled?: string[] };
    const cfg = structuredClone(bridge.config);
    if (Array.isArray(b.owners)) cfg.owners = [...new Set(b.owners.map((x) => String(x).trim()).filter((x) => /^\d{5,12}$/.test(x)))];
    if (b.mode === 'all' || b.mode === 'allowlist') cfg.access.mode = b.mode;
    if (cfg.access.mode === 'allowlist' && Array.isArray(b.enabled)) {
      const ids = (t: string) => b.enabled!.filter((c) => c.startsWith(`${t}:`)).map((c) => c.slice(t.length + 1));
      cfg.access.groups = ids('group');
      cfg.access.private = ids('private');
    }
    bridge.updateConfig(cfg);
    return { ok: true, owners: cfg.owners, mode: cfg.access.mode };
  });

  app.post('/api/wizard/done', async () => { setWizard('done'); return { ok: true }; });
  /** 设置页里「重新运行设置向导」 */
  app.post('/api/wizard/restart', async () => { setWizard('pending'); return { ok: true }; });
}
