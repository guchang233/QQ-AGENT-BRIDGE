import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MockOneBot } from './mock-onebot.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qab-astr-'));
process.env.QAB_CONFIG = path.join(tmp, 'qab.yaml');
const { ConfigSchema, ROOT } = await import('../src/config.ts');
const { Bridge } = await import('../src/bridge.ts');
const { PluginHost } = await import('../src/plugins/host.ts');
const { AstrBotHost } = await import('../src/plugins/astrbot.ts');
const { extraTools } = await import('../src/mcp/server.ts');

const mock = new MockOneBot({ wsPort: 24001, httpPort: 24000, token: '' });
let bridge: InstanceType<typeof Bridge>;
let astr: InstanceType<typeof AstrBotHost>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitSend(substr: string, ms = 8000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const c = mock.calls.find((x) => /^send_(group|private)_msg$/.test(x.action) && JSON.stringify(x.params.message).includes(substr));
    if (c) return c;
    await sleep(30);
  }
  throw new Error(`未发送包含「${substr}」的消息；已发送：${JSON.stringify(mock.calls.filter((x) => x.action.startsWith('send')).map((x) => x.params.message))}`);
}

beforeAll(async () => {
  await mock.start();
  bridge = new Bridge(ConfigSchema.parse({
    onebot: { wsUrl: 'ws://127.0.0.1:24001', httpUrl: 'http://127.0.0.1:24000', autoDiscover: false },
    server: { port: 24210, consolePassword: 'x', sessionSecret: 'x' },
    dataDir: path.join(tmp, 'data'),
    plugins: { dir: path.join(tmp, 'noplugins'), astrbot: { enabled: true, dir: path.join(ROOT, 'astrbot_shim', 'examples') } },
  }));
  const host = new PluginHost(bridge);
  await bridge.start();
  while (!bridge.self) await sleep(20);
  astr = new AstrBotHost(bridge, host);
  await astr.start();
}, 60_000);

afterAll(async () => { await astr?.stop(); await bridge?.stop(); await mock.stop(); });

describe('AstrBot 兼容层', () => {
  it('加载插件元数据、命令与 llm_tool', () => {
    const st = bridge.pluginHost!.plugins.get('astrbot-helloworld')!;
    expect(st.error).toBeUndefined();
    expect(st.loaded).toBe(true);
    expect(st.commandList!.map((c) => c.names[0])).toEqual(expect.arrayContaining(['hi', 'add', 'math mul']));
    expect(st.config).toMatchObject({ greeting: 'Hello', times: 1 });
    expect(extraTools.has('astrbot_helloworld_get_weather')).toBe(true);
  });

  it('命令参数解析与 yield 结果', async () => {
    mock.pushGroupMessage(111, 20001, [{ type: 'text', data: { text: '/hi 小明' } }]);
    await waitSend('Hello, 小明!');
    mock.pushGroupMessage(111, 20001, [{ type: 'text', data: { text: '/add 2 3' } }]);
    await waitSend('2 + 3 = 5');
    mock.pushGroupMessage(111, 20001, [{ type: 'text', data: { text: '/math mul 6 7' } }]);
    await waitSend('42');
  });

  it('参数类型错误提示', async () => {
    mock.pushGroupMessage(111, 20001, [{ type: 'text', data: { text: '/add x 3' } }]);
    await waitSend('参数错误');
  });

  it('正则 + 消息链组件', async () => {
    mock.calls.length = 0;
    mock.pushGroupMessage(111, 20001, [{ type: 'text', data: { text: 'ping' } }]);
    const c = await waitSend('pong');
    expect(c.params.message).toEqual(expect.arrayContaining([{ type: 'at', data: { qq: '20001' } }, { type: 'face', data: { id: '14' } }]));
  });

  it('私聊过滤 + event.bot.api.call_action', async () => {
    mock.pushPrivateMessage(20001, [{ type: 'text', data: { text: '群信息' } }]);
    await waitSend('我加了 2 个群');
  });

  it('llm_tool 作为 MCP 工具调用', async () => {
    const t = extraTools.get('astrbot_helloworld_get_weather')!;
    const r = await t.handler({ bridge, caller: { kind: 'console', name: 't' } }, { location: '杭州' });
    expect(r).toBe('杭州 今天晴，25 度');
  });
});
