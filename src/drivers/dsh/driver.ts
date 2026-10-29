import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { Bridge } from '../../bridge.ts';
import type { AgentDriver, DriverStatus, TurnResult, WakeRequest } from '../types.ts';
import { DshClient, DshError, discoverDshBaseUrl, isLoopback } from './client.ts';
import { normalizeUsage } from '../../usage/ledger.ts';
import { createLogger } from '../../util/log.ts';

const log = createLogger('dsh');
const BUSY_LEASE_MS = 15 * 60_000;

interface SessionRec { sessionId: string; preset: string; model: string; created: number }
interface TurnState { conv: string; turn: number; startedAt: number; text: string; tools: string[]; model: string; retries: Map<string, number> }

/**
 * DSH 驱动：每个 QQ 会话 ↔ 一个 DSH 会话（使用 QQ 专用 Agent 预设，无本地工具）。
 * 唤醒 = session/prompt(mode:queue)；回合事件来自 session/follow；用量来自 assistant/message 的 usage。
 */
export class DshDriver extends EventEmitter implements AgentDriver {
  readonly id = 'dsh';
  readonly kind = 'dsh';
  readonly label = 'DeepSeek Harness';
  client: DshClient;
  private sessions = new Map<string, SessionRec>();   // conv -> rec
  private convOf = new Map<string, string>();          // sessionId -> conv
  private turns = new Map<string, TurnState>();        // sessionId -> 当前回合
  private busyUntil = new Map<string, number>();       // conv -> 租约到期
  private workspaceId = '';
  private lastModel = new Map<string, string>();
  private state: DriverStatus['state'] = 'disabled';
  private detail = '';
  private creating = new Map<string, Promise<SessionRec>>();

  constructor(private bridge: Bridge) {
    super();
    this.client = this.makeClient();
    const saved = (bridge.store.kvGet('driver:dsh', 'sessions') ?? {}) as Record<string, SessionRec>;
    for (const [conv, rec] of Object.entries(saved)) { this.sessions.set(conv, rec); this.convOf.set(rec.sessionId, conv); }
  }

  private makeClient() {
    const c = this.cfg;
    const client = new DshClient({ baseUrl: c.baseUrl, authToken: c.authToken || undefined, allowRemote: c.allowRemote, dshHome: c.dshHome || undefined });
    client.on('event', (sid: string, ev: any) => this.onEvent(sid, ev));
    client.on('connected', () => { this.setState('ready', '已连接'); });
    client.on('disconnected', () => {
      this.setState('connecting', 'DSH 事件流断开，重连中');
      // DSH 重启后端口会变：稍后重新定位
      setTimeout(() => { if (!this.client.connected && this.cfg.enabled) void this.locate().then((u) => { if (u && !this.client.connected) { for (const r of this.sessions.values()) this.client.follow(r.sessionId); this.client.start(); } }); }, 5000);
    });
    client.on('session-gone', (sid: string) => { const conv = this.convOf.get(sid); if (conv) { log.warn(`DSH 会话已不存在，将为 ${conv} 重建`); this.forget(conv); } });
    client.on('approval', (a: any) => void this.onApproval(a));
    client.on('question', (q: any) => void this.onQuestion(q));
    return client;
  }

  /** 配置变化后重建客户端并重连。 */
  async reconfigure() {
    this.client.stop();
    this.client.removeAllListeners();
    this.client = this.makeClient();
    this.workspaceId = '';
    await this.start();
  }

  get cfg() { return this.bridge.config.drivers.dsh; }

  private setState(s: DriverStatus['state'], d: string) { this.state = s; this.detail = d; this.emit('state', this.status()); }

  async start() {
    if (!this.cfg.enabled) { this.setState('disabled', '未启用'); return; }
    this.setState('connecting', '连接中');
    await this.locate();
    for (const rec of this.sessions.values()) this.client.follow(rec.sessionId);
    this.client.start();
  }

  async stop() { this.client.stop(); this.setState('disabled', '已停止'); }

