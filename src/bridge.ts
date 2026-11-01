import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { type Config, loadConfig, saveConfig, resolveFromRoot, type Tier } from './config.ts';
import { OneBotClient, OneBotError } from './onebot/client.ts';
import { discover, type DiscoverResult } from './onebot/discover.ts';
import { actionTier, getAction } from './onebot/catalog.ts';
import { Store, type StoredMessage } from './store/db.ts';
import { MediaService } from './media.ts';
import { FaceTable } from './message/faces.ts';
import { type ConvRef, type Segment, convKey, normalizeMessage, parseConv, plainText, text as textSeg } from './message/segments.ts';
import { parseDsl } from './message/dsl.ts';
import { renderSegments, fmtTime } from './message/render.ts';
import { Policy, PolicyError, type Caller, CONSOLE_CALLER } from './policy.ts';
import { UsageLedger, DEFAULT_PRICES, type PriceTable } from './usage/ledger.ts';
import type { AgentDriver } from './drivers/types.ts';
import { createLogger } from './util/log.ts';
import { sha256, guessMime, MIME_EXT, atomicWrite } from './util/fs.ts';

const log = createLogger('bridge');

export interface SelfInfo { userId: string; nickname: string }
export interface PendingRequest { flag: string; kind: 'friend' | 'group'; subType?: string; userId: string; groupId?: string; comment: string; ts: number }
export interface SendOptions { replyTo?: string; atSender?: string; burst?: boolean }
export interface SendResult { messageIds: string[]; conv: string; parts: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 核心枢纽：持有 OneBot 连接、存储、媒体、策略；MCP 工具、Web 控制台、插件都通过它操作 QQ。
 * 事件：'message'(StoredMessage) 'notice'(raw) 'request'(PendingRequest) 'state' 'audit' 'self'
 */
export class Bridge extends EventEmitter {
  config: Config;
  bot: OneBotClient;
  store: Store;
  media: MediaService;
  faces = new FaceTable();
  policy: Policy;
  self: SelfInfo | null = null;
  discovery: DiscoverResult | null = null;
  requests = new Map<string, PendingRequest>();
  groups = new Map<string, { id: string; name: string; memberCount?: number }>();
  friends = new Map<string, { id: string; nickname: string; remark: string }>();
  startedAt = Date.now();
  dataDir: string;
  usage: UsageLedger;
  /** 已注册的 Agent 驱动（DSH 等） */
  drivers = new Map<string, AgentDriver>();
  /** 已被插件命令处理的消息（conv|msgId）：仿真不再为它唤醒 AI */
  consumed = new Set<string>();
  consume(conv: string, msgId: string) {
    this.consumed.add(`${conv}|${msgId}`);
    if (this.consumed.size > 2000) this.consumed.delete(this.consumed.values().next().value!);
  }
  isConsumed(conv: string, msgId: string) { return this.consumed.has(`${conv}|${msgId}`); }
  /** 插件宿主（由 PluginHost 构造时挂载） */
  pluginHost?: import('./plugins/host.ts').PluginHost;
  /** 自动更新（守护进程模式下挂载） */
  updater?: import('./update/index.ts').Updater;

  constructor(config?: Config) {
    super();
    this.setMaxListeners(100);
    this.config = config ?? loadConfig().config;
    this.dataDir = resolveFromRoot(this.config.dataDir);
    this.store = new Store(this.dataDir);
    const ob = this.config.onebot;
    this.bot = new OneBotClient(
      { wsUrl: ob.wsUrl, wsToken: ob.accessToken, httpUrl: ob.httpUrl, httpToken: ob.httpToken || ob.accessToken },
      { timeoutMs: ob.actionTimeoutMs, reconnectMaxMs: ob.reconnectMaxMs, autoReconnect: () => this.config.bot.autoReconnect },
    );
    this.media = new MediaService(this.store, this.bot, {
      dir: path.join(this.dataDir, 'media'),
      maxDownloadBytes: this.config.media.maxDownloadBytes,
      uploadRoots: this.config.media.uploadRoots,
    });
    this.policy = new Policy(() => this.config);
    this.usage = new UsageLedger(this.store.db, () => this.prices());
    this.bot.on('event', (ev) => this.onEvent(ev).catch((e) => log.error('处理事件出错', e)));
    this.bot.on('state', (s) => {
      this.emit('state', s);
      if (s === 'open') this.onConnected().catch((e) => log.warn('初始化信息拉取失败', e.message));
    });
  }

