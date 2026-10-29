import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { Cron } from 'croner';
import type { Bridge } from '../bridge.ts';
import type { StoredMessage } from '../store/db.ts';
import { parseConv, plainText } from '../message/segments.ts';
import { resolveFromRoot } from '../config.ts';
import { createLogger, type Logger } from '../util/log.ts';
import { atomicWrite } from '../util/fs.ts';
import type { Caller } from '../policy.ts';
import { extraTools, notifyToolsChanged } from '../mcp/server.ts';
import type { ToolDef } from '../mcp/tools.ts';
import type { CommandOptions, Handler, HandlerOptions, MessageEvent, PluginContext, PluginManifest, PluginModule, PluginToolDef } from './api.ts';

const log = createLogger('plugins');

interface Registered {
  kind: 'command' | 'regex' | 'message';
  names?: string[];
  re?: RegExp;
  handler: Handler;
  opts: HandlerOptions;
}

export interface PluginState {
  name: string;
  dir: string;
  manifest: PluginManifest;
  enabled: boolean;
  loaded: boolean;
  error?: string;
  handlers: Registered[];
  noticeHandlers: { type: string; fn: (ev: any) => unknown }[];
  requestHandlers: ((r: any) => unknown)[];
  tools: string[];
  crons: Cron[];
  unloaders: (() => unknown)[];
  schema?: Record<string, any>;
  config: Record<string, any>;
  kind: 'native' | 'astrbot';
  calls: number;
  lastError?: string;
}

/** 可被外部（如 AstrBot 兼容层）注册的"虚拟插件"分发器。 */
export interface ExternalDispatcher {
  name: string;
  dispatch(e: MessageEvent): Promise<void>;
}

export class PluginHost extends EventEmitter {
  plugins = new Map<string, PluginState>();
  external: ExternalDispatcher[] = [];
  private dir: string;

  constructor(private bridge: Bridge) {
    super();
    this.dir = resolveFromRoot(bridge.config.plugins.dir);
    bridge.on('message', (m: StoredMessage, raw: any) => { if (!m.isSelf) this.dispatch(m, raw).catch((e) => log.error('分发消息出错', e)); });
    bridge.on('notice', (ev) => this.dispatchNotice(ev));
    bridge.on('request', (r) => this.dispatchRequest(r));
  }