  /** 配置地址连不上且是本机地址时，自动探测 DSH 桌面版的随机端口并记住。 */
  async locate(): Promise<string> {
    const c = this.cfg;
    if (await this.client.ping()) return this.client.baseUrl;
    if (!c.autoDiscover || !isLoopback(c.baseUrl)) return '';
    const found = await discoverDshBaseUrl({ authToken: c.authToken || undefined, allowRemote: c.allowRemote, dshHome: c.dshHome || undefined }, c.baseUrl);
    if (found && found !== this.client.baseUrl) {
      log.info(`自动发现 DSH：${found}`);
      const cfg = structuredClone(this.bridge.config);
      cfg.drivers.dsh.baseUrl = found;
      this.bridge.updateConfig(cfg);
      this.client.stop();
      this.client.removeAllListeners();
      this.client = this.makeClient();
      this.workspaceId = '';
      for (const r of this.sessions.values()) this.client.follow(r.sessionId);
      this.client.start();
      this.bridge.activity({ kind: 'info', actor: 'DSH', title: `重新连接到 DSH：${found}` });
    } else if (!found) this.setState('error', 'DSH 未运行或无法鉴权（已尝试自动发现本机端口）');
    return found;
  }

  status(): DriverStatus {
    const now = Date.now();
    return { id: this.id, kind: this.kind, label: this.label, state: this.state, detail: this.detail, sessions: this.sessions.size,
      busy: [...this.busyUntil].filter(([, t]) => t > now).map(([c]) => c) };
  }

  isBusy(conv: string) { return (this.busyUntil.get(conv) ?? 0) > Date.now(); }

  private persist() {
    this.bridge.store.kvSet('driver:dsh', 'sessions', Object.fromEntries(this.sessions));
  }

  private forget(conv: string) {
    const rec = this.sessions.get(conv);
    if (rec) { this.client.unfollow(rec.sessionId); this.convOf.delete(rec.sessionId); this.turns.delete(rec.sessionId); }
    this.sessions.delete(conv);
    this.busyUntil.delete(conv);
    this.persist();
  }

  // ------------------------------------------------------------------ 会话
  private async ensureWorkspace(): Promise<string> {
    if (this.workspaceId) return this.workspaceId;
    const dir = this.cfg.workspacePath || path.join(this.bridge.dataDir, 'dsh-workspace');
    fs.mkdirSync(dir, { recursive: true });
    const v: any = await this.client.call('workspace/create', { path: dir });
    this.workspaceId = v.workspace.workspaceId;
    if (v.created && this.cfg.workspaceTitle) await this.client.call('workspace/rename', { workspaceId: this.workspaceId, title: this.cfg.workspaceTitle }).catch(() => {});
    return this.workspaceId;
  }

  async listPresets(): Promise<{ id: string; name?: string; isDefault?: boolean }[]> {
    const v: any = await this.client.call('agentPresets/list', {});
    return v?.presets ?? [];
  }

  private async ensureSession(conv: string): Promise<SessionRec> {
    const ex = this.sessions.get(conv);
    if (ex && ex.preset === this.cfg.preset && ex.model === this.cfg.model) return ex;
    if (ex) { log.info(`${conv} 的 DSH 预设/模型已变化，重建会话`); await this.retire(conv); }
    const pending = this.creating.get(conv);
    if (pending) return pending;
    const p = (async () => {
      // 安全兜底：预设必须存在，否则 DSH 会退回带 shell/文件工具的默认预设
      const presets = await this.listPresets();
      if (!presets.some((x) => x.id === this.cfg.preset)) {
        throw new DshError('preset', `DSH 中没有预设「${this.cfg.preset}」。请在控制台「Agent 接入 → DeepSeek Harness」点击「一键接入」并重启 DSH`);
      }
      const workspaceId = await this.ensureWorkspace();
      const v: any = await this.client.call('session/create', { workspaceId, agentPreset: this.cfg.preset });
      const sessionId = String(v.sessionId);
      if (this.cfg.model) {
        await this.client.call('session/selectModel', { sessionId, provider: this.cfg.provider, model: this.cfg.model, reasoningEffort: this.cfg.reasoningEffort })
          .catch((e) => log.warn(`选择模型失败（将使用 DSH 默认模型）：${e.message}`));
      }
      // 按 QQ 会话命名，方便在 DSH 侧边栏里找到并查看完整调用（尽力而为）
      const title = `QQ ${conv.startsWith('group:') ? '群' : '私聊'} · ${this.bridge.convName(conv) || conv}`;
      await this.client.call('session/rename', { sessionId, title }).catch(() => {});
      const rec: SessionRec = { sessionId, preset: this.cfg.preset, model: this.cfg.model, created: Date.now() };
      this.sessions.set(conv, rec);
      this.convOf.set(sessionId, conv);
      this.client.follow(sessionId);
      this.persist();
      log.info(`为 ${conv} 创建 DSH 会话 ${sessionId.slice(0, 12)}`);
      return rec;
    })();
    this.creating.set(conv, p);
    try { return await p; } finally { this.creating.delete(conv); }
  }

