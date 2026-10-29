import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { MockOneBot } from './mock-onebot.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qab-test-'));
process.env.QAB_CONFIG = path.join(tmp, 'qab.yaml');

const { ConfigSchema } = await import('../src/config.ts');
const { Bridge } = await import('../src/bridge.ts');
const { PluginHost } = await import('../src/plugins/host.ts');
const { startWeb } = await import('../src/web/server.ts');

const WS = 23001, HTTP = 23000, PORT = 23210;
const mock = new MockOneBot({ wsPort: WS, httpPort: HTTP, token: 'mock' });
let bridge: InstanceType<typeof Bridge>;
let app: Awaited<ReturnType<typeof startWeb>>;
let client: Client;
let limited: Client;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = (r: any) => r.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');

async function waitFor(fn: () => boolean, ms = 3000) {
  const t = Date.now();
  while (!fn()) { if (Date.now() - t > ms) throw new Error('waitFor 超时'); await sleep(20); }
}

beforeAll(async () => {
  await mock.start();
  const config = ConfigSchema.parse({
    onebot: { wsUrl: `ws://127.0.0.1:${WS}`, httpUrl: `http://127.0.0.1:${HTTP}`, accessToken: 'mock', autoDiscover: false },
    server: { port: PORT, consolePassword: 'secret123', sessionSecret: 'x' },
    dataDir: path.join(tmp, 'data'),
    access: { mode: 'all', denyGroups: ['999'] },
    limits: { gapBaseMs: 10, gapPerCharMs: 0, convPerMinute: 50 },
    agents: { tokens: [
      { name: 'full', token: 'tok-full', tiers: ['read', 'send', 'manage', 'danger'] },
      { name: 'reader', token: 'tok-read', tiers: ['read'] },
      { name: 'scoped', token: 'tok-scoped', tiers: ['read', 'send'], groups: ['222'] },
    ], approvalTimeoutMs: 3000 },
    plugins: { dir: path.join(import.meta.dirname, '..', 'plugins') },
  });
  bridge = new Bridge(config);
  const host = new PluginHost(bridge);
  app = await startWeb(bridge, host);
  await bridge.start();
  await host.loadAll();
  await waitFor(() => !!bridge.self);
  client = new Client({ name: 't', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), { requestInit: { headers: { authorization: 'Bearer tok-full' } } }));
  limited = new Client({ name: 't2', version: '1' });
  await limited.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), { requestInit: { headers: { authorization: 'Bearer tok-read' } } }));
});

afterAll(async () => {
  await client?.close(); await limited?.close();
  await app?.close();
  await bridge?.stop();
  await mock.stop();
});

