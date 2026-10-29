import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';
import type { Bridge } from '../bridge.ts';
import type { PluginHost, PluginState } from './host.ts';
import type { MessageEvent } from './api.ts';
import { parseConv, type Segment } from '../message/segments.ts';
import { ROOT, resolveFromRoot } from '../config.ts';
import { createLogger } from '../util/log.ts';
import { extraTools, notifyToolsChanged } from '../mcp/server.ts';
import type { ToolDef } from '../mcp/tools.ts';
import type { Caller } from '../policy.ts';

const log = createLogger('astrbot');

interface PyPluginInfo {
  dir: string; name: string; display_name?: string; desc?: string; version?: string; author?: string; error?: string | null;
  commands: { names: string[]; desc: string }[];
  tools: { name: string; description: string; params: { properties: Record<string, { type: string; description: string }>; required: string[] } }[];
  schema?: Record<string, any> | null; config?: Record<string, any>;
}

/**
 * AstrBot 插件轻兼容层：用 Python 子进程加载 astrbot_plugins/ 下的插件，
 * 提供 astrbot.api 常用子集（Star/Context/filter/AstrMessageEvent/消息组件/llm_tool/配置）。
 * 插件的 llm_tool 映射为 MCP 工具；重载 = 重启子进程。
 */
export class AstrBotHost {
  private proc?: ChildProcessWithoutNullStreams;
  private seq = 0;
  private waiters = new Map<number, (msg: any) => void>();
  private names: string[] = [];
  private tools: string[] = [];
  private caller: Caller = { kind: 'plugin', name: 'plugin:astrbot' };

  constructor(private bridge: Bridge, private host: PluginHost) {}

  get dir() { return resolveFromRoot(this.bridge.config.plugins.astrbot.dir); }