  /** 退役会话：清 inbox 队列 → cancel → 归档（顺序重要：cancel 不清队列，archive 只是隐藏）。 */
  private async retire(conv: string) {
    const rec = this.sessions.get(conv);
    if (!rec) return;
    this.forget(conv);
    const sid = rec.sessionId;
    try {
      const pv: any = await this.client.call('session/projections', { sessionId: sid }, 10_000).catch(() => null);
      const inbox = pv?.values?.inbox ?? {};
      for (const it of [...(inbox['next-turn'] ?? []), ...(inbox['next-step'] ?? [])]) {
        if (it?.id) await this.client.call('session/updateQueue', { sessionId: sid, itemId: it.id, action: { kind: 'remove' } }, 10_000).catch(() => {});
      }
      await this.client.call('session/cancel', { sessionId: sid }, 10_000).catch(() => {});
      await this.client.call('workspace/archiveSession', { sessionId: sid }, 10_000).catch(() => {});
    } catch (e: any) { log.warn(`退役 DSH 会话失败：${e.message}`); }
  }

  async reset(conv: string) { await this.retire(conv); }

  async cancel(conv: string) {
    const rec = this.sessions.get(conv);
    if (rec) await this.client.call('session/cancel', { sessionId: rec.sessionId }).catch(() => {});
    this.busyUntil.delete(conv);
  }

  // ------------------------------------------------------------------ 唤醒
  async wake(req: WakeRequest) {
    try { await this.wakeOnce(req); }
    catch (e: any) {
      // DSH 重启后端口会变：重新定位一次再试
      if (e?.code === 'unreachable' && (await this.locate())) await this.wakeOnce(req);
      else throw e;
    }
  }

  private async wakeOnce(req: WakeRequest) {
    if (!this.cfg.enabled) throw new DshError('disabled', 'DSH 驱动未启用');
    let rec = await this.ensureSession(req.conv);
    const content: any[] = [{ type: 'text', text: req.prompt }];
    for (const [i, img] of (req.images ?? []).entries()) content.push({ type: 'image', mediaType: img.mediaType, data: img.data, name: img.name ?? `image-${i + 1}` });
    this.busyUntil.set(req.conv, Date.now() + BUSY_LEASE_MS);
    try {
      await this.client.call('session/prompt', { sessionId: rec.sessionId, mode: 'queue', content });
    } catch (e: any) {
      if (/not[- ]?found/i.test(e.message)) {
        log.warn(`${req.conv} 的 DSH 会话已失效，重建后重试`);
        this.forget(req.conv);
        rec = await this.ensureSession(req.conv);
        await this.client.call('session/prompt', { sessionId: rec.sessionId, mode: 'queue', content });
      } else { this.busyUntil.delete(req.conv); throw e; }
    }
    this.bridge.activity({ kind: 'wake', level: 'success', conv: req.conv, actor: 'DSH', title: '已送达 DSH', detail: { session: rec.sessionId, reason: req.reason, chars: req.prompt.length } });
  }

