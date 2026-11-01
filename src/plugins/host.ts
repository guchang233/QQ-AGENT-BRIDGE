import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { Cron } from 'croner';
import type { Bridge } from '../bridge.ts';
import type { StoredMessage } from '../store/db.ts';
import { parseConv, plainText } from '../message/segments.ts';
import { ROOT, resolveFromRoot } from '../config.ts';
import { createLogger } from '../util/log.ts';
import { atomicWrite } from '../util/fs.ts';
import type { Caller } from '../policy.ts';
import { extraTools, notifyToolsChanged } from '../mcp/server.ts';
import type { ToolDef } from '../mcp/tools.ts';
import type {
  CommandOptions, ConfigSchema, Handler, HandlerOptions, MessageEvent, PluginContext, PluginDefinition, PluginMeta, PluginToolDef, RouteRequest, BridgeEventName,
} from './api.ts';

const log = createLogger('plugins');

interface Registered { kind: 'command' | 'regex' | 'message'; names?: string[]; re?: RegExp; handler: Handler; opts: CommandOptions }
export interface PluginRoute { method: string; path: string; handler: (req: RouteRequest) => unknown }

export interface PluginState {
  name: string;
  dir: string;
  entry?: string;
  manifest: PluginMeta;
  system?: boolean;
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
  provides: string[];
  depends: string[];
  routes?: PluginRoute[];
  /** 外部管理的插件（如 AstrBot 兼容层）自定义操作 */
  ops?: { reload(): Promise<void>; setEnabled(v: boolean): Promise<void> };
  commandList?: { names: string[]; desc: string }[];
}

export interface ExternalDispatcher { name: string; dispatch(e: MessageEvent): Promise<void> }

interface Candidate { name: string; dir: string; entry: string; system: boolean; def: PluginDefinition<any>; manifestFile?: PluginMeta }

/**
 * 插件宿主：
 * - 两个来源：src/system-plugins（系统插件，随程序发布）与 plugins/（用户插件，可热重载）
 * - 插件形式：目录（index.ts|js，可选 plugin.json）或单文件 plugins/foo.ts
 * - 依赖解析（depends/softDepends）→ 拓扑顺序加载；服务通过 provide/use 共享
 */
export class PluginHost extends EventEmitter {
  plugins = new Map<string, PluginState>();
  external: ExternalDispatcher[] = [];
  services = new Map<string, unknown>();
  private systemModules = new Map<string, any>();
  private sources: { dir: string; system: boolean }[];
  private watchers: fs.FSWatcher[] = [];
  private reloadTimers = new Map<string, NodeJS.Timeout>();

  constructor(private bridge: Bridge) {
    super();
    this.setMaxListeners(50);
    bridge.pluginHost = this;
    this.sources = [
      { dir: path.join(ROOT, 'src', 'system-plugins'), system: true },
      { dir: resolveFromRoot(bridge.config.plugins.dir), system: false },
    ];
    bridge.on('message', (m: StoredMessage, raw: any) => { if (!m.isSelf) this.dispatch(m, raw).catch((e) => log.error('分发消息出错', e)); });
    bridge.on('notice', (ev) => this.dispatchNotice(ev));
    bridge.on('request', (r) => this.dispatchRequest(r));
  }

