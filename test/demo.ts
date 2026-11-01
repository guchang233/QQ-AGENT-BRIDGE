/**
 * 演示模式：启动 Mock OneBot + 完整桥接（控制台 / MCP / 插件），不需要真实 QQ。
 * 运行：npm run demo   然后打开 http://127.0.0.1:3299 （密码 demo1234）
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { MockOneBot, PNG_1PX } from './mock-onebot.ts';

const dir = path.join(os.tmpdir(), 'qab-demo');
fs.mkdirSync(dir, { recursive: true });
process.env.QAB_CONFIG = path.join(dir, 'qab.yaml');

const { ConfigSchema } = await import('../src/config.ts');
const { Bridge } = await import('../src/bridge.ts');
const { PluginHost } = await import('../src/plugins/host.ts');
const { startWeb } = await import('../src/web/server.ts');

const mock = new MockOneBot({ wsPort: 13101, httpPort: 13100, token: 'mock' });
await mock.start();

const config = ConfigSchema.parse({
  onebot: { wsUrl: 'ws://127.0.0.1:13101', httpUrl: 'http://127.0.0.1:13100', accessToken: 'mock', autoDiscover: false },
  server: { port: Number(process.env.PORT ?? 3299), consolePassword: 'demo1234', sessionSecret: 'demo' },
  dataDir: path.join(dir, 'data'),
  agents: { tokens: [{ name: 'demo-agent', token: 'qab_demo', tiers: ['read', 'send', 'manage', 'danger'] }] },
});
const bridge = new Bridge(config);
const plugins = new PluginHost(bridge);
await startWeb(bridge, plugins);
await bridge.connect();
await plugins.loadAll();

const lines = ['今天吃什么', '有人打游戏吗', '哈哈哈哈', '这个 bug 修好了没', '早安', '晚上开黑'];
let i = 0;
setInterval(() => {
  const n = i++;
  if (n % 4 === 3) mock.pushGroupMessage(111, 20001, [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ' 机器人你怎么看？' } }]);
  else if (n % 5 === 4) mock.pushGroupMessage(111, 20002, [{ type: 'image', data: { file: `demo${n}.png`, url: '' } }]);
  else if (n % 6 === 5) mock.pushPrivateMessage(20001, [{ type: 'text', data: { text: '私聊：在吗？' } }, { type: 'face', data: { id: '179' } }]);
  else mock.pushGroupMessage(n % 2 ? 111 : 222, 20000 + (n % 3) + 1, [{ type: 'text', data: { text: lines[n % lines.length] } }]);
}, Number(process.env.DEMO_INTERVAL ?? 8000));
void PNG_1PX;
console.log(`\n演示模式已启动：http://127.0.0.1:${config.server.port}  密码 demo1234   MCP token: qab_demo\n`);