  // ------------------------------------------------------------------ 事件
  private onEvent(sid: string, ev: any) {
    const conv = this.convOf.get(sid);
    if (!conv || !ev?.type) return;
    const d = ev.data ?? {};
    switch (ev.type) {
      case 'turn/start':
        this.turns.set(sid, { conv, turn: Number(d.turn), startedAt: Date.now(), text: '', tools: [], model: this.lastModel.get(sid) ?? '', retries: new Map() });
        this.busyUntil.set(conv, Date.now() + BUSY_LEASE_MS);
        this.emit('turn-start', conv);
        this.bridge.activity({ kind: 'turn', conv, actor: 'DSH', title: `DSH 开始思考（第 ${d.turn} 轮）`, detail: { session: sid } });
        break;
      case 'model/selection':
        if (d.model) this.lastModel.set(sid, String(d.model));
        break;
      case 'llm/retry-started': {
        const t = this.turns.get(sid);
        if (t) t.retries.set(`${d.turn}|${d.step}`, Number(d.retry ?? (t.retries.get(`${d.turn}|${d.step}`) ?? 0) + 1));
        break;
      }
      case 'tool/call': {
        const t = this.turns.get(sid);
        if (t && d.name) t.tools.push(String(d.name).replace(/^mcp__[^_]+(?:-[^_]+)*__/, ''));
        break;
      }
      case 'assistant/message':
      case 'assistant/attempt': {
        const t = this.turns.get(sid);
        if (ev.type === 'assistant/message' && t) {
          for (const b of d.message?.content ?? []) if (b?.type === 'text' && typeof b.text === 'string') t.text += b.text;
        }
        const raw = d.usage ?? [...(d.stream ?? [])].reverse().find((x: any) => x?.usage)?.usage;
        const u = normalizeUsage(raw);
        if (u) {
          const turn = Number(d.turn ?? t?.turn ?? 0); const step = Number(d.step ?? 0);
          this.bridge.usage.record({
            driver: 'dsh', conv, session: sid, turn, step, retry: t?.retries.get(`${turn}|${step}`) ?? 0, seq: Number(ev.seq ?? 0),
            model: String(raw?.model ?? this.lastModel.get(sid) ?? this.cfg.model ?? ''), provider: String(raw?.provider ?? this.cfg.provider ?? ''), ...u,
          });
          this.bridge.emit('usage', { driver: 'dsh', conv });
        }
        break;
      }
      case 'turn/end': {
        const t = this.turns.get(sid);
        this.turns.delete(sid);
        this.busyUntil.delete(conv);
        const kind = d.reason?.kind ?? 'completed';
        const r: TurnResult = {
          reason: kind === 'error' ? 'error' : kind === 'aborted' ? 'aborted' : 'completed',
          error: d.reason?.error?.message, text: t?.text ?? '', tools: t?.tools ?? [], durationMs: t ? Date.now() - t.startedAt : 0,
        };
        if (r.reason === 'error') log.warn(`${conv} 的 DSH 回合出错：${r.error}`);
        const used = this.bridge.store.db.prepare('SELECT SUM(cache_miss + cache_hit + cache_write) AS i, SUM(output) AS o, SUM(cost) AS c FROM usage_samples WHERE driver = ? AND session = ? AND turn = ?').get('dsh', sid, Number(d.turn)) as any;
        this.bridge.activity({
          kind: 'turn', level: r.reason === 'error' ? 'error' : 'info', conv, actor: 'DSH',
          title: r.reason === 'error' ? `DSH 回合出错：${r.error ?? ''}` : `DSH 回合结束（${Math.round(r.durationMs / 100) / 10}s）${r.tools.length ? '' : '，没有调用工具'}`,
          detail: { tools: r.tools, text: r.text.slice(0, 500), tokens: { input: Number(used?.i ?? 0), output: Number(used?.o ?? 0) }, cost: Number(used?.c ?? 0), session: sid },
        });
        this.emit('turn-end', conv, r);
        break;
      }
    }
  }

  /** DSH 的工具审批 → 控制台审批队列（QQ 预设里本不该出现需审批的工具，默认拒绝更安全）。 */
  private async onApproval(a: { eventId: string; sessionId: string; toolName?: string; reason?: string }) {
    const conv = this.convOf.get(a.sessionId) ?? a.sessionId;
    let ok = false;
    if (this.cfg.approvals === 'console') {
      ok = await this.bridge.policy.ask(`dsh@${conv}`, `dsh:${a.toolName}`, 'danger', `DSH 请求执行工具 ${a.toolName}${a.reason ? `：${a.reason}` : ''}`, a);
    }
    await this.client.respond(a.eventId, ok ? 'allowed-once' : 'rejected').catch((e) => log.warn(`回复 DSH 审批失败：${e.message}`));
  }

  /** QQ 场景下没有人能回答 ask_user 提问：给空答案，让模型自行决定。 */
  private async onQuestion(q: { eventId: string }) {
    await this.client.respond(q.eventId, { answers: [] }).catch(() => {});
  }
}