  // ======================================================================
  // 生命周期
  // ======================================================================
  /** 守护进程启动时调用：默认不连接，等人在控制台点启动（除非开启了自动连接） */
  async start() {
    if (this.config.bot.autoConnect) await this.connect();
    else log.info('机器人未启动：请在控制台点「启动机器人」');
  }

  /** 连接 QQ 协议端，机器人开始工作 */
  async connect() {
    await this.rediscover();
    this.bot.start();
  }

  /** 断开 QQ 协议端，机器人停止工作（控制台继续可用） */
  disconnect() {
    this.bot.stop();
    this.emit('state', this.bot.state);
  }

  get running() { return this.bot.running; }

  async rediscover() {
    const ob = this.config.onebot;
    if (ob.autoDiscover) {
      this.discovery = await discover({ httpUrl: ob.httpUrl, wsUrl: ob.wsUrl, httpToken: ob.httpToken || ob.accessToken, wsToken: ob.accessToken, snowlumaHome: ob.snowlumaHome });
      const d = this.discovery;
      if (d.ok) log.info(`发现可用 OneBot：${d.httpUrl}（账号 ${d.self?.nickname}/${d.self?.user_id}）`);
      else log.warn(`未能探测到可用的 OneBot HTTP：${d.tried.map((t) => `${t.source}→${t.error}`).join('；') || '无候选'}。将持续尝试 WS 重连`);
      this.bot.setEndpoints({ wsUrl: d.wsUrl || ob.wsUrl, wsToken: d.wsToken ?? ob.accessToken, httpUrl: d.httpUrl || ob.httpUrl, httpToken: d.httpToken ?? ob.httpToken });
    }
    return this.discovery;
  }

  /** 默认价目 + 配置覆盖。 */
  prices(): PriceTable {
    const o = this.config.usage.prices as Partial<PriceTable>;
    return { ...DEFAULT_PRICES, ...o, models: { ...DEFAULT_PRICES.models, ...(o.models ?? {}) } };
  }

  /**
   * 记录一条「动态」（控制台时间线）：唤醒、送达、回合、发出的消息、错误等。
   * kind: trigger / wake / turn / sent / error / info
   */
  activity(a: { kind: string; level?: 'info' | 'warn' | 'error' | 'success'; conv?: string; actor?: string; title: string; detail?: unknown }) {
    const id = this.store.addActivity(a);
    this.emit('activity', { id, ts: Date.now(), ...a, detail: a.detail === undefined ? '' : typeof a.detail === 'string' ? a.detail : JSON.stringify(a.detail) });
  }

  registerDriver(d: AgentDriver) {
    this.drivers.set(d.id, d);
    d.on('state', (s) => this.emit('driver', s));
  }

  async stop() {
    for (const d of this.drivers.values()) await d.stop().catch(() => {});
    this.bot.stop();
    this.store.close();
  }

  updateConfig(next: Config) {
    this.config = next;
    saveConfig(next);
    this.emit('config', next);
  }

  private async onConnected() {
    const info: any = await this.bot.call('get_login_info');
    this.self = { userId: String(info.user_id), nickname: String(info.nickname ?? '') };
    this.store.setName(`u:${this.self.userId}`, this.self.nickname);
    this.emit('self', this.self);
    log.info(`登录账号：${this.self.nickname}(${this.self.userId})`);
    await Promise.allSettled([
      this.refreshContacts(),
      this.bot.call('fetch_sys_faces').then((d) => { const n = this.faces.loadFromQQ(d); if (n) log.info(`已载入 ${n} 个系统表情`); }),
    ]);
  }