  async start() {
    fs.mkdirSync(this.dir, { recursive: true });
    const py = this.bridge.config.plugins.astrbot.python || 'python';
    const proc = spawn(py, ['-u', path.join(ROOT, 'astrbot_shim', 'host.py')], {
      cwd: this.dir, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    this.proc = proc;
    const ready = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('AstrBot 宿主启动超时')), 60_000);
      proc.once('error', (e) => { clearTimeout(t); reject(new Error(`无法启动 Python（${py}）：${e.message}`)); });
      this.waiters.set(0, (msg) => { clearTimeout(t); this.onReady(msg.plugins); resolve(); });
    });
    readline.createInterface({ input: proc.stderr }).on('line', (l) => log.info(l));
    readline.createInterface({ input: proc.stdout }).on('line', (l) => this.onLine(l));
    proc.on('exit', (code) => {
      if (this.proc === proc) { log.warn(`AstrBot 宿主进程退出（code ${code}）`); this.proc = undefined; this.clear(); }
    });
    this.write({
      type: 'init',
      plugins_dir: this.dir,
      disabled: Object.entries(this.bridge.config.plugins.overrides).filter(([k, v]) => k.startsWith('astrbot-') && !v).map(([k]) => k.slice(8)),
      settings: {
        wake_prefix: this.bridge.config.plugins.commandPrefixes,
        admins: this.bridge.config.owners,
        self_id: this.bridge.self?.userId ?? '',
        data_dir: this.bridge.dataDir,
      },
    });
    await ready;
    this.host.external = this.host.external.filter((x) => x.name !== 'astrbot');
    this.host.external.push({ name: 'astrbot', dispatch: (e) => this.dispatch(e) });
  }

  async stop() {
    const p = this.proc;
    if (!p) return;
    this.write({ type: 'shutdown' });
    this.proc = undefined;
    setTimeout(() => p.kill(), 3000).unref();
    this.clear();
  }

  async restart() { await this.stop(); await this.start(); }

  private clear() {
    for (const t of this.tools) extraTools.delete(t);
    if (this.tools.length) notifyToolsChanged();
    this.tools = [];
    for (const n of this.names) { const st = this.host.plugins.get(n); if (st) st.loaded = false; }
    this.host.emit('changed');
  }

  private write(msg: unknown) { this.proc?.stdin.write(`${JSON.stringify(msg)}\n`); }

  private request(msg: Record<string, unknown>, timeoutMs = 120_000): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiters.delete(id); reject(new Error('AstrBot 插件响应超时')); }, timeoutMs);
      this.waiters.set(id, (m) => { clearTimeout(t); resolve(m); });
      this.write({ ...msg, id });
    });
  }

  private onLine(line: string) {
    let msg: any;
    try { msg = JSON.parse(line); } catch { log.info(line); return; }
    if (msg.type === 'ready') { this.waiters.get(0)?.(msg); this.waiters.delete(0); return; }
    if (msg.type === 'event_done' || msg.type === 'tool_result') { this.waiters.get(msg.id)?.(msg); this.waiters.delete(msg.id); return; }
    if (msg.type === 'rpc') void this.handleRpc(msg);
  }

  private async handleRpc(msg: { id: number; method: string; params: any }) {
    try {
      let result: unknown = null;
      if (msg.method === 'send') result = await this.send(msg.params.conv, msg.params.segments);
      else if (msg.method === 'call_action') result = await this.bridge.callAction(this.caller, msg.params.action, msg.params.params ?? {});
      else if (msg.method === 'react') {
        const emoji = String(msg.params.emoji);
        const id = this.bridge.faces.resolve(emoji) ?? [...emoji][0]?.codePointAt(0);
        result = await this.bridge.bot.call('set_msg_emoji_like', { message_id: Number(msg.params.message_id), emoji_id: String(id), set: true });
      } else throw new Error(`未知方法 ${msg.method}`);
      this.write({ type: 'rpc_result', id: msg.id, result: result ?? null });
    } catch (e: any) {
      this.write({ type: 'rpc_result', id: msg.id, error: e?.message ?? String(e) });
    }
  }

  /** 把 Python 侧构造的段转换为可发送的段（本地路径、上传、合并转发、戳一戳）。 */
  private async send(conv: string, segs: Segment[]) {
    if (!conv) throw new Error('没有目标会话（llm_tool 调用时请传 conv 参数）');
    const c = parseConv(conv);
    const out: Segment[] = [];
    for (const s of segs) {
      if (s.type === '__upload') { await this.bridge.uploadFile(c, String(s.data.file).replace(/^file:\/\/\/?/, ''), s.data.name); continue; }
      if (s.type === '__poke') { await this.bridge.bot.call('send_poke', c.type === 'group' ? { group_id: Number(c.id), user_id: Number(s.data.qq) } : { user_id: Number(c.id) }); continue; }
      if (s.type === '__forward') {
        await this.bridge.bot.call(c.type === 'group' ? 'send_group_forward_msg' : 'send_private_forward_msg', { [c.type === 'group' ? 'group_id' : 'user_id']: Number(c.id), messages: s.data.nodes });
        continue;
      }
      if (['image', 'record', 'video'].includes(s.type) && typeof s.data.file === 'string' && !/^(https?|base64):\/\//.test(s.data.file)) {
        out.push({ type: s.type, data: { ...s.data, file: await this.bridge.media.toOneBotFile(s.data.file) } });
      } else out.push(s);
    }
    if (!out.length) return { message_ids: [] };
    return { message_ids: (await this.bridge.send(this.caller, c, out)).messageIds };
  }

  private onReady(plugins: PyPluginInfo[]) {
    this.names = [];
    for (const p of plugins) {
      const name = `astrbot-${p.dir}`;
      this.names.push(name);
      const st: PluginState = {
        name, dir: path.join(this.dir, p.dir),
        manifest: { name, displayName: p.display_name || p.name, version: p.version, description: p.desc, author: p.author },
        enabled: this.bridge.config.plugins.overrides[name] ?? true, loaded: !p.error, error: p.error ?? undefined,
        handlers: [], noticeHandlers: [], requestHandlers: [], tools: [], crons: [], unloaders: [], routes: [],
        schema: p.schema ?? undefined, config: p.config ?? {}, kind: 'astrbot', calls: 0, provides: [], depends: [],
        ops: { reload: () => this.restart(), setEnabled: () => this.restart() },
        commandList: p.commands,
      };
      if (!st.enabled) st.loaded = false;
      for (const t of p.tools) {
        const toolName = `astrbot_${p.dir}_${t.name}`.replace(/[^a-zA-Z0-9_-]/g, '_');
        const shape: Record<string, z.ZodTypeAny> = {};
        for (const [k, v] of Object.entries(t.params.properties)) {
          let zt: z.ZodTypeAny = v.type === 'number' || v.type === 'integer' ? z.number() : v.type === 'boolean' ? z.boolean() : v.type === 'object' ? z.record(z.string(), z.any()) : v.type === 'array' ? z.array(z.any()) : z.string();
          zt = zt.describe(v.description);
          shape[k] = t.params.required.includes(k) ? zt : zt.optional();
        }
        shape.conv = z.string().optional().describe('插件需要发消息时的目标会话 group:xxx / private:xxx');
        const def: ToolDef = {
          name: toolName, title: t.name, tier: 'send', input: shape,
          description: `［AstrBot 插件 ${p.display_name || p.name}］${t.description}`,
          handler: async (_ctx, args) => {
            const { conv, ...rest } = args;
            const r = await this.request({ type: 'tool_call', plugin: p.dir, name: t.name, args: { ...rest, __conv: conv ?? '' } });
            if (r.error) throw new Error(r.error);
            return String(r.result);
          },
        };
        extraTools.set(toolName, def);
        this.tools.push(toolName);
        st.tools.push(toolName);
      }
      this.host.plugins.set(name, st);
    }
    if (this.tools.length) notifyToolsChanged();
    log.info(`AstrBot 插件：${plugins.map((p) => `${p.name}${p.error ? '(失败)' : ''}`).join('、') || '无'}`);
    this.host.emit('changed');
  }

  private async dispatch(e: MessageEvent) {
    if (!this.proc) return;
    const r = await this.request({
      type: 'event',
      event: { conv: e.conv, msgId: e.msgId, senderId: e.senderId, senderName: e.senderName, isGroup: e.isGroup, groupId: e.groupId, text: e.text, segments: e.segments, mentioned: e.mentioned, ts: e.ts },
    }).catch((err) => { log.warn(err.message); return { stopped: false }; });
    if (r.stopped) e.stop();
  }
}