describe('连接与基础', () => {
  it('登录信息与系统表情', async () => {
    expect(bridge.self?.userId).toBe('10000');
    await waitFor(() => bridge.faces.loadedFromQQ);
    expect(bridge.faces.resolve('测试表情')).toBe(999);
  });

  it('MCP 列出工具，按 token 等级过滤', async () => {
    const full = (await client.listTools()).tools.map((t) => t.name);
    expect(full).toContain('qq_send');
    expect(full).toContain('qq_group_kick');
    const ro = (await limited.listTools()).tools.map((t) => t.name);
    expect(ro).toContain('qq_get_history');
    expect(ro).not.toContain('qq_send');
  });

  it('未授权 token 被拒绝', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, { method: 'POST', headers: { authorization: 'Bearer nope', 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
    expect(res.status).toBe(401);
  });
});

describe('收发消息', () => {
  it('收到消息入库，渲染 @我 与图片引用', async () => {
    mock.pushGroupMessage(111, 20001, [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ' 你好[doge]' } }, { type: 'image', data: { file: 'x.png', url: 'http://example.invalid/x.png' } }]);
    await waitFor(() => bridge.store.recent('group:111', 5).length > 0);
    const m = bridge.store.recent('group:111', 1)[0];
    expect(m.mentioned).toBe(true);
    expect(m.text).toMatch(/^@我  你好\[doge\]\[图片#[0-9a-f]{8}\]$/);
  });

  it('qq_get_unread 返回并标记已读', async () => {
    const r = await client.callTool({ name: 'qq_get_unread', arguments: {} });
    expect(text(r)).toContain('group:111');
    const r2 = await client.callTool({ name: 'qq_get_unread', arguments: {} });
    expect(text(r2)).toBe('没有未读消息');
  });

  it('qq_wait_messages 等到新消息', async () => {
    const p = client.callTool({ name: 'qq_wait_messages', arguments: { timeoutSec: 5, quietSec: 0.3 } });
    await sleep(200);
    mock.pushPrivateMessage(20001, [{ type: 'text', data: { text: '私聊来了' } }]);
    const r = await p;
    expect(text(r)).toContain('私聊来了');
    expect(text(r)).toContain('private:20001');
  });

  it('qq_send 解析 DSL：at / face / reply', async () => {
    mock.calls.length = 0;
    const r = await client.callTool({ name: 'qq_send', arguments: { conv: 'group:111', message: '[at:20001] 看[face:微笑]\\[不是标签\\]', replyTo: '42' } });
    expect(r.isError).toBeFalsy();
    const call = mock.calls.find((c) => c.action === 'send_group_msg')!;
    expect(call.params.group_id).toBe(111);
    expect(call.params.message).toEqual([
      { type: 'reply', data: { id: '42' } },
      { type: 'at', data: { qq: '20001' } },
      { type: 'text', data: { text: ' 看' } },
      { type: 'face', data: { id: '14' } },
      { type: 'text', data: { text: '[不是标签]' } },
    ]);
    // 自己发的消息也入库
    expect(bridge.store.recent('group:111', 1)[0].isSelf).toBe(true);
  });

  it('qq_send_burst 分多条发送', async () => {
    mock.calls.length = 0;
    const r = await client.callTool({ name: 'qq_send_burst', arguments: { conv: 'private:20001', messages: ['第一句', '第二句', '第三句'] } });
    expect(text(r)).toContain('分 3 条');
    expect(mock.calls.filter((c) => c.action === 'send_private_msg').length).toBe(3);
  });

  it('黑名单会话发送被拒绝且明确报错', async () => {
    const r = await client.callTool({ name: 'qq_send', arguments: { conv: 'group:999', message: 'hi' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('未执行');
  });

  it('只读 token 不能调用发送类 OneBot 动作', async () => {
    const r = await limited.callTool({ name: 'qq_call_action', arguments: { action: 'send_group_msg', params: { group_id: 111, message: 'x' } } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('没有 send 级权限');
  });

  it('未知动作被拒绝', async () => {
    const r = await client.callTool({ name: 'qq_call_action', arguments: { action: 'totally_unknown', params: {} } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('未知动作');
  });

  it('获取历史时自动补拉服务器记录', async () => {
    const r = await client.callTool({ name: 'qq_get_history', arguments: { conv: 'group:222', limit: 10 } });
    expect(text(r)).toContain('历史消息1');
  });
});

describe('审批与媒体', () => {
  it('danger 动作需审批，批准后执行', async () => {
    mock.handlers.set_group_kick = () => null;
    const p = client.callTool({ name: 'qq_group_kick', arguments: { groupId: '111', userId: '20001' } });
    await waitFor(() => bridge.policy.pendingApprovals().length === 1);
    const a = bridge.policy.pendingApprovals()[0];
    expect(a.tool).toBe('qq_group_kick');
    bridge.policy.decide(a.id, true);
    const r = await p;
    expect(r.isError).toBeFalsy();
    expect(mock.calls.some((c) => c.action === 'set_group_kick')).toBe(true);
  });

  it('danger 动作被拒绝', async () => {
    const p = client.callTool({ name: 'qq_group_kick', arguments: { groupId: '111', userId: '20001' } });
    await waitFor(() => bridge.policy.pendingApprovals().length === 1);
    bridge.policy.decide(bridge.policy.pendingApprovals()[0].id, false);
    const r = await p;
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('拒绝');
  });

  it('qq_get_image 返回图片内容；收藏为表情包并发送', async () => {
    mock.pushGroupMessage(111, 20001, [{ type: 'image', data: { file: 'pic.png', url: '' } }]);
    await waitFor(() => bridge.store.recent('group:111', 1)[0]?.text.includes('图片#'));
    const ref = /#([0-9a-f]{8})/.exec(bridge.store.recent('group:111', 1)[0].text)![1];
    const r: any = await client.callTool({ name: 'qq_get_image', arguments: { ref } });
    expect(r.content[0].type).toBe('image');
    expect(r.content[0].mimeType).toBe('image/png');
    const c = await client.callTool({ name: 'qq_collect_sticker', arguments: { source: ref, remark: '测试图' } });
    expect(text(c)).toMatch(/已收藏：#\d+/);
    mock.calls.length = 0;
    await client.callTool({ name: 'qq_send_sticker', arguments: { conv: 'group:111', sticker: '测试图' } });
    const sent = mock.calls.find((x) => x.action === 'send_group_msg')!;
    expect(sent.params.message[0].type).toBe('image');
    expect(sent.params.message[0].data.sub_type).toBe(1);
  });

  it('审计日志记录了工具调用', () => {
    const rows = bridge.store.auditList(100);
    expect(rows.some((r: any) => r.tool === 'send' && r.ok === 1)).toBe(true);
    expect(rows.some((r: any) => r.tool === 'qq_group_kick' && r.ok === 0)).toBe(true);
  });
});

describe('插件', () => {
  it('用户插件响应命令', async () => {
    mock.calls.length = 0;
    mock.pushGroupMessage(111, 20001, [{ type: 'text', data: { text: '/hello 小红' } }]);
    await waitFor(() => mock.calls.some((c) => c.action === 'send_group_msg'));
    const call = mock.calls.find((c) => c.action === 'send_group_msg')!;
    expect(JSON.stringify(call.params.message)).toContain('你好呀，小红');
  });

  it('/help 汇总所有插件命令', async () => {
    mock.calls.length = 0;
    mock.pushGroupMessage(111, 20001, [{ type: 'text', data: { text: '/help' } }]);
    await waitFor(() => mock.calls.some((c) => c.action === 'send_group_msg'));
    const t = JSON.stringify(mock.calls.find((c) => c.action === 'send_group_msg')!.params.message);
    expect(t).toContain('/提醒');
    expect(t).toContain('/表情包');
  });

  it('插件注册的工具出现在 MCP 中', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ['hello_roll_dice', 'qq_memory_remember', 'qq_speak', 'qq_schedule', 'qq_send_sticker', 'qq_group_stats']) expect(names).toContain(n);
    const r = await client.callTool({ name: 'hello_roll_dice', arguments: { sides: 6 } });
    expect(Number(text(r).match(/\d+/)![0])).toBeGreaterThanOrEqual(1);
  });

  it('默认关闭的系统插件未加载', () => {
    const st = bridge.pluginHost!.plugins.get('guard')!;
    expect(st.system).toBe(true);
    expect(st.loaded).toBe(false);
  });
});

describe('系统插件', () => {
  it('记忆：写入、合并、回忆、会话上下文', async () => {
    const a = await client.callTool({ name: 'qq_memory_remember', arguments: { content: '小明喜欢吃火锅和烧烤', subject: '20001', kind: 'preference', importance: 4 } });
    expect(text(a)).toMatch(/已记住 #\d+/);
    const b = await client.callTool({ name: 'qq_memory_remember', arguments: { content: '小明喜欢吃火锅和烧烤！', subject: '20001', kind: 'preference' } });
    expect(text(b)).toContain('合并');
    const r = await client.callTool({ name: 'qq_memory_recall', arguments: { query: '火锅' } });
    expect(text(r)).toContain('小明喜欢吃火锅');
    const c = await client.callTool({ name: 'qq_memory_context', arguments: { conv: 'group:111' } });
    expect(text(c)).toContain('火锅');
  });

  it('定时：安排并触发', async () => {
    mock.calls.length = 0;
    const r = await client.callTool({ name: 'qq_schedule', arguments: { conv: 'group:111', message: '定时测试', delayMinutes: 0.001 } });
    expect(text(r)).toContain('已安排');
    await waitFor(() => mock.calls.some((c) => c.action === 'send_group_msg' && JSON.stringify(c.params.message).includes('定时测试')), 15000);
  }, 20000);

  it('插件 HTTP 接口', async () => {
    const base = `http://127.0.0.1:${PORT}`;
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'secret123' }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const o = await (await fetch(`${base}/api/p/memory/overview`, { headers: { cookie } })).json();
    expect(o.total).toBeGreaterThan(0);
  });
});

describe('token 会话范围', () => {
  it('受限 token 看不到、发不到范围外会话', async () => {
    const sc = new Client({ name: 't3', version: '1' });
    await sc.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), { requestInit: { headers: { authorization: 'Bearer tok-scoped' } } }));
    mock.pushGroupMessage(111, 20001, [{ type: 'text', data: { text: '秘密消息111' } }]);
    mock.pushGroupMessage(222, 20001, [{ type: 'text', data: { text: '公开消息222' } }]);
    await waitFor(() => bridge.store.search('公开消息222').length > 0);
    const s1 = text(await sc.callTool({ name: 'qq_search_messages', arguments: { query: '消息' } }));
    expect(s1).toContain('公开消息222');
    expect(s1).not.toContain('秘密消息111');
    const convs = text(await sc.callTool({ name: 'qq_list_conversations', arguments: {} }));
    expect(convs).not.toContain('group:111');
    const send = await sc.callTool({ name: 'qq_send', arguments: { conv: 'group:111', message: 'x' } });
    expect(send.isError).toBe(true);
    await sc.close();
  });
});

describe('无状态 Agent 接口（stdio 代理使用）', () => {
  it('列工具与调用，不依赖 MCP 会话', async () => {
    const base = `http://127.0.0.1:${PORT}`;
    const h = { authorization: 'Bearer tok-full', 'content-type': 'application/json' };
    const list = await (await fetch(`${base}/api/agent/tools`, { headers: h })).json();
    expect(list.tools.some((t: any) => t.name === 'qq_send' && t.inputSchema.properties.conv)).toBe(true);
    const r = await (await fetch(`${base}/api/agent/call`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'qq_status', arguments: {} }) })).json();
    expect(r.content[0].text).toContain('连接：open');
    const bad = await (await fetch(`${base}/api/agent/call`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'qq_send', arguments: { conv: 'group:111' } }) })).json();
    expect(bad.isError).toBe(true);
    expect((await fetch(`${base}/api/agent/tools`, { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
  });
});

describe('控制台 API', () => {
  it('未登录 401，登录后可访问', async () => {
    const base = `http://127.0.0.1:${PORT}`;
    expect((await fetch(`${base}/api/status`)).status).toBe(401);
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'secret123' }) });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const st = await (await fetch(`${base}/api/status`, { headers: { cookie } })).json();
    expect(st.connection).toBe('open');
    const cfg = await (await fetch(`${base}/api/config`, { headers: { cookie } })).json();
    expect(cfg.config.server.consolePassword).toBe('••••••');
  });
});