  async refreshContacts() {
    const [groups, friends] = await Promise.allSettled([this.bot.call<any[]>('get_group_list'), this.bot.call<any[]>('get_friend_list')]);
    if (groups.status === 'fulfilled' && Array.isArray(groups.value)) {
      this.groups.clear();
      for (const g of groups.value) {
        const id = String(g.group_id);
        this.groups.set(id, { id, name: g.group_name ?? '', memberCount: g.member_count });
        this.store.ensureConversation(`group:${id}`, g.group_name);
      }
    }
    if (friends.status === 'fulfilled' && Array.isArray(friends.value)) {
      this.friends.clear();
      for (const f of friends.value) {
        const id = String(f.user_id);
        this.friends.set(id, { id, nickname: f.nickname ?? '', remark: f.remark ?? '' });
        this.store.setName(`u:${id}`, f.remark || f.nickname || '');
      }
    }
    this.emit('contacts');
  }

  // ======================================================================
  // 事件处理
  // ======================================================================
  private async onEvent(ev: any) {
    switch (ev.post_type) {
      case 'message':
      case 'message_sent':
        await this.ingestMessage(ev);
        break;
      case 'notice':
        this.onNotice(ev);
        break;
      case 'request': {
        const r: PendingRequest = {
          flag: String(ev.flag), kind: ev.request_type === 'group' ? 'group' : 'friend', subType: ev.sub_type,
          userId: String(ev.user_id), groupId: ev.group_id ? String(ev.group_id) : undefined, comment: ev.comment ?? '', ts: Date.now(),
        };
        this.requests.set(r.flag, r);
        this.emit('request', r);
        break;
      }
      case 'meta_event':
        if (ev.meta_event_type === 'lifecycle') this.emit('lifecycle', ev);
        break;
    }
    this.emit('raw', ev);
  }

  private onNotice(ev: any) {
    const groupId = ev.group_id ? String(ev.group_id) : undefined;
    const conv = groupId ? `group:${groupId}` : ev.user_id ? `private:${ev.user_id}` : '';
    if ((ev.notice_type === 'group_recall' || ev.notice_type === 'friend_recall') && conv) {
      this.store.markRecalled(conv, String(ev.message_id));
    }
    // 戳一戳我：记成一条合成消息，让 agent 能感知
    if (ev.notice_type === 'notify' && ev.sub_type === 'poke' && this.self && String(ev.target_id) === this.self.userId && conv) {
      const sender = String(ev.user_id);
      const m = this.store.insertMessage({
        msgId: `poke-${ev.time}-${sender}`, conv, senderId: sender, senderName: this.nameOf(conv, sender) ?? sender,
        isSelf: false, ts: (ev.time ?? Date.now() / 1000) * 1000, segments: [{ type: 'poke', data: {} }], text: '[戳了戳我]', mentioned: true, recalled: false,
      });
      if (m) this.emit('message', m);
    }
    if (ev.notice_type === 'group_card' && groupId) this.store.setName(`g:${groupId}:${ev.user_id}`, ev.card_new ?? '');
    this.emit('notice', ev);
  }