  // ------------------------------------------------------------------ 加载
  scan(): { name: string; dir: string; manifest: PluginManifest }[] {
    if (!fs.existsSync(this.dir)) return [];
    const out = [];
    for (const e of fs.readdirSync(this.dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name.startsWith('_')) continue;
      const dir = path.join(this.dir, e.name);
      const mf = path.join(dir, 'plugin.json');
      if (!fs.existsSync(mf)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(mf, 'utf8')) as PluginManifest;
        out.push({ name: manifest.name || e.name, dir, manifest });
      } catch (err: any) { log.warn(`插件 ${e.name} 的 plugin.json 无效：${err.message}`); }
    }
    return out;
  }

  async loadAll() {
    for (const p of this.scan()) {
      const enabled = !this.bridge.config.plugins.disabled.includes(p.name);
      if (enabled) await this.load(p.name, p.dir, p.manifest);
      else this.plugins.set(p.name, this.blank(p.name, p.dir, p.manifest, false));
    }
    log.info(`插件：${[...this.plugins.values()].filter((p) => p.loaded).map((p) => p.name).join('、') || '无'}`);
    this.emit('changed');
  }

  private blank(name: string, dir: string, manifest: PluginManifest, enabled: boolean): PluginState {
    const schemaFile = path.join(dir, 'config.schema.json');
    let schema: Record<string, any> | undefined;
    try { if (fs.existsSync(schemaFile)) schema = JSON.parse(fs.readFileSync(schemaFile, 'utf8')); } catch { /* ignore */ }
    return { name, dir, manifest, enabled, loaded: false, handlers: [], noticeHandlers: [], requestHandlers: [], tools: [], crons: [], unloaders: [], schema, config: this.readConfig(name, schema), kind: 'native', calls: 0 };
  }

  private dataDirOf(name: string) { const d = path.join(this.bridge.dataDir, 'plugins', name); fs.mkdirSync(d, { recursive: true }); return d; }

  readConfig(name: string, schema?: Record<string, any>) {
    const defaults: Record<string, any> = {};
    for (const [k, v] of Object.entries(schema ?? {})) if (v && typeof v === 'object' && 'default' in v) defaults[k] = (v as any).default;
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(path.join(this.dataDirOf(name), 'config.json'), 'utf8')); } catch { /* none */ }
    return { ...defaults, ...saved };
  }

  saveConfig(name: string, cfg: Record<string, any>) {
    atomicWrite(path.join(this.dataDirOf(name), 'config.json'), JSON.stringify(cfg, null, 2));
    const p = this.plugins.get(name);
    if (p) p.config = cfg;
  }

  async load(name: string, dir: string, manifest: PluginManifest) {
    const st = this.blank(name, dir, manifest, true);
    this.plugins.set(name, st);
    const main = manifest.main ?? ['index.ts', 'index.mjs', 'index.js'].find((f) => fs.existsSync(path.join(dir, f)));
    if (!main) { st.error = '缺少入口文件 index.ts/index.js'; return; }
    try {
      const url = `${pathToFileURL(path.join(dir, main)).href}?v=${Date.now()}`;
      const mod = await import(url);
      const plugin: PluginModule = mod.default ?? mod;
      if (typeof plugin.setup !== 'function') throw new Error('入口未导出 setup()（使用 export default definePlugin({ setup(ctx) {...} })）');
      await plugin.setup(this.makeContext(st));
      st.loaded = true;
      log.info(`已加载插件 ${name}${manifest.version ? ` v${manifest.version}` : ''}`);
    } catch (e: any) {
      st.error = e?.message ?? String(e);
      log.error(`加载插件 ${name} 失败：${st.error}`);
      await this.teardown(st);
    }
    this.emit('changed');
  }

  private async teardown(st: PluginState) {
    for (const c of st.crons) c.stop();
    for (const fn of st.unloaders) { try { await fn(); } catch (e: any) { log.warn(`${st.name} 卸载回调出错：${e.message}`); } }
    for (const t of st.tools) extraTools.delete(t);
    if (st.tools.length) notifyToolsChanged();
    st.handlers = []; st.noticeHandlers = []; st.requestHandlers = []; st.tools = []; st.crons = []; st.unloaders = [];
    st.loaded = false;
  }

  async unload(name: string) {
    const st = this.plugins.get(name);
    if (st) await this.teardown(st);
    this.emit('changed');
  }

  async reload(name: string) {
    const st = this.plugins.get(name);
    if (!st) throw new Error(`插件 ${name} 不存在`);
    if (st.kind !== 'native') throw new Error('该插件由兼容层管理，请在兼容层中重载');
    await this.teardown(st);
    const fresh = this.scan().find((p) => p.name === name);
    if (!fresh) { this.plugins.delete(name); this.emit('changed'); return; }
    await this.load(name, fresh.dir, fresh.manifest);
  }

  async setEnabled(name: string, enabled: boolean) {
    const cfg = structuredClone(this.bridge.config);
    cfg.plugins.disabled = cfg.plugins.disabled.filter((n) => n !== name);
    if (!enabled) cfg.plugins.disabled.push(name);
    this.bridge.updateConfig(cfg);
    const st = this.plugins.get(name);
    if (!st) return;
    if (enabled && !st.loaded) await this.load(name, st.dir, st.manifest);
    if (!enabled) { await this.teardown(st); st.enabled = false; }
    this.emit('changed');
  }

  list() {
    return [...this.plugins.values()].map((p) => ({
      name: p.name, displayName: p.manifest.displayName ?? p.name, version: p.manifest.version ?? '', description: p.manifest.description ?? '',
      author: p.manifest.author ?? '', enabled: p.enabled, loaded: p.loaded, error: p.error, kind: p.kind, calls: p.calls, lastError: p.lastError,
      commands: p.handlers.filter((h) => h.kind === 'command').map((h) => ({ names: h.names, desc: h.opts.desc ?? '' })),
      handlers: p.handlers.length, tools: p.tools, crons: p.crons.length, schema: p.schema, config: p.config,
    }));
  }

  // ------------------------------------------------------------------ 上下文
  private makeContext(st: PluginState): PluginContext {
    const bridge = this.bridge;
    const caller: Caller = { kind: 'plugin', name: `plugin:${st.name}` };
    const logger: Logger = createLogger(`plugin:${st.name}`);
    const host = this;
    return {
      name: st.name,
      logger,
      dataDir: this.dataDirOf(st.name),
      get config() { return st.config; },
      set config(v) { st.config = v; },
      saveConfig: () => host.saveConfig(st.name, st.config),
      kv: { get: (k) => bridge.store.kvGet(`plugin:${st.name}`, k) as any, set: (k, v) => bridge.store.kvSet(`plugin:${st.name}`, k, v) },
      qq: {
        send: async (conv, content, opts) => (await bridge.send(caller, conv, content, opts)).messageIds,
        call: (action, params = {}) => bridge.callAction(caller, action, params),
        get selfId() { return bridge.self?.userId; },
      },
      bridge,
      command(name, handler, opts: CommandOptions = {}) {
        const names = (Array.isArray(name) ? name : [name]).concat(opts.aliases ?? []);
        st.handlers.push({ kind: 'command', names, handler, opts });
      },
      onRegex(re, handler, opts = {}) { st.handlers.push({ kind: 'regex', re, handler, opts }); },
      onMessage(handler, opts = {}) { st.handlers.push({ kind: 'message', handler, opts }); },
      onNotice(type, fn) { st.noticeHandlers.push({ type, fn }); },
      onRequest(fn) { st.requestHandlers.push(fn); },
      tool(def: PluginToolDef<any>) {
        const name = def.name.startsWith(`${st.name}_`) || def.name.startsWith('qq_') ? def.name : `${st.name}_${def.name}`.replace(/[^a-zA-Z0-9_-]/g, '_');
        const td: ToolDef = {
          name, title: def.title ?? name, description: `［插件 ${st.name}］${def.description}`, tier: def.tier ?? 'send', input: def.input,
          handler: async (_ctx, args) => def.handler(args),
        };
        extraTools.set(name, td);
        st.tools.push(name);
        notifyToolsChanged();
      },
      schedule(cron, fn) {
        st.crons.push(new Cron(cron, { protect: true, catch: (e: any) => logger.error(`定时任务出错：${e?.message ?? e}`) }, async () => { await fn(); }));
      },
      onUnload(fn) { st.unloaders.push(fn); },
      listCommands: () => host.list().flatMap((p) => p.commands.map((c) => ({ plugin: p.name, names: c.names ?? [], desc: c.desc }))),
    };
  }

  // ------------------------------------------------------------------ 分发
  private buildEvent(m: StoredMessage, raw: any): MessageEvent {
    const bridge = this.bridge;
    const convRef = parseConv(m.conv);
    let stopped = false;
    const caller: Caller = { kind: 'plugin', name: 'plugin' };
    // 去掉开头的 @我 与回复段，得到"指令文本"
    const segs = m.segments.filter((s, i) => !(s.type === 'reply') && !(i <= 1 && s.type === 'at' && String(s.data.qq) === bridge.self?.userId));
    const text = plainText(segs).trim();
    const e: MessageEvent = {
      conv: m.conv, convRef, msgId: m.msgId, senderId: m.senderId, senderName: m.senderName,
      isGroup: convRef.type === 'group', groupId: convRef.type === 'group' ? convRef.id : undefined,
      text, rendered: m.text, segments: m.segments, mentioned: m.mentioned, ts: m.ts,
      isOwner: bridge.config.owners.includes(m.senderId), args: [], argText: '', raw,
      reply: async (content, opts) => { await bridge.send(caller, m.conv, content, { replyTo: m.msgId, atSender: opts?.at ? m.senderId : undefined }); },
      send: async (content, opts) => { await bridge.send(caller, m.conv, content, opts); },
      react: async (emoji) => {
        const id = bridge.faces.resolve(emoji) ?? [...emoji][0]?.codePointAt(0);
        await bridge.bot.call('set_msg_emoji_like', { message_id: Number(m.msgId), emoji_id: String(id), set: true });
      },
      stop: () => { stopped = true; },
      get stopped() { return stopped; },
    };
    return e;
  }

  async dispatch(m: StoredMessage, raw: any) {
    if (!this.bridge.policy.convAllowed(parseConv(m.conv))) return;
    const base = this.buildEvent(m, raw);
    const entries: { st: PluginState; h: Registered }[] = [];
    for (const st of this.plugins.values()) if (st.loaded) for (const h of st.handlers) entries.push({ st, h });
    entries.sort((a, b) => (b.h.opts.priority ?? 0) - (a.h.opts.priority ?? 0));
    const prefixes = this.bridge.config.plugins.commandPrefixes;

    for (const { st, h } of entries) {
      if (base.stopped) return;
      const o = h.opts;
      if (o.scope === 'group' && !base.isGroup) continue;
      if (o.scope === 'private' && base.isGroup) continue;
      if (o.ownerOnly && !base.isOwner) continue;
      if (o.requireMention && base.isGroup && !base.mentioned) continue;
      const e: MessageEvent = Object.create(base);
      if (h.kind === 'command') {
        const hit = matchCommand(base.text, h.names!, prefixes, base.mentioned || !base.isGroup);
        if (!hit) continue;
        Object.defineProperty(e, 'argText', { value: hit.argText });
        Object.defineProperty(e, 'args', { value: hit.argText ? hit.argText.split(/\s+/) : [] });
      } else if (h.kind === 'regex') {
        const mm = base.text.match(h.re!);
        if (!mm) continue;
        Object.defineProperty(e, 'match', { value: mm });
      }
      st.calls++;
      try {
        await h.handler(e);
      } catch (err: any) {
        st.lastError = `${new Date().toLocaleString('zh-CN')} ${err?.message ?? err}`;
        log.error(`插件 ${st.name} 处理消息出错：${err?.message ?? err}`);
      }
    }
    for (const ext of this.external) {
      if (base.stopped) return;
      try { await ext.dispatch(base); } catch (err: any) { log.error(`${ext.name} 处理消息出错：${err?.message ?? err}`); }
    }
  }

  private dispatchNotice(ev: any) {
    for (const st of this.plugins.values()) if (st.loaded) for (const h of st.noticeHandlers) {
      const type = ev.notice_type === 'notify' ? ev.sub_type : ev.notice_type;
      if (h.type === '*' || h.type === type || h.type === ev.notice_type) Promise.resolve().then(() => h.fn(ev)).catch((e) => log.error(`插件 ${st.name} 处理通知出错：${e?.message ?? e}`));
    }
  }

  private dispatchRequest(r: any) {
    for (const st of this.plugins.values()) if (st.loaded) for (const fn of st.requestHandlers) Promise.resolve().then(() => fn(r)).catch((e) => log.error(`插件 ${st.name} 处理请求出错：${e?.message ?? e}`));
  }
}

/** 命令匹配：带前缀（/ #）任意场景可触发；被 @ 或私聊时也允许不带前缀。 */
export function matchCommand(text: string, names: string[], prefixes: string[], allowBare: boolean): { name: string; argText: string } | null {
  const t = text.trim();
  for (const p of ['', ...prefixes]) {
    if (p === '' && !allowBare) continue;
    if (p && !t.startsWith(p)) continue;
    const body = t.slice(p.length);
    for (const n of names.sort((a, b) => b.length - a.length)) {
      if (body === n) return { name: n, argText: '' };
      if (body.startsWith(n) && /\s/.test(body[n.length] ?? '')) return { name: n, argText: body.slice(n.length).trim() };
    }
  }
  return null;
}
