import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema, ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from '../config.ts';
import { logHub, createLogger } from '../util/log.ts';

const log = createLogger('mcp-stdio');

/**
 * stdio MCP 入口。
 * 优先作为轻量代理连接正在运行的 qab 守护进程（多个 agent 共享一条 QQ 连接、统一审计/审批）；
 * 守护进程不在时，自动在本进程内启动一个独立桥接（standalone）。
 */
export async function runStdio(opts: { token?: string; url?: string; standalone?: boolean } = {}) {
  logHub.stream = process.stderr; // stdout 归 MCP 协议
  const { config } = loadConfig();
  const token = opts.token || process.env.QAB_TOKEN || config.agents.tokens.find((t) => t.enabled)?.token || '';
  const url = opts.url || process.env.QAB_URL || `http://${config.server.host === '0.0.0.0' ? '127.0.0.1' : config.server.host}:${config.server.port}/mcp`;

  if (!opts.standalone) {
    const client = new Client({ name: 'qab-stdio-proxy', version: '0.1.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      log.info(`已连接守护进程 ${url}，以代理模式运行`);
      await proxy(client);
      return;
    } catch (e: any) {
      log.warn(`无法连接守护进程（${e?.message ?? e}），改为独立模式运行`);
    }
  }
  await standalone(token);
}

async function proxy(client: Client) {
  const info = client.getServerVersion();
  const server = new Server(
    { name: info?.name ?? 'qq-agent-bridge', version: info?.version ?? '0.1.0' },
    { capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} }, instructions: client.getInstructions() },
  );
  server.setRequestHandler(ListToolsRequestSchema, (r) => client.listTools(r.params));
  server.setRequestHandler(CallToolRequestSchema, (r) => client.callTool(r.params, undefined, { timeout: 35 * 60_000, resetTimeoutOnProgress: true }) as any);
  server.setRequestHandler(ListResourcesRequestSchema, (r) => client.listResources(r.params));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, (r) => client.listResourceTemplates(r.params));
  server.setRequestHandler(ReadResourceRequestSchema, (r) => client.readResource(r.params));
  server.setRequestHandler(ListPromptsRequestSchema, (r) => client.listPrompts(r.params));
  server.setRequestHandler(GetPromptRequestSchema, (r) => client.getPrompt(r.params));
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => server.sendToolListChanged());
  await server.connect(new StdioServerTransport());
}

async function standalone(tokenStr: string) {
  const { Bridge } = await import('../bridge.ts');
  const { createMcpServer } = await import('./server.ts');
  const { PluginHost } = await import('../plugins/host.ts');
  const bridge = new Bridge();
  const token = bridge.policy.findToken(tokenStr) ?? bridge.config.agents.tokens.find((t) => t.enabled);
  if (!token) throw new Error('配置中没有可用的 agent token');
  await bridge.start();
  const plugins = new PluginHost(bridge);
  await plugins.loadAll();
  const server = createMcpServer(bridge, { kind: 'agent', name: `${token.name}(stdio)`, token });
  await server.connect(new StdioServerTransport());
}