  /** OneBot 消息事件 → 入库 → 广播。 */
  async ingestMessage(ev: any, silent = false): Promise<StoredMessage | null> {
    const isGroup = ev.message_type === 'group' || !!ev.group_id;
    const conv = isGroup ? `group:${ev.group_id}` : `private:${ev.post_type === 'message_sent' || String(ev.user_id) === this.self?.userId ? (ev.target_id ?? ev.user_id) : ev.user_id}`;
    const senderId = String(ev.user_id ?? ev.sender?.user_id ?? '');
    const isSelf = ev.post_type === 'message_sent' || (!!this.self && senderId === this.self.userId);
    const senderName = ev.sender?.card || ev.sender?.nickname || this.nameOf(conv, senderId) || senderId;
    if (isGroup) {
      this.store.setName(`g:${ev.group_id}:${senderId}`, ev.sender?.card || ev.sender?.nickname || '');
      if (ev.group_name) this.store.ensureConversation(conv, ev.group_name);
      else if (this.groups.has(String(ev.group_id))) this.store.ensureConversation(conv, this.groups.get(String(ev.group_id))!.name);
    } else {
      if (!isSelf) this.store.setName(`u:${senderId}`, ev.sender?.nickname || '');
      this.store.ensureConversation(conv, this.friends.get(conv.slice(8))?.remark || this.friends.get(conv.slice(8))?.nickname || (!isSelf ? ev.sender?.nickname : '') || '');
    }
    const segments = normalizeMessage(ev.message ?? ev.raw_message);
    const msgId = String(ev.message_id);
    const mentioned = !isSelf && (!isGroup || segments.some((s) => s.type === 'at' && this.self && String(s.data.qq) === this.self.userId)
      || segments.some((s) => s.type === 'reply' && this.store.getMessage(String(s.data.id), conv)?.isSelf));
    const textOut = this.renderForStore(segments, conv, msgId);
    const m = this.store.insertMessage({
      msgId, conv, senderId, senderName, isSelf, ts: eventTs(ev.time, silent), segments, text: textOut, mentioned, recalled: false,
    });
    if (m && !silent) this.emit('message', m, ev);
    return m;
  }

  private renderForStore(segments: Segment[], conv: string, msgId: string) {
    return renderSegments(segments, {
      selfId: this.self?.userId,
      nameOf: (qq) => this.nameOf(conv, qq),
      faceName: (id) => this.faces.nameOf(id),
      mediaRef: (seg) => (['image', 'record', 'video', 'file'].includes(seg.type) ? this.media.register(seg, conv, msgId) : undefined),
    });
  }

  nameOf(conv: string, qq: string): string | undefined {
    if (conv.startsWith('group:')) {
      const n = this.store.getName(`g:${conv.slice(6)}:${qq}`);
      if (n) return n;
    }
    const f = this.friends.get(qq);
    return f?.remark || f?.nickname || this.store.getName(`u:${qq}`);
  }

  convName(conv: string): string {
    const n = this.store.conversationName(conv);
    if (n) return n;
    const ref = parseConv(conv);
    if (ref.type === 'group') return this.groups.get(ref.id)?.name ?? '';
    return this.nameOf(conv, ref.id) ?? '';
  }

  /** 一行一条的可读格式：#消息ID [时间] 名字(QQ): 内容 */
  /** 是否管理员：只按 QQ 号判断。 */
  isOwner(qq: string | number) { return this.config.owners.map(String).includes(String(qq)); }

  /**
   * 一行一条的可读格式：[⟦管理员⟧]#消息ID [时间] 名字(QQ): 内容
   * ⟦管理员⟧ 由系统按发送者 QQ 号添加；昵称与内容里的 ⟦⟧ 会被去掉、昵称里形如 (12345) 的伪装也会去掉，无法冒充。
   */
  formatLine(m: StoredMessage): string {
    const name = String(m.senderName ?? '').replace(/[⟦⟧]/g, '').replace(/[(（]\s*\d{5,}\s*[)）]/g, '').trim() || m.senderId;
    const who = m.isSelf ? `我(${m.senderId})` : `${name}(${m.senderId})`;
    const mark = !m.isSelf && this.isOwner(m.senderId) ? '⟦管理员⟧' : '';
    return `${mark}#${m.msgId} [${fmtTime(m.ts)}] ${who}${m.recalled ? '［已撤回］' : ''}: ${String(m.text).replace(/[⟦⟧]/g, '')}`;
  }

  formatLines(ms: StoredMessage[]): string {
    return ms.map((m) => this.formatLine(m)).join('\n');
  }

