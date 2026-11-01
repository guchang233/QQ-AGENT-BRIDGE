import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfig, resolveFromRoot } from '../config.ts';
import { atomicWrite } from '../util/fs.ts';
import { logHub, createLogger } from '../util/log.ts';

const log = createLogger('mcp-stdio');

/**
 * stdio MCP 入口（DSH、Claude Desktop 等只支持 stdio 的客户端使用）。
 * 默认作为无状态代理：每次工具调用都是一次到守护进程的独立 HTTP 请求（多个 agent 共享一条 QQ 连接、统一审计/审批）；
 * 守护进程不在且没有缓存的工具列表时，在本进程内启动一个独立桥接（standalone）。
 */
export async function runStdio(opts: { token?: string; url?: string; standalone?: boolean } = {}) {
  logHub.stream = process.stderr; // stdout 归 MCP 协议
  const { config } = loadConfig();
  const token = opts.token || process.env.QAB_TOKEN || config.agents.tokens.find((t) => t.enabled)?.token || '';
  const url = opts.url || process.env.QAB_URL || `http://${config.server.host === '0.0.0.0' ? '127.0.0.1' : config.server.host}:${config.server.port}/mcp`;

  if (!opts.standalone) {
    const base = url.replace(/\/mcp\/?$/, '');
    const cache = path.join(resolveFromRoot(config.dataDir), `mcp-tools-${createHash('sha1').update(token).digest('hex').slice(0, 8)}.json`);
    let first = await fetchTools(base, token, 5).catch(() => null);
    if (first) atomicWrite(cache, JSON.stringify(first));
    else {
      try { first = JSON.parse(fs.readFileSync(cache, 'utf8')); log.warn('守护进程暂不可用，使用缓存的工具列表'); } catch { first = null; }
    }
    if (first) { await statelessProxy(base, token, cache, first); return; }
    log.warn('无法连接守护进程且没有缓存，改为独立模式运行');
  }
  await standalone(token);
}

/** 用 node:http 发请求（undici 的 fetch 有 300 秒头部超时，qq_wait_messages 长轮询会被它掐断）。 */
function httpJson(urlStr: string, opt: { method: string; token: string; body?: unknown; timeoutMs: number }): Promise<any> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = opt.body === undefined ? undefined : Buffer.from(JSON.stringify(opt.body));
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: opt.method,
      headers: { authorization: `Bearer ${opt.token}`, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try { json = JSON.parse(text); } catch { /* ignore */ }
        if ((res.statusCode ?? 500) >= 400) reject(new Error(json?.error ?? `HTTP ${res.statusCode}`));
        else resolve(json);
      });
    });
    req.setTimeout(opt.timeoutMs, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function fetchTools(base: string, token: string, attempts: number): Promise<{ instructions: string; tools: any[] }> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await httpJson(`${base}/api/agent/tools`, { method: 'GET', token, timeoutMs: 10_000 }); } catch (e) { last = e; if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1000)); }
  }
  throw last;
}

/**
 * 无状态代理（与 qq-bridge 的 MCP 相同的思路）：每次工具调用都是一次独立的 HTTP 请求，
 * 不持有任何到守护进程的会话，守护进程重启、换端口前后都不影响 DSH 侧的 MCP 进程。
 */
async function statelessProxy(base: string, token: string, cache: string, initial: { instructions: string; tools: any[] }) {
  let tools = initial.tools;
  const server = new Server(
    { name: 'qq-agent-bridge', version: '0.2.0' },
    { capabilities: { tools: { listChanged: true } }, instructions: initial.instructions },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const r = await fetchTools(base, token, 1);
      tools = r.tools;
      atomicWrite(cache, JSON.stringify(r));
    } catch { /* 守护进程暂不可用：沿用上次的列表 */ }
    return { tools };
  });
  server.setRequestHandler(CallToolRequestSchema, async (r) => {
    const call = () => httpJson(`${base}/api/agent/call`, { method: 'POST', token, body: { name: r.params.name, arguments: r.params.arguments ?? {} }, timeoutMs: 35 * 60_000 });
    try {
      return await call();
    } catch (e: any) {
      // 守护进程正在重启：等一会儿再试一次
      if (/ECONNREFUSED|ECONNRESET|socket hang up/i.test(String(e?.message ?? e))) {
        await new Promise((res) => setTimeout(res, 5000));
        try { return await call(); } catch (e2: any) { e = e2; }
      }
      return { content: [{ type: 'text', text: `错误：无法连接 QQ-Agent Bridge 守护进程（${e?.message ?? e}），操作未执行。请稍后重试。` }], isError: true };
    }
  });
  // 工具列表可能随插件变化：每分钟检查一次，变化时通知客户端
  setInterval(async () => {
    try {
      const r = await fetchTools(base, token, 1);
      if (JSON.stringify(r.tools.map((t: any) => t.name)) !== JSON.stringify(tools.map((t: any) => t.name))) { tools = r.tools; atomicWrite(cache, JSON.stringify(r)); void server.sendToolListChanged(); }
    } catch { /* ignore */ }
  }, 60_000).unref();
  await server.connect(new StdioServerTransport());
}

async function standalone(tokenStr: string) {
  const { Bridge } = await import('../bridge.ts');
  const { createMcpServer } = await import('./server.ts');
  const { PluginHost } = await import('../plugins/host.ts');
  const bridge = new Bridge();
  const token = bridge.policy.findToken(tokenStr) ?? bridge.config.agents.tokens.find((t) => t.enabled);
  if (!token) throw new Error('配置中没有可用的 agent token');
  await bridge.connect();
  const plugins = new PluginHost(bridge);
  await plugins.loadAll();
  const server = createMcpServer(bridge, { kind: 'agent', name: `${token.name}(stdio)`, token });
  await server.connect(new StdioServerTransport());
}
