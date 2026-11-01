import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWs from '@fastify/websocket';
import fastifyMultipart from '@fastify/multipart';
import type { WebSocket } from 'ws';
import type { Bridge } from '../bridge.ts';
import type { PluginHost } from '../plugins/host.ts';
import { CONSOLE_CALLER } from '../policy.ts';
import { ConfigSchema, ROOT, TIERS, type Config } from '../config.ts';
import { handleMcpHttp, mcpSessions, toolsFor, callToolStateless } from '../mcp/server.ts';
import { buildTools } from '../mcp/tools.ts';
import { extraTools } from '../mcp/server.ts';
import { searchActions, ACTIONS, actionTier } from '../onebot/catalog.ts';
import { parseConv, convKey } from '../message/segments.ts';
import { logHub, createLogger } from '../util/log.ts';
import { randomToken, guessMime, MIME_EXT, sha256, atomicWrite, isInsideRoots } from '../util/fs.ts';
import { readSnowLumaAccounts } from '../onebot/discover.ts';

const log = createLogger('web');
const COOKIE = 'qab_session';

export async function startWeb(bridge: Bridge, plugins: PluginHost) {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 * 1024, requestTimeout: 0, connectionTimeout: 0, keepAliveTimeout: 65_000 });
  await app.register(fastifyWs);
  await app.register(fastifyMultipart, { limits: { fileSize: 64 * 1024 * 1024 } });

  const sessionValue = () => crypto.createHmac('sha256', bridge.config.server.sessionSecret).update(`console:${bridge.config.server.consolePassword}`).digest('base64url');
  const cookieOf = (req: FastifyRequest) => Object.fromEntries(String(req.headers.cookie ?? '').split(/;\s*/).filter(Boolean).map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), decodeURIComponent(kv.slice(i + 1))]; }))[COOKIE];
  const needsSetup = () => !bridge.config.server.consolePassword;
  const authed = (req: FastifyRequest) => !needsSetup() && cookieOf(req) === sessionValue();
  const setCookie = (reply: FastifyReply) => reply.header('set-cookie', `${COOKIE}=${encodeURIComponent(sessionValue())}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${30 * 86400}`);

  // ------------------------------------------------------------------ MCP
  app.all('/mcp', async (req, reply) => {
    reply.hijack();
    try { await handleMcpHttp(bridge, req.raw, reply.raw, req.body); } catch (e: any) {
      log.error('MCP 请求出错', e);
      if (!reply.raw.headersSent) { reply.raw.writeHead(500); reply.raw.end(); }
    }
  });

  // ------------------------------------------------------------------ 无状态 Agent 接口（stdio 代理 / 任意语言 Agent）
  const agentCaller = (req: FastifyRequest) => {
    const t = bridge.policy.findToken(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
    return t ? { kind: 'agent' as const, name: t.name, token: t } : null;
  };
  app.get('/api/agent/tools', async (req, reply) => {
    const caller = agentCaller(req);
    if (!caller) return reply.code(401).send({ error: '无效的 agent token' });
    const { SERVER_INSTRUCTIONS } = await import('../mcp/server.ts');
    return { instructions: SERVER_INSTRUCTIONS, tools: toolsFor(bridge, caller) };
  });
  app.post('/api/agent/call', async (req, reply) => {
    const caller = agentCaller(req);
    if (!caller) return reply.code(401).send({ error: '无效的 agent token' });
    const b = (req.body ?? {}) as { name?: string; arguments?: unknown };
    return callToolStateless(bridge, caller, String(b.name ?? ''), b.arguments);
  });

  // ------------------------------------------------------------------ 鉴权
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0];
    if (!url.startsWith('/api/') || url === '/api/login' || url === '/api/session' || url.startsWith('/api/setup') || url.startsWith('/api/agent/')) return;
    if (!authed(req)) { reply.code(401).send({ error: needsSetup() ? 'setup_required' : 'unauthorized' }); }
  });

  app.get('/api/session', async (req) => ({ authed: authed(req), setupRequired: needsSetup() }));

  app.post('/api/login', async (req, reply) => {
    const { password } = (req.body ?? {}) as { password?: string };
    if (needsSetup()) return reply.code(400).send({ error: 'setup_required' });
    const a = Buffer.from(String(password ?? '')); const b = Buffer.from(bridge.config.server.consolePassword);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { await new Promise((r) => setTimeout(r, 600)); return reply.code(401).send({ error: '密码错误' }); }
    setCookie(reply);
    return { ok: true };
  });

  app.post('/api/logout', async (_req, reply) => { reply.header('set-cookie', `${COOKIE}=; Path=/; Max-Age=0`); return { ok: true }; });

  // 首次设置向导（仅在未设置密码时可用）
  app.get('/api/setup/discover', async (_req, reply) => {
    if (!needsSetup()) return reply.code(403).send({ error: '已完成设置' });
    const d = await bridge.rediscover();
    return { discovery: d && { ...d, wsToken: undefined, httpToken: undefined, accounts: d.accounts.map((a) => ({ uin: a.uin, http: a.http && { ...a.http, token: a.http.token ? '***' : '' }, ws: a.ws && { ...a.ws, token: a.ws.token ? '***' : '' } })) }, snowlumaHome: bridge.config.onebot.snowlumaHome, status: bridge.status() };
  });
  app.post('/api/setup', async (req, reply) => {
    if (!needsSetup()) return reply.code(403).send({ error: '已完成设置' });
    const b = (req.body ?? {}) as { password?: string; owners?: string[]; snowlumaHome?: string; wsUrl?: string; httpUrl?: string; accessToken?: string; accessMode?: 'all' | 'allowlist' };
    if (!b.password || b.password.length < 6) return reply.code(400).send({ error: '密码至少 6 位' });
    const cfg = structuredClone(bridge.config);
    cfg.server.consolePassword = b.password;
    if (b.owners) cfg.owners = b.owners.map(String).filter(Boolean);
    if (b.snowlumaHome !== undefined) cfg.onebot.snowlumaHome = b.snowlumaHome;
    if (b.wsUrl) cfg.onebot.wsUrl = b.wsUrl;
    if (b.httpUrl) cfg.onebot.httpUrl = b.httpUrl;
    if (b.accessToken !== undefined) cfg.onebot.accessToken = b.accessToken;
    if (b.accessMode) cfg.access.mode = b.accessMode;
    bridge.updateConfig(cfg);
    await bridge.rediscover();
    setCookie(reply);
    return { ok: true };
  });

  // ------------------------------------------------------------------ 状态与配置
  app.get('/api/status', async () => {
    const day = Date.now() - 86400_000;
    return { ...bridge.status(), stats24h: bridge.store.stats(day), mcpSessions: mcpSessions(), discovery: bridge.discovery && { ok: bridge.discovery.ok, tried: bridge.discovery.tried, self: bridge.discovery.self }, mcpUrl: `http://${hostFor(bridge.config)}:${bridge.config.server.port}/mcp`, root: ROOT.split(path.sep).join('/') };
  });
  app.post('/api/bot/start', async () => { await bridge.connect(); return bridge.status(); });
  app.post('/api/bot/stop', async () => { bridge.disconnect(); return bridge.status(); });
  app.post('/api/reconnect', async () => { await bridge.rediscover(); return { ok: true, status: bridge.status() }; });
  app.post('/api/contacts/refresh', async () => { await bridge.refreshContacts(); return { groups: bridge.groups.size, friends: bridge.friends.size }; });

  app.get('/api/config', async () => ({ config: maskConfig(bridge.config), snowlumaAccounts: readSnowLumaAccounts(bridge.config.onebot.snowlumaHome).map((a) => a.uin) }));
  app.put('/api/config', async (req, reply) => {
    const incoming = req.body as any;
    // 掩码字段保持原值
    const merged = unmaskConfig(incoming, bridge.config);
    const parsed = ConfigSchema.safeParse(merged);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    const passwordChanged = parsed.data.server.consolePassword !== bridge.config.server.consolePassword;
    const endpointChanged = JSON.stringify(parsed.data.onebot) !== JSON.stringify(bridge.config.onebot);
    bridge.updateConfig(parsed.data);
    if (endpointChanged) await bridge.rediscover();
    if (passwordChanged) setCookie(reply);
    return { ok: true };
  });

  // ------------------------------------------------------------------ 会话与消息
  app.get('/api/conversations', async () => bridge.store.conversations().map((c) => ({ ...c, name: c.name || bridge.convName(c.conv), allowed: bridge.policy.convAllowed(parseConv(c.conv)) })));
  app.get('/api/contacts', async () => ({ groups: [...bridge.groups.values()], friends: [...bridge.friends.values()] }));
  app.get('/api/conv/:conv/messages', async (req) => {
    const { conv } = req.params as { conv: string };
    const q = req.query as { before?: string; limit?: string; server?: string };
    const key = convKey(parseConv(conv));
    if (q.server === '1') { try { await bridge.backfill(key, Number(q.limit ?? 40)); } catch (e: any) { log.warn(`补拉历史失败：${e.message}`); } }
    return bridge.store.recent(key, Math.min(Number(q.limit ?? 50), 200), q.before ? Number(q.before) : undefined);
  });
  app.post('/api/conv/:conv/send', async (req) => {
    const { conv } = req.params as { conv: string };
    const b = req.body as { message: string; replyTo?: string };
    return bridge.send(CONSOLE_CALLER, conv, b.message, { replyTo: b.replyTo });
  });
  app.post('/api/conv/:conv/read', async (req) => { bridge.store.markRead(convKey(parseConv((req.params as any).conv))); return { ok: true }; });
  app.post('/api/conv/:conv/pin', async (req) => { bridge.store.setPinned(convKey(parseConv((req.params as any).conv)), !!(req.body as any)?.pinned); return { ok: true }; });
  app.post('/api/messages/:id/recall', async (req) => {
    const { id } = req.params as { id: string };
    await bridge.invoke(CONSOLE_CALLER, 'recall', 'send', { id }, () => bridge.bot.call('delete_msg', { message_id: Number(id) }));
    const m = bridge.store.getMessage(id); if (m) bridge.store.markRecalled(m.conv, id);
    return { ok: true };
  });
  app.post('/api/messages/:id/react', async (req) => {
    const { id } = req.params as { id: string }; const { emoji } = req.body as { emoji: string };
    const faceId = bridge.faces.resolve(emoji) ?? [...emoji][0]?.codePointAt(0);
    await bridge.invoke(CONSOLE_CALLER, 'react', 'send', { id, emoji }, () => bridge.bot.call('set_msg_emoji_like', { message_id: Number(id), emoji_id: String(faceId), set: true }));
    return { ok: true };
  });

  // 上传：控制台拖拽图片/文件 → 存到 data/uploads，返回本地路径供 [image:路径] 使用
  app.post('/api/upload', async (req, reply) => {
    const file = await (req as any).file();
    if (!file) return reply.code(400).send({ error: '没有文件' });
    const buf: Buffer = await file.toBuffer();
    const dir = path.join(bridge.dataDir, 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    const mime = guessMime(buf);
    const ext = MIME_EXT[mime] ?? path.extname(file.filename || '') ?? '';
    const p = path.join(dir, `${sha256(buf).slice(0, 16)}${ext}`);
    if (!fs.existsSync(p)) atomicWrite(p, buf);
    return { path: p, mime, size: buf.length, name: file.filename };
  });

  // 媒体预览（控制台显示收到的图片）
  app.get('/api/media/:ref', async (req, reply) => {
    try {
      const r = await bridge.media.fetch((req.params as any).ref);
      return reply.header('content-type', r.mime).header('cache-control', 'private, max-age=86400').send(r.buf);
    } catch (e: any) { return reply.code(404).send({ error: e.message }); }
  });
  app.get('/api/local-file', async (req, reply) => {
    const p = String((req.query as any).path ?? '');
    const roots = [path.join(bridge.dataDir, 'uploads'), path.join(bridge.dataDir, 'stickers'), path.join(bridge.dataDir, 'media')];
    const abs = path.resolve(p);
    if (!isInsideRoots(abs, roots) || !fs.existsSync(abs)) return reply.code(404).send();
    const buf = fs.readFileSync(abs);
    return reply.header('content-type', guessMime(buf)).send(buf);
  });

  // ------------------------------------------------------------------ 表情
  app.get('/api/faces', async (req) => bridge.faces.search(String((req.query as any).q ?? ''), 500));
  app.get('/api/stickers', async (req) => bridge.store.findStickers(String((req.query as any).q ?? ''), 500));
  app.get('/api/stickers/:id/image', async (req, reply) => {
    const s = bridge.store.getSticker(Number((req.params as any).id));
    if (!s || !fs.existsSync(s.path)) return reply.code(404).send();
    return reply.header('content-type', s.mime).header('cache-control', 'private, max-age=604800').send(fs.readFileSync(s.path));
  });
  app.post('/api/stickers', async (req) => {
    const b = req.body as { source: string; remark?: string; tags?: string };
    return bridge.collectSticker(b.source, b.remark ?? '', b.tags ?? '', 'console');
  });
  app.patch('/api/stickers/:id', async (req) => { bridge.store.updateSticker(Number((req.params as any).id), req.body as any); return { ok: true }; });
  app.delete('/api/stickers/:id', async (req) => { bridge.store.deleteSticker(Number((req.params as any).id)); return { ok: true }; });

  // ------------------------------------------------------------------ 动作调试台
  app.get('/api/actions', async (req) => {
    const q = req.query as { q?: string; category?: string };
    return { actions: searchActions(q.q ?? '', q.category, 500), categories: [...new Set(ACTIONS.map((a) => a.category))] };
  });
  app.post('/api/actions/:name', async (req) => {
    const { name } = req.params as { name: string };
    const data = await bridge.invoke(CONSOLE_CALLER, `action:${name}`, actionTier(name), req.body, () => bridge.bot.call(name, (req.body as any) ?? {}));
    return { data };
  });

  // ------------------------------------------------------------------ Agent：工具 / token / 审计 / 审批
  app.get('/api/tools', async () => [...buildTools(), ...extraTools.values()].map((t) => ({ name: t.name, title: t.title, description: t.description, tier: t.tier, disabled: bridge.config.agents.disabledTools.includes(t.name) })));
  app.get('/api/tokens', async () => bridge.config.agents.tokens);
  app.post('/api/tokens', async (req) => {
    const b = req.body as { name: string; tiers?: string[]; groups?: string[]; private?: string[] };
    const cfg = structuredClone(bridge.config);
    const t = { name: b.name || `agent-${cfg.agents.tokens.length + 1}`, token: `qab_${randomToken(24)}`, tiers: (b.tiers ?? ['read', 'send']).filter((x): x is typeof TIERS[number] => (TIERS as readonly string[]).includes(x)), groups: b.groups ?? [], private: b.private ?? [], enabled: true, sessionBound: !!(b as any).sessionBound, toolAllow: (b as any).toolAllow ?? [] };
    cfg.agents.tokens.push(t);
    bridge.updateConfig(cfg);
    return t;
  });
  app.put('/api/tokens/:token', async (req, reply) => {
    const cfg = structuredClone(bridge.config);
    const i = cfg.agents.tokens.findIndex((t) => t.token === (req.params as any).token);
    if (i < 0) return reply.code(404).send({ error: '不存在' });
    cfg.agents.tokens[i] = { ...cfg.agents.tokens[i], ...(req.body as any), token: cfg.agents.tokens[i].token };
    bridge.updateConfig(ConfigSchema.parse(cfg));
    return { ok: true };
  });
  app.delete('/api/tokens/:token', async (req) => {
    const cfg = structuredClone(bridge.config);
    cfg.agents.tokens = cfg.agents.tokens.filter((t) => t.token !== (req.params as any).token);
    bridge.updateConfig(cfg);
    return { ok: true };
  });
  app.get('/api/audit', async (req) => bridge.store.auditList(Math.min(Number((req.query as any).limit ?? 200), 1000), (req.query as any).before ? Number((req.query as any).before) : undefined));
  app.get('/api/approvals', async () => bridge.policy.pendingApprovals());
  app.post('/api/approvals/:id', async (req, reply) => {
    const ok = bridge.policy.decide((req.params as any).id, !!(req.body as any)?.approve);
    return ok ? { ok } : reply.code(404).send({ error: '审批不存在或已处理' });
  });
  app.get('/api/requests', async () => [...bridge.requests.values()]);
  app.post('/api/requests/:flag', async (req, reply) => {
    const r = bridge.requests.get((req.params as any).flag);
    if (!r) return reply.code(404).send({ error: '不存在' });
    const approve = !!(req.body as any)?.approve;
    if (r.kind === 'friend') await bridge.bot.call('set_friend_add_request', { flag: r.flag, approve });
    else await bridge.bot.call('set_group_add_request', { flag: r.flag, sub_type: r.subType, type: r.subType, approve });
    bridge.requests.delete(r.flag);
    return { ok: true };
  });

  // ------------------------------------------------------------------ 插件
  app.get('/api/plugins', async () => plugins.list());
  app.post('/api/plugins/:name/:op', async (req, reply) => {
    const { name, op } = req.params as { name: string; op: string };
    if (op === 'enable') await plugins.setEnabled(name, true);
    else if (op === 'disable') await plugins.setEnabled(name, false);
    else if (op === 'reload') await plugins.reload(name);
    else if (op === 'rescan') await plugins.loadAll();
    else return reply.code(400).send({ error: '未知操作' });
    return { ok: true };
  });
  app.put('/api/plugins/:name/config', async (req) => {
    const { name } = req.params as { name: string };
    plugins.saveConfig(name, req.body as any);
    if (plugins.plugins.get(name)?.loaded && plugins.plugins.get(name)?.kind === 'native') await plugins.reload(name);
    return { ok: true };
  });

  // ------------------------------------------------------------------ 驱动 / DSH 接入
  app.get('/api/drivers', async () => {
    const { dshSetupStatus } = await import('../drivers/dsh/setup.ts');
    return { drivers: [...bridge.drivers.values()].map((d) => d.status()), dsh: { config: { ...bridge.config.drivers.dsh, authToken: bridge.config.drivers.dsh.authToken ? '••••••' : '' }, setup: dshSetupStatus(bridge) } };
  });
  app.post('/api/drivers/dsh/install', async () => {
    const { installDsh } = await import('../drivers/dsh/setup.ts');
    const r = await installDsh(bridge);
    await (bridge.drivers.get('dsh') as any)?.reconfigure?.();
    return r;
  });
  app.post('/api/drivers/dsh/uninstall', async () => {
    const { uninstallDsh } = await import('../drivers/dsh/setup.ts');
    const steps = await uninstallDsh(bridge);
    await bridge.drivers.get('dsh')?.stop();
    return { steps };
  });
  // ---------------------------------------------------------------- 自动更新
  const updater = () => { if (!bridge.updater) throw new Error('更新器未启用'); return bridge.updater; };
  app.get('/api/update', async () => bridge.updater?.state ?? null);
  app.post('/api/update/check', async () => { try { return await updater().check(); } catch (e: any) { return { ...updater().state, error: e.message }; } });
  app.post('/api/update/install', async (_req, reply) => {
    const u = updater();
    if (u.state.phase === 'downloading' || u.state.phase === 'preparing') return reply.code(409).send({ error: '正在更新中' });
    // 后台下载，进度通过 WebSocket 推送
    u.install().catch((e: any) => { u.state.phase = 'error'; u.state.error = e.message; u.emit('status', u.state); });
    return { ok: true };
  });
  app.post('/api/update/cancel', async () => { updater().cancel(); return updater().state; });

  app.post('/api/drivers/dsh/test', async () => {
    const d: any = bridge.drivers.get('dsh');
    if (!d) return { ok: false, error: '驱动未注册' };
    try {
      await d.locate?.();
      const presets = await d.listPresets();
      return { ok: true, baseUrl: bridge.config.drivers.dsh.baseUrl, presets: presets.map((p: any) => p.id), hasPreset: presets.some((p: any) => p.id === bridge.config.drivers.dsh.preset) };
    } catch (e: any) { return { ok: false, error: e.message }; }
  });
  app.put('/api/drivers/dsh/config', async (req) => {
    const cfg = structuredClone(bridge.config);
    const b = (req.body ?? {}) as any;
    if (b.authToken === '••••••') delete b.authToken;
    cfg.drivers.dsh = { ...cfg.drivers.dsh, ...b };
    bridge.updateConfig(ConfigSchema.parse(cfg));
    await (bridge.drivers.get('dsh') as any)?.reconfigure?.();
    return { ok: true };
  });

  // ------------------------------------------------------------------ 用量
  app.get('/api/usage/summary', async () => bridge.usage.summary());
  app.get('/api/usage/series', async (req) => bridge.usage.series(Math.min(Number((req.query as any).days ?? 30), 365)));
  app.get('/api/usage/breakdown', async (req) => {
    const q = req.query as any;
    const rows = bridge.usage.breakdown(q.by === 'model' ? 'model' : q.by === 'driver' ? 'driver' : 'conv', q.days ? Date.now() - Number(q.days) * 86400_000 : 0);
    return rows.map((r) => ({ ...r, name: q.by === 'conv' || !q.by ? bridge.convName(r.key) : bridge.prices().models[r.key]?.label ?? '' }));
  });
  app.get('/api/usage/turns', async (req) => bridge.usage.recentTurns(Math.min(Number((req.query as any).limit ?? 50), 500)));
  app.get('/api/usage/prices', async () => bridge.prices());
  app.put('/api/usage/prices', async (req) => {
    const cfg = structuredClone(bridge.config);
    cfg.usage.prices = (req.body ?? {}) as any;
    bridge.updateConfig(cfg);
    return { recomputed: bridge.usage.recompute() };
  });

  // ------------------------------------------------------------------ 迁移
  app.get('/api/migrate/qq-bridge', async (req) => {
    const { detectQqBridge, guessQqBridgeDir } = await import('../migrate/qqbridge.ts');
    const dir = String((req.query as any).dir || guessQqBridgeDir());
    return { dir, detected: dir ? detectQqBridge(dir) : null };
  });
  app.post('/api/migrate/qq-bridge', async (req) => {
    const { migrateQqBridge } = await import('../migrate/qqbridge.ts');
    const b = req.body as any;
    return migrateQqBridge(bridge, String(b.dir), { config: true, roles: true, social: true, stickers: true, memory: true, usage: true, slang: true, ...(b.options ?? {}) });
  });

  // 插件自定义接口：/api/p/<插件名>/<路径>
  app.all('/api/p/:plugin/*', async (req, reply) => {
    const { plugin } = req.params as { plugin: string };
    const sub = (req.params as any)['*'] as string;
    const hit = plugins.findRoute(plugin, req.method, sub);
    if (!hit) return reply.code(404).send({ error: `插件 ${plugin} 没有接口 ${req.method} ${sub}` });
    const r = await hit.route.handler({ query: (req.query ?? {}) as Record<string, string>, body: req.body, params: hit.params });
    return r ?? { ok: true };
  });

  app.get('/api/activity', async (req) => {
    const q = req.query as any;
    return bridge.store.activities({ conv: q.conv || undefined, kind: q.kind || undefined, before: q.before ? Number(q.before) : undefined, limit: Math.min(Number(q.limit ?? 200), 1000) })
      .map((r: any) => ({ ...r, convName: r.conv ? bridge.convName(r.conv) : '' }));
  });

  app.get('/api/logs', async () => logHub.ring.slice(-500));

  // ------------------------------------------------------------------ 实时推送
  const sockets = new Set<WebSocket>();
  app.get('/ws/console', { websocket: true }, (socket, req) => {
    if (!authed(req)) { socket.close(4401, 'unauthorized'); return; }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.send(JSON.stringify({ type: 'status', data: bridge.status() }));
  });
  const push = (type: string, data: unknown) => {
    if (!sockets.size) return;
    const s = JSON.stringify({ type, data });
    for (const ws of sockets) if (ws.readyState === 1) ws.send(s);
  };
  bridge.on('message', (m) => push('message', m));
  bridge.on('state', () => push('status', bridge.status()));
  bridge.on('self', () => push('status', bridge.status()));
  bridge.on('contacts', () => push('contacts', null));
  bridge.on('audit', (a) => push('audit', a));
  bridge.on('usage', (u) => push('usage', u));
  bridge.on('activity', (a) => push('activity', { ...a, convName: a.conv ? bridge.convName(a.conv) : '' }));
  bridge.on('driver', (d) => push('driver', d));
  bridge.on('request', (r) => push('request', r));
  bridge.updater?.on('status', (st) => push('update', st));
  bridge.on('notice', (n) => push('notice', n));
  bridge.policy.on('approval', (a) => push('approval', a));
  plugins.on('changed', () => push('plugins', null));
  logHub.on('log', (e) => push('log', e));

  // ------------------------------------------------------------------ 控制台静态文件
  const dist = path.join(ROOT, 'console', 'dist');
  if (fs.existsSync(dist)) {
    // wildcard 模式按请求查找文件，控制台重新构建后无需重启守护进程
    await app.register(fastifyStatic, {
      root: dist,
      setHeaders: (reply, p) => reply.header('cache-control', p.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable'),
    });
    app.setNotFoundHandler((req, reply) => {
      if (/^\/(api|ws|assets)\//.test(req.url)) return reply.code(404).send({ error: 'not found' });
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    });
  } else {
    app.get('/', async (_req, reply) => reply.type('text/html').send('<meta charset="utf-8"><p>控制台尚未构建：请运行 <code>npm run console:build</code></p>'));
  }

  app.setErrorHandler((err: any, _req, reply) => {
    const code = err.statusCode && err.statusCode < 500 ? err.statusCode : err.code === 'forbidden' || err.code === 'read_only' ? 403 : 500;
    reply.code(code).send({ error: err.message });
  });

  const { host, port } = bridge.config.server;
  await app.listen({ host, port });
  log.info(`控制台：http://${hostFor(bridge.config)}:${port}   MCP：http://${hostFor(bridge.config)}:${port}/mcp`);
  return app;
}

function hostFor(c: Config) { return c.server.host === '0.0.0.0' ? '127.0.0.1' : c.server.host; }

const MASK = '••••••';
function maskConfig(c: Config) {
  const x = structuredClone(c);
  if (x.onebot.accessToken) x.onebot.accessToken = MASK;
  if (x.onebot.httpToken) x.onebot.httpToken = MASK;
  if (x.server.consolePassword) x.server.consolePassword = MASK;
  x.server.sessionSecret = MASK;
  return x;
}
function unmaskConfig(incoming: any, cur: Config) {
  const x = structuredClone(incoming ?? {});
  x.onebot ??= {}; x.server ??= {};
  if (x.onebot.accessToken === MASK) x.onebot.accessToken = cur.onebot.accessToken;
  if (x.onebot.httpToken === MASK) x.onebot.httpToken = cur.onebot.httpToken;
  if (x.server.consolePassword === MASK) x.server.consolePassword = cur.server.consolePassword;
  x.server.sessionSecret = cur.server.sessionSecret;
  x.agents ??= {}; x.agents.tokens = cur.agents.tokens; // token 走单独接口
  return x;
}