  // ======================================================================
  // 统一调用入口（鉴权 + 审计）
  // ======================================================================
  async invoke<T>(caller: Caller, tool: string, tier: Tier, params: unknown, fn: () => Promise<T>, summary = ''): Promise<T> {
    const t0 = Date.now();
    try {
      await this.policy.authorize(caller, tool, tier, summary || `${tool} ${short(params)}`, params);
      const r = await fn();
      const id = this.store.audit({ agent: caller.name, tool, tier, params, ok: true, result: redact(tool, r), ms: Date.now() - t0 });
      this.emit('audit', { id, ts: Date.now(), agent: caller.name, kind: caller.kind, tool, tier, ok: true, ms: Date.now() - t0, params: short(params, 300) });
      return r;
    } catch (e: any) {
      const id = this.store.audit({ agent: caller.name, tool, tier, params, ok: false, result: e?.message ?? String(e), ms: Date.now() - t0 });
      if (tool === 'send') this.activity({ kind: 'error', level: 'error', conv: (params as any)?.conv, actor: caller.name, title: '发送失败', detail: e?.message ?? String(e) });
      this.emit('audit', { id, ts: Date.now(), agent: caller.name, kind: caller.kind, tool, tier, ok: false, ms: Date.now() - t0, params: short(params, 300), error: e?.message });
      throw e;
    }
  }

  /** 调用任意 OneBot 动作（按目录分级鉴权）。 */
  async callAction(caller: Caller, action: string, params: Record<string, unknown> = {}) {
    const tier = actionTier(action);
    if (!getAction(action) && caller.kind === 'agent') {
      throw new PolicyError(`未知动作 ${action}（不在动作目录中）。可用 qq_list_actions 搜索`, 'forbidden');
    }
    const conv = params.group_id ? { type: 'group' as const, id: String(params.group_id) } : params.user_id && /msg|poke|file/.test(action) ? { type: 'private' as const, id: String(params.user_id) } : null;
    if (conv) this.policy.assertConv(caller, conv);
    return this.invoke(caller, `action:${action}`, tier, params, () => this.bot.call(action, params));
  }

