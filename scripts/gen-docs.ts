/**
 * 生成 docs/tools.md（全部 MCP 工具）与 docs/system-plugins.md（系统插件命令/配置/工具）。
 * 运行：npm run docs:gen   （在 Mock OneBot 上加载全部插件后导出，保证文档与代码一致）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qab-docs-'));
process.env.QAB_CONFIG = path.join(tmp, 'qab.yaml');
process.env.QAB_LOG_LEVEL = 'error';

const { MockOneBot } = await import('../test/mock-onebot.ts');
const { ConfigSchema, ROOT } = await import('../src/config.ts');
const { Bridge } = await import('../src/bridge.ts');
const { PluginHost } = await import('../src/plugins/host.ts');
const { buildTools, DSL_HELP } = await import('../src/mcp/tools.ts');
const { extraTools } = await import('../src/mcp/server.ts');

const mock = new MockOneBot({ wsPort: 25001, httpPort: 25000, token: '' });
await mock.start();
const overrides = Object.fromEntries(fs.readdirSync(path.join(ROOT, 'src', 'system-plugins')).map((n) => [n, true]));
const bridge = new Bridge(ConfigSchema.parse({
  onebot: { wsUrl: 'ws://127.0.0.1:25001', httpUrl: 'http://127.0.0.1:25000', autoDiscover: false },
  server: { port: 25210, consolePassword: 'x', sessionSecret: 'x' },
  dataDir: path.join(tmp, 'data'),
  plugins: { dir: path.join(tmp, 'none'), overrides, hotReload: false },
}));
const host = new PluginHost(bridge);
await host.loadAll();

const TIER: Record<string, string> = { read: '读取', send: '发送', manage: '管理', danger: '高危' };
function params(shape: z.ZodRawShape): string {
  const js: any = z.toJSONSchema(z.object(shape), { io: 'input', unrepresentable: 'any' });
  const req = new Set(js.required ?? []);
  const rows = Object.entries<any>(js.properties ?? {}).map(([k, v]) => {
    const type = v.enum ? v.enum.map((x: any) => `\`${x}\``).join(' \\| ') : v.type === 'array' ? `${v.items?.type ?? 'any'}[]` : Array.isArray(v.anyOf) ? v.anyOf.map((x: any) => x.type).join('\\|') : v.type ?? 'any';
    const def = v.default !== undefined ? ` 默认 \`${JSON.stringify(v.default)}\`` : '';
    return `| \`${k}\` | ${type} | ${req.has(k) && v.default === undefined ? '是' : ''} | ${(v.description ?? '').replace(/\|/g, '\\|')}${def} |`;
  });
  return rows.length ? `| 参数 | 类型 | 必填 | 说明 |\n|---|---|---|---|\n${rows.join('\n')}` : '无参数';
}

const core = buildTools();
const pluginTools = [...extraTools.values()];
const ownerOf = (name: string) => [...host.plugins.values()].find((p) => p.tools.includes(name))?.name;
const section = (t: any) => `### \`${t.name}\` — ${t.title}\n\n等级：**${TIER[t.tier]}**${t.readOnly ? '（只读）' : ''}${ownerOf(t.name) ? `　来源插件：\`${ownerOf(t.name)}\`` : ''}\n\n${t.description}\n\n${params(t.input)}\n`;

const toolsMd = `# MCP 工具参考

> 本文件由 \`npm run docs:gen\` 自动生成，请勿手改。共 ${core.length + pluginTools.length} 个工具（核心 ${core.length}，系统插件 ${pluginTools.length}）。

Agent 只会看到其 token 权限等级内、且未在控制台禁用的工具。等级说明见 [agent-guide.md](agent-guide.md)。

## 消息内联标记

\`\`\`
${DSL_HELP}
\`\`\`

## 核心工具

${core.map(section).join('\n')}
## 系统插件工具

${pluginTools.map(section).join('\n')}`;

const plugins = host.list().filter((p) => p.system);
const pluginsMd = `# 系统插件参考

> 本文件由 \`npm run docs:gen\` 自动生成，请勿手改。

系统插件随程序发布，位于 \`src/system-plugins/\`，可在控制台「插件」页开关与配置；标注「默认关闭」的需手动开启。

${plugins.map((p) => {
  const st = host.plugins.get(p.name)!;
  const defOff = (host as any).defs.get(p.name)?.def.defaultEnabled === false;
  const cfg = Object.entries<any>(p.schema ?? {});
  return `## ${p.displayName}（\`${p.name}\`）${defOff ? ' · 默认关闭' : ''}

${p.description}
${p.depends.length ? `\n依赖：${p.depends.join('、')}\n` : ''}
${p.commands.length ? `**命令**\n\n${p.commands.map((c: any) => `- \`/${c.names[0]}${c.usage ? ` ${c.usage}` : ''}\`${c.names.length > 1 ? `（别名：${c.names.slice(1).map((n: string) => `/${n}`).join(' ')}）` : ''} — ${c.desc}`).join('\n')}\n` : ''}
${st.tools.length ? `**Agent 工具**：${st.tools.map((t) => `\`${t}\``).join('、')}\n` : ''}
${cfg.length ? `**配置**\n\n| 键 | 类型 | 默认 | 说明 |\n|---|---|---|---|\n${cfg.map(([k, v]) => `| \`${k}\` | ${v.type}${v.options ? `（${v.options.join('/')}）` : ''} | \`${JSON.stringify(v.default)}\` | ${(v.description ?? '').replace(/\|/g, '\\|')} |`).join('\n')}\n` : ''}`;
}).join('\n')}`;

fs.writeFileSync(path.join(ROOT, 'docs', 'tools.md'), toolsMd);
fs.writeFileSync(path.join(ROOT, 'docs', 'system-plugins.md'), pluginsMd);
console.log(`已生成 docs/tools.md（${core.length + pluginTools.length} 个工具）与 docs/system-plugins.md（${plugins.length} 个插件）`);
await bridge.stop();
await mock.stop();
process.exit(0);