  // ==================================================================== 发现
  private async discover(): Promise<Candidate[]> {
    const out: Candidate[] = [];
    for (const src of this.sources) {
      if (!fs.existsSync(src.dir)) continue;
      for (const e of fs.readdirSync(src.dir, { withFileTypes: true })) {
        if (e.name.startsWith('.') || e.name.startsWith('_') || e.name === 'node_modules') continue;
        let entry: string | undefined;
        let dir: string;
        let manifestFile: PluginMeta | undefined;
        if (e.isDirectory()) {
          dir = path.join(src.dir, e.name);
          const mf = path.join(dir, 'plugin.json');
          if (fs.existsSync(mf)) { try { manifestFile = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch (err: any) { log.warn(`${e.name}/plugin.json 无效：${err.message}`); } }
          const main = (manifestFile as any)?.main ?? ['index.ts', 'index.mts', 'index.mjs', 'index.js'].find((f) => fs.existsSync(path.join(dir, f)));
          if (main) entry = path.join(dir, main);
        } else if (/\.(ts|mts|mjs|js)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) {
          dir = src.dir;
          entry = path.join(src.dir, e.name);
        } else continue;
        if (!entry) continue;
        const fallbackName = e.isDirectory() ? e.name : e.name.replace(/\.(ts|mts|mjs|js)$/, '');
        try {
          // 系统插件是程序的一部分，只导入一次。进程运行期间重新导入会让新的入口文件配上缓存里的旧依赖，导入失败
          const cached = src.system ? this.systemModules.get(entry) : undefined;
          const mod = cached ?? await import(`${pathToFileURL(entry).href}?v=${Date.now()}`);
          if (src.system) this.systemModules.set(entry, mod);
          const def: PluginDefinition<any> = mod.default ?? mod;
          if (typeof def?.setup !== 'function') throw new Error('未导出 setup（请 export default definePlugin({...})）');
          const name = def.name ?? manifestFile?.name ?? fallbackName;
          if (out.some((c) => c.name === name)) { log.warn(`插件名重复：${name}（${entry}），已忽略`); continue; }
          out.push({ name, dir, entry, system: src.system, def, manifestFile });
        } catch (err: any) {
          const name = manifestFile?.name ?? fallbackName;
          const st = this.blank(name, dir, entry, src.system, { ...manifestFile, name });
          st.error = `导入失败：${err?.message ?? err}`;
          this.plugins.set(name, st);
          log.error(`导入插件 ${name} 失败：${err?.stack ?? err}`);
        }
      }
    }
    return out;
  }

  isEnabled(name: string, meta: PluginMeta) {
    const p = this.bridge.config.plugins;
    if (name in p.overrides) return p.overrides[name];
    if (p.disabled.includes(name)) return false;
    return meta.defaultEnabled ?? true;
  }

  private blank(name: string, dir: string, entry: string | undefined, system: boolean, meta: PluginMeta): PluginState {
    return {
      name, dir, entry, manifest: { ...meta, name }, system, enabled: this.isEnabled(name, meta), loaded: false,
      handlers: [], noticeHandlers: [], requestHandlers: [], tools: [], crons: [], unloaders: [], routes: [],
      schema: meta.config, config: this.readConfig(name, meta.config), kind: 'native', calls: 0, provides: [], depends: [...(meta.depends ?? [])],
    };
  }

  // ==================================================================== 加载
  private defs = new Map<string, Candidate>();

  async loadAll() {
    for (const st of [...this.plugins.values()]) if (st.kind === 'native') await this.teardown(st);
    for (const [k, v] of this.plugins) if (v.kind === 'native') this.plugins.delete(k);
    this.defs.clear();
    for (const c of await this.discover()) this.defs.set(c.name, c);
    for (const name of this.order([...this.defs.keys()])) await this.loadOne(name);
    log.info(`插件：${[...this.plugins.values()].filter((p) => p.loaded).map((p) => p.name).join('、') || '无'}`);
    this.watch();
    this.emit('changed');
  }

  /** 依赖拓扑排序（循环依赖的插件保持原序并在加载时报错）。 */
  private order(names: string[]): string[] {
    const out: string[] = []; const seen = new Set<string>(); const visiting = new Set<string>();
    const visit = (n: string) => {
      if (seen.has(n) || visiting.has(n)) return;
      visiting.add(n);
      const d = this.defs.get(n)?.def;
      for (const dep of [...(d?.depends ?? []), ...(d?.softDepends ?? [])]) if (this.defs.has(dep)) visit(dep);
      visiting.delete(n); seen.add(n); out.push(n);
    };
    names.forEach(visit);
    return out;
  }

  private async loadOne(name: string) {
    const c = this.defs.get(name);
    if (!c) return;
    const meta: PluginMeta = { ...c.manifestFile, ...c.def, name };
    const st = this.blank(name, c.dir, c.entry, c.system, meta);
    this.plugins.set(name, st);
    if (!st.enabled) return;
    for (const dep of meta.depends ?? []) {
      const d = this.plugins.get(dep);
      if (!d?.loaded) { st.error = `缺少依赖插件「${dep}」${d && !d.enabled ? '（已停用）' : d?.error ? '（加载失败）' : ''}`; log.warn(`${name}：${st.error}`); return; }
    }
    try {
      await c.def.setup(this.makeContext(st));
      st.loaded = true;
      log.info(`已加载${c.system ? '系统' : ''}插件 ${name}${meta.version ? ` v${meta.version}` : ''}`);
    } catch (e: any) {
      st.error = e?.message ?? String(e);
      log.error(`加载插件 ${name} 失败：${e?.stack ?? st.error}`);
      await this.teardown(st);
    }
  }

  private async teardown(st: PluginState) {
    for (const c of st.crons) c.stop();
    for (const fn of st.unloaders.reverse()) { try { await fn(); } catch (e: any) { log.warn(`${st.name} 卸载回调出错：${e.message}`); } }
    for (const t of st.tools) extraTools.delete(t);
    if (st.tools.length) notifyToolsChanged();
    for (const s of st.provides) this.services.delete(s);
    st.handlers = []; st.noticeHandlers = []; st.requestHandlers = []; st.tools = []; st.crons = []; st.unloaders = []; st.provides = []; st.routes = [];
    st.loaded = false;
  }

  /** 依赖于 name 的插件（递归）。 */
  private dependents(name: string): string[] {
    const out = new Set<string>();
    const walk = (n: string) => {
      for (const [k, c] of this.defs) if ((c.def.depends ?? []).includes(n) || (c.def.softDepends ?? []).includes(n)) { if (!out.has(k)) { out.add(k); walk(k); } }
    };
    walk(name);
    return [...out];
  }

  async reload(name: string) {
    const st = this.plugins.get(name);
    if (!st) throw new Error(`插件 ${name} 不存在`);
    if (st.ops) return st.ops.reload();
    const affected = this.order([name, ...this.dependents(name)]);
    for (const n of [...affected].reverse()) { const s = this.plugins.get(n); if (s) await this.teardown(s); }
    // 重新导入被修改的插件。导入失败时保留上一版，插件不能因为一次改坏就从列表里消失
    const fresh = (await this.discover()).find((c) => c.name === name);
    const failure = fresh ? undefined : this.plugins.get(name)?.error;
    if (fresh) this.defs.set(name, fresh);
    else if (!failure) { this.defs.delete(name); this.plugins.delete(name); }
    for (const n of affected) await this.loadOne(n);
    if (failure) { const s = this.plugins.get(name); if (s) s.lastError = `${failure}（继续使用上一版）`; }
    this.emit('changed');
  }

  async setEnabled(name: string, enabled: boolean) {
    const cfg = structuredClone(this.bridge.config);
    cfg.plugins.overrides[name] = enabled;
    cfg.plugins.disabled = cfg.plugins.disabled.filter((n) => n !== name);
    this.bridge.updateConfig(cfg);
    const st = this.plugins.get(name);
    if (!st) return;
    if (st.ops) { st.enabled = enabled; return st.ops.setEnabled(enabled); }
    await this.reload(name);
  }

  // ==================================================================== 配置
  private dataDirOf(name: string) { const d = path.join(this.bridge.dataDir, 'plugins', name); fs.mkdirSync(d, { recursive: true }); return d; }

  readConfig(name: string, schema?: ConfigSchema | Record<string, any>) {
    const defaults: Record<string, any> = {};
    for (const [k, v] of Object.entries(schema ?? {})) if (v && typeof v === 'object' && 'default' in v) defaults[k] = structuredClone((v as any).default);
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(path.join(this.dataDirOf(name), 'config.json'), 'utf8')); } catch { /* none */ }
    return { ...defaults, ...saved };
  }

  saveConfig(name: string, cfg: Record<string, any>) {
    atomicWrite(path.join(this.dataDirOf(name), 'config.json'), JSON.stringify(cfg, null, 2));
    const p = this.plugins.get(name);
    if (p) p.config = cfg;
  }

  // ==================================================================== 热重载（仅用户插件）
  private watch() {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (!this.bridge.config.plugins.hotReload) return;
    const src = this.sources.find((s) => !s.system)!;
    if (!fs.existsSync(src.dir)) return;
    try {
      this.watchers.push(fs.watch(src.dir, { recursive: true }, (_ev, file) => {
        if (!file || !/\.(ts|mts|mjs|js|json)$/.test(String(file))) return;
        const top = String(file).split(/[\\/]/)[0];
        const st = [...this.plugins.values()].find((p) => !p.system && p.kind === 'native' && (p.entry ? path.relative(src.dir, p.entry).split(/[\\/]/)[0] === top : false));
        const key = st?.name ?? `__rescan`;
        clearTimeout(this.reloadTimers.get(key));
        this.reloadTimers.set(key, setTimeout(() => {
          this.reloadTimers.delete(key);
          (st ? this.reload(st.name) : this.loadAll()).then(() => log.info(`热重载：${st?.name ?? '重新扫描'}`)).catch((e) => log.error(`热重载失败：${e.message}`));
        }, 400));
      }));
    } catch (e: any) { log.warn(`无法监听插件目录：${e.message}`); }
  }

  list() {
    return [...this.plugins.values()].map((p) => ({
      name: p.name, displayName: p.manifest.displayName ?? p.name, version: p.manifest.version ?? '', description: p.manifest.description ?? '',
      author: p.manifest.author ?? '', enabled: p.enabled, loaded: p.loaded, error: p.error, kind: p.kind, system: !!p.system, calls: p.calls, lastError: p.lastError,
      commands: p.commandList ?? p.handlers.filter((h) => h.kind === 'command').map((h) => ({ names: h.names!, desc: h.opts.desc ?? '', usage: h.opts.usage })),
      handlers: p.handlers.length, tools: p.tools, crons: p.crons.length, schema: p.schema, config: p.config, depends: p.depends, provides: p.provides,
      routes: (p.routes ?? []).map((r) => `${r.method} ${r.path}`),
    }));
  }

  findRoute(plugin: string, method: string, sub: string): { route: PluginRoute; params: Record<string, string> } | undefined {
    const st = this.plugins.get(plugin);
    if (!st?.loaded) return undefined;
    for (const r of st.routes ?? []) {
      if (r.method !== method) continue;
      const keys: string[] = [];
      const re = new RegExp(`^${r.path.replace(/^\//, '').replace(/:(\w+)/g, (_m, k) => { keys.push(k); return '([^/]+)'; })}$`);
      const m = re.exec(sub.replace(/^\//, ''));
      if (m) return { route: r, params: Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
    }
    return undefined;
  }

  // ==================================================================== 上下文
  private makeContext(st: PluginState): PluginContext<any> {
    const bridge = this.bridge;
    const host = this;
    const caller: Caller = { kind: 'plugin', name: `plugin:${st.name}` };
    const logger = createLogger(`plugin:${st.name}`);
    const timers: NodeJS.Timeout[] = [];
    st.unloaders.push(() => timers.forEach((t) => { clearTimeout(t); clearInterval(t); }));
    const kvNs = `plugin:${st.name}`;
    return {
      name: st.name,
      logger,
      dataDir: this.dataDirOf(st.name),
      get config() { return st.config; },
      saveConfig: (patch) => host.saveConfig(st.name, { ...st.config, ...patch }),
      kv: {
        get: (k, fb) => (bridge.store.kvGet(kvNs, k) ?? fb) as any,
        set: (k, v) => bridge.store.kvSet(kvNs, k, v),
        delete: (k) => bridge.store.kvSet(kvNs, k, undefined),
      },
      db: bridge.store.db,
      migrate: (sql) => bridge.store.db.exec(sql),
      store: bridge.store,
      media: bridge.media,
      qq: {
        send: async (conv, content, opts) => (await bridge.send(caller, conv, content, opts)).messageIds,
        call: (action, params = {}) => bridge.callAction(caller, action, params),
        get selfId() { return bridge.self?.userId; },
        nameOf: (conv, uid) => bridge.nameOf(conv, uid),
        format: (m) => bridge.formatLine(m),
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
      on(event: BridgeEventName, fn) {
        const map: Record<BridgeEventName, string> = { message: 'message', message_sent: 'message', notice: 'notice', request: 'request', connected: 'self' };
        const wrapped = event === 'message' ? (m: StoredMessage, raw: any) => { if (!m.isSelf) fn(m, raw); }
          : event === 'message_sent' ? (m: StoredMessage) => { if (m.isSelf) fn(m); } : fn;
        const safe = (...a: any[]) => { try { const r: any = (wrapped as any)(...a); if (r?.catch) r.catch((e: any) => logger.error(e?.message ?? e)); } catch (e: any) { logger.error(e?.message ?? e); } };
        bridge.on(map[event], safe);
        st.unloaders.push(() => bridge.off(map[event], safe));
      },
      tool(def: PluginToolDef<any>) {
        const name = def.name.startsWith('qq_') || def.name.startsWith(`${st.name}_`) ? def.name : `${st.name}_${def.name}`.replace(/[^a-zA-Z0-9_-]/g, '_');
        if (extraTools.has(name)) logger.warn(`工具 ${name} 被覆盖`);
        const td: ToolDef = {
          name, title: def.title ?? name, description: def.description, tier: def.tier ?? 'send', readOnly: def.readOnly, input: def.input,
          selfAudited: def.selfAudited, handler: async ({ caller: c }, args) => def.handler(args, c),
        };
        extraTools.set(name, td);
        st.tools.push(name);
        notifyToolsChanged();
      },
      provide(service) { host.services.set(st.name, service); st.provides.push(st.name); },
      use(plugin) {
        if (!host.services.has(plugin)) throw new Error(`插件「${plugin}」未提供服务（未启用或未加载？请在 depends 中声明）`);
        return host.services.get(plugin) as any;
      },
      useOptional(plugin) { return host.services.get(plugin) as any; },
      route(method, p, handler) { st.routes!.push({ method, path: p, handler }); },
      schedule(cron, fn) {
        st.crons.push(new Cron(cron, { protect: true, catch: (e: any) => logger.error(`定时任务出错：${e?.message ?? e}`) }, async () => { await fn(); }));
      },
      setInterval(fn, ms) { timers.push(setInterval(() => { Promise.resolve().then(fn).catch((e) => logger.error(e?.message ?? e)); }, ms)); },
      setTimeout(fn, ms) { timers.push(setTimeout(() => { Promise.resolve().then(fn).catch((e) => logger.error(e?.message ?? e)); }, ms)); },
      onUnload(fn) { st.unloaders.push(fn); },
      listCommands: () => host.list().filter((p) => p.loaded).flatMap((p) => p.commands.map((c: any) => ({ plugin: p.name, names: c.names ?? [], desc: c.desc, usage: c.usage }))),
    };
  }

  // ==================================================================== 分发
  private buildEvent(m: StoredMessage, raw: any): MessageEvent {
    const bridge = this.bridge;
    const convRef = parseConv(m.conv);
    let stopped = false;
    const caller: Caller = { kind: 'plugin', name: 'plugin' };
    const segs = m.segments.filter((s, i) => s.type !== 'reply' && !(i <= 1 && s.type === 'at' && String(s.data.qq) === bridge.self?.userId));
    return {
      conv: m.conv, convRef, msgId: m.msgId, senderId: m.senderId, senderName: m.senderName,
      isGroup: convRef.type === 'group', groupId: convRef.type === 'group' ? convRef.id : undefined,
      text: plainText(segs).trim(), rendered: m.text, segments: m.segments, mentioned: m.mentioned, ts: m.ts,
      isOwner: bridge.config.owners.includes(m.senderId), args: [], argText: '', message: m, raw,
      reply: async (content, opts) => { await bridge.send(caller, m.conv, content, { replyTo: m.msgId, atSender: opts?.at ? m.senderId : undefined }); },
      send: async (content, opts) => { await bridge.send(caller, m.conv, content, opts); },
      react: async (emoji) => {
        const id = bridge.faces.resolve(emoji) ?? [...emoji][0]?.codePointAt(0);
        await bridge.bot.call('set_msg_emoji_like', { message_id: Number(m.msgId), emoji_id: String(id), set: true });
      },
      stop: () => { stopped = true; },
      consume: () => { stopped = true; bridge.consume(m.conv, m.msgId); },
      get stopped() { return stopped; },
    };
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
        // 不带前缀的命令只在群里 @我 时识别；私聊必须带前缀，避免普通聊天（如"你好"）被命令截走
        const hit = matchCommand(base.text, h.names!, prefixes, base.isGroup && base.mentioned && !base.segments.some((x) => x.type === 'poke'));
        if (!hit) continue;
        Object.defineProperty(e, 'argText', { value: hit.argText });
        Object.defineProperty(e, 'args', { value: hit.argText ? hit.argText.split(/\s+/) : [] });
        this.bridge.consume(m.conv, m.msgId); // 命令不唤醒仿真 AI
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
        if (h.kind === 'command') await base.reply(`出错了：${err?.message ?? err}`).catch(() => {});
      }
    }
    for (const ext of this.external) {
      if (base.stopped) return;
      try { await ext.dispatch(base); } catch (err: any) { log.error(`${ext.name} 处理消息出错：${err?.message ?? err}`); }
    }
  }

  private dispatchNotice(ev: any) {
    const type = ev.notice_type === 'notify' ? ev.sub_type : ev.notice_type;
    for (const st of this.plugins.values()) if (st.loaded) for (const h of st.noticeHandlers) {
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
    for (const n of [...names].sort((a, b) => b.length - a.length)) {
      if (body === n) return { name: n, argText: '' };
      if (body.startsWith(n) && /\s/.test(body[n.length] ?? '')) return { name: n, argText: body.slice(n.length).trim() };
    }
  }
  return null;
}