  // ======================================================================
  // 发送
  // ======================================================================
  /**
   * 发送消息。content 可以是 DSL 文本或段数组。
   * burst=true 时按「\n---\n」拆成多条依次发送，并带打字节奏间隔。
   */
  async send(caller: Caller, convIn: string | ConvRef, content: string | Segment[], opts: SendOptions = {}): Promise<SendResult> {
    const c = typeof convIn === 'string' ? parseConv(convIn) : convIn;
    const conv = convKey(c);
    this.policy.assertConv(caller, c);
    let parts: (string | Segment[])[] = typeof content === 'string'
      ? (opts.burst ? content.split(/\n\s*---\s*\n/).map((s) => s.trim()).filter(Boolean) : [content])
      : [content];
    // Agent 把几句话写在一条消息里（多行）：自动按行拆成多条，逐条发送
    if (typeof content === 'string' && !opts.burst && caller.kind === 'agent' && this.config.limits.autoSplit) {
      const lines = splitLines(content);
      if (lines.length >= 2 && lines.length <= this.config.limits.autoSplitMax) parts = lines;
    }
    if (!parts.length) throw new Error('消息内容为空');
    const total = parts.reduce((n, p) => n + (typeof p === 'string' ? p.length : plainText(p).length), 0);
    if (total > this.config.limits.maxMessageChars * parts.length) throw new Error(`消息过长（${total} 字），上限 ${this.config.limits.maxMessageChars} 字/条`);
    return this.invoke(caller, 'send', 'send', { conv, content, opts }, async () => {
      this.policy.checkSendRate(caller, conv, parts.length);
      const ids: string[] = [];
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) {
          // 间隔期间（私聊）显示「对方正在输入…」
          if (c.type === 'private') this.bot.call('set_input_status', { user_id: Number(c.id), event_type: 1 }).catch(() => {});
          await sleep(this.policy.gapFor(typeof parts[i] === 'string' ? (parts[i] as string).length : 20));
        }
        const { segments, uploads } = typeof parts[i] === 'string' ? await this.buildSegments(parts[i] as string) : { segments: parts[i] as Segment[], uploads: [] };
        if (i === 0 && opts.replyTo) segments.unshift({ type: 'reply', data: { id: String(opts.replyTo) } });
        if (i === 0 && opts.atSender && c.type === 'group') segments.splice(opts.replyTo ? 1 : 0, 0, { type: 'at', data: { qq: opts.atSender } }, textSeg(' '));
        if (segments.length) {
          const id = await this.sendSegments(c, segments);
          ids.push(id);
          this.policy.recordSend(caller, conv);
          const m = this.store.getMessage(id, conv);
          this.activity({ kind: 'sent', level: 'success', conv, actor: caller.name, title: `发给 ${this.convName(conv) || conv}`, detail: m?.text ?? '' });
        }
        for (const u of uploads) await this.uploadFile(c, u.file, u.name);
      }
      return { messageIds: ids, conv, parts: parts.length };
    }, `向 ${conv} 发送：${short(content, 120)}`);
  }

  /** 发送段数组（不鉴权，内部用）。发出后自行入库，以便 agent 能看到自己的发言。 */
  async sendSegments(c: ConvRef, segments: Segment[]): Promise<string> {
    const r: any = c.type === 'group'
      ? await this.bot.call('send_group_msg', { group_id: Number(c.id), message: segments })
      : await this.bot.call('send_private_msg', { user_id: Number(c.id), message: segments });
    const msgId = String(r?.message_id ?? `local-${Date.now()}`);
    const conv = convKey(c);
    const stored = segments.map((s) => (['image', 'record', 'video'].includes(s.type) ? this.media.rememberSent(s, conv, msgId) : s));
    const m = this.store.insertMessage({
      msgId, conv, senderId: this.self?.userId ?? 'self', senderName: this.self?.nickname ?? '我', isSelf: true, ts: Date.now(),
      segments: stored, text: this.renderForStore(stored, conv, msgId), mentioned: false, recalled: false,
    });
    if (m) this.emit('message', m);
    return msgId;
  }

  /** 解析 DSL 并解析其中的媒体标签。 */
  async buildSegments(input: string): Promise<{ segments: Segment[]; uploads: { file: string; name?: string }[] }> {
    const { segments, pending } = parseDsl(input, (s) => this.faces.resolve(s));
    const uploads: { file: string; name?: string }[] = [];
    for (const { index, token } of pending) {
      const { tag, arg, opts } = token;
      switch (tag) {
        case 'image': case 'img': {
          const data: Record<string, any> = { file: await this.media.toOneBotFile(arg) };
          if (opts.flash) data.type = 'flash';
          if (opts.sticker || opts.emoji) { data.sub_type = 1; data.summary = '[动画表情]'; }
          if (opts.summary) data.summary = opts.summary;
          segments[index] = { type: 'image', data };
          break;
        }
        case 'sticker': {
          const st = this.findSticker(arg);
          if (!st) throw new Error(`表情包库中找不到「${arg}」，可用 qq_list_stickers 查看`);
          this.store.bumpSticker(st.id);
          segments[index] = { type: 'image', data: { file: `base64://${fs.readFileSync(st.path).toString('base64')}`, sub_type: 1, summary: st.remark ? `[${st.remark}]` : '[动画表情]' } };
          break;
        }
        case 'record': case 'voice':
          segments[index] = { type: 'record', data: { file: await this.media.toOneBotFile(arg) } };
          break;
        case 'video':
          segments[index] = { type: 'video', data: { file: await this.media.toOneBotFile(arg) } };
          break;
        case 'file':
          uploads.push({ file: arg, name: opts.name });
          segments[index] = { type: '__drop', data: {} };
          break;
        default:
          segments[index] = textSeg(`[${tag}:${arg}]`);
      }
    }
    return { segments: mergeText(segments.filter((s) => s.type !== '__drop' && s.type !== '__pending')), uploads };
  }

  findSticker(arg: string) {
    const a = arg.trim().replace(/^#/, '');
    if (/^\d+$/.test(a)) return this.store.getSticker(Number(a));
    return this.store.findStickers(a, 1)[0];
  }

  async uploadFile(c: ConvRef, src: string, name?: string) {
    const abs = path.resolve(src.replace(/^file:\/\/\/?/, ''));
    let file = abs;
    if (!fs.existsSync(abs)) file = await this.media.toOneBotFile(src);
    else if (this.config.media.uploadRoots.length) await this.media.toOneBotFile(abs); // 触发路径白名单检查
    const fname = name || path.basename(abs);
    return c.type === 'group'
      ? this.bot.call('upload_group_file', { group_id: Number(c.id), file, name: fname }, 300_000)
      : this.bot.call('upload_private_file', { user_id: Number(c.id), file, name: fname }, 300_000);
  }

  // ======================================================================
  // 收件箱 / 等待
  // ======================================================================
  /**
   * 长轮询等待新消息：有新消息后再等 quietMs 无新消息（对方说完）才返回，最长 timeoutMs。
   * filter：conv 限定会话；mentionOnly 只关心 @我/私聊/回复我；afterSeq 起点（默认当前最新）。
   */
  waitForMessages(opts: { conv?: string; timeoutMs?: number; quietMs?: number; mentionOnly?: boolean; afterSeq?: number; signal?: AbortSignal; filter?: (m: StoredMessage) => boolean }): Promise<StoredMessage[]> {
    const timeoutMs = Math.max(1000, Math.min(opts.timeoutMs ?? 60_000, 30 * 60_000));
    const quietMs = Math.max(0, opts.quietMs ?? 3000);
    const conv = opts.conv ? convKey(parseConv(opts.conv)) : null;
    const startSeq = opts.afterSeq ?? this.store.maxSeq();
    const match = (m: StoredMessage) => !m.isSelf && (!conv || m.conv === conv) && (!opts.mentionOnly || m.mentioned) && (!opts.filter || opts.filter(m))
      && this.policy.convAllowed(parseConv(m.conv));
    const existing = this.store.after(conv, startSeq, 200).filter(match);
    return new Promise((resolve) => {
      const got: StoredMessage[] = [...existing];
      let quietTimer: NodeJS.Timeout | undefined;
      const finish = () => {
        clearTimeout(hard); clearTimeout(quietTimer);
        this.off('message', onMsg);
        opts.signal?.removeEventListener('abort', finish);
        resolve(got);
      };
      const arm = () => { clearTimeout(quietTimer); quietTimer = setTimeout(finish, quietMs); };
      const onMsg = (m: StoredMessage) => { if (match(m)) { got.push(m); arm(); } };
      const hard = setTimeout(finish, timeoutMs);
      this.on('message', onMsg);
      opts.signal?.addEventListener('abort', finish);
      if (got.length) arm();
    });
  }

  /** 从 QQ 服务器拉取历史并补入本地库。 */
  async backfill(convIn: string, count = 30): Promise<number> {
    const c = parseConv(convIn);
    const r: any = c.type === 'group'
      ? await this.bot.call('get_group_msg_history', { group_id: Number(c.id), count })
      : await this.bot.call('get_friend_msg_history', { user_id: Number(c.id), count });
    const list: any[] = r?.messages ?? (Array.isArray(r) ? r : []);
    const key = convKey(c);
    const hadUnread = this.store.unread(key, 1).length > 0;
    let n = 0;
    for (const ev of list) {
      if (!ev.message_type) ev.message_type = c.type;
      if (c.type === 'group' && !ev.group_id) ev.group_id = c.id;
      if (c.type === 'private' && String(ev.user_id) === this.self?.userId) ev.target_id = c.id;
      ev.post_type = ev.post_type === 'message_sent' ? 'message_sent' : 'message';
      const m = await this.ingestMessage(ev, true);
      if (m) n++;
    }
    // 补录的旧消息不应显示为未读
    if (n && !hadUnread) this.store.markRead(key);
    return n;
  }

  // ======================================================================
  // 表情包库
  // ======================================================================
  async collectSticker(src: string, remark = '', tags = '', source = '', extra: { note?: string; emoji_id?: string; url?: string } = {}) {
    const buf = await this.media.readSource(src);
    const mime = guessMime(buf);
    if (!mime.startsWith('image/')) throw new Error(`不是图片（${mime}）`);
    const sha = sha256(buf);
    const p = path.join(this.media.stickerDir(), `${sha.slice(0, 16)}${MIME_EXT[mime] ?? '.img'}`);
    if (!fs.existsSync(p)) atomicWrite(p, buf);
    return this.store.addSticker({ sha, path: p, mime, remark: oneLine(remark, 40), tags: oneLine(tags, 120), source, note: oneLine(extra.note ?? '', 200), emoji_id: extra.emoji_id, url: extra.url });
  }

  status() {
    return {
      connection: this.bot.state,
      running: this.bot.running,
      lastError: this.bot.lastError,
      endpoint: { ws: this.bot.ep.wsUrl, http: this.bot.ep.httpUrl },
      self: this.self,
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      lastEventAt: this.bot.lastEventAt || null,
      groups: this.groups.size,
      friends: this.friends.size,
      facesFromQQ: this.faces.loadedFromQQ,
      readOnly: this.config.access.readOnly,
      pendingApprovals: this.policy.pendingApprovals().length,
      pendingRequests: this.requests.size,
    };
  }
}

export { CONSOLE_CALLER, OneBotError, PolicyError };

/** OneBot 的 time 只有秒精度；实时事件用本地毫秒时间，避免与自己发出的消息排序错乱。 */
function eventTs(time: number | undefined, historical: boolean) {
  const now = Date.now();
  if (!time) return now;
  const t = time * 1000;
  return !historical && Math.abs(now - t) < 5000 ? now : t;
}

/**
 * 单行化 + 截断：表情备注/笔记会被展示给模型，压平换行与控制字符，
 * 防止有人借备注伪造"系统段落"进行提示词注入。
 */
// 用码点构造，避免源码里出现不可见字符
const cp = (a: number, b?: number) => (b === undefined ? String.fromCharCode(a) : `${String.fromCharCode(a)}-${String.fromCharCode(b)}`);
const WS_RE = new RegExp(`[\\s${cp(0xa0)}${cp(0x3000)}]+`, 'g');
const CTRL_RE = new RegExp(`[${cp(0, 0x1f)}${cp(0x7f, 0x9f)}${cp(0x200b, 0x200f)}${cp(0x2028, 0x2029)}${cp(0xfeff)}]`, 'g');
export function oneLine(v: string, max: number) {
  const s = String(v ?? '').replace(WS_RE, ' ').replace(CTRL_RE, '').trim();
  return [...s].slice(0, max).join('');
}
/**
 * 把多行文本拆成多条消息：按换行切分，去掉空行；含代码块、列表或标签跨行时不拆。
 * 单独一行的内联标记（如 [sticker:3]）作为独立一条。
 */
export function splitLines(text: string): string[] {
  if (/```/.test(text)) return [text];
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (lines.some((l) => /^([-*•]|\d+[.、)])\s/.test(l))) return [text]; // 列表保持一条
  // 未闭合的 [ 跨行（标签被换行截断）时不拆
  if (lines.some((l) => (l.match(/(?<!\\)\[/g)?.length ?? 0) > (l.match(/(?<!\\)\]/g)?.length ?? 0))) return [text];
  return lines;
}

function mergeText(segs: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (s.type === 'text' && last?.type === 'text') last.data = { text: last.data.text + s.data.text };
    else out.push(s);
  }
  return out.filter((s) => s.type !== 'text' || s.data.text !== '');
}

export function short(v: unknown, n = 200): string {
  let s: string;
  try { s = typeof v === 'string' ? v : JSON.stringify(v, (_k, val) => (typeof val === 'string' && val.startsWith('base64://') ? `base64://…(${val.length})` : val)); } catch { s = String(v); }
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

const SECRET_ACTIONS = /cookies|credentials|clientkey|csrf|rkey|decrypt/;
function redact(tool: string, r: unknown) {
  return SECRET_ACTIONS.test(tool) ? '[已脱敏]' : r;
}
