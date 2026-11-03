import { EventEmitter } from 'node:events';

/**
 * 回复流程：每次可能叫醒 AI 的事（被 @、私聊、叫名字、冷场主动发言……）走一遍固定的几步，
 * 控制台仪表盘把它画成一条流程条。走到哪一步、卡在哪一步、为什么卡住，一眼就能看到。
 *
 * 步骤：收到 → 会话启用 → 唤醒 → 交给 AI → AI 处理 → 回复
 * 不是每次都要走完：没启用的会话停在第二步；AI 看了决定不说话也是正常结束。
 */
export type StepKey = 'receive' | 'scope' | 'wake' | 'deliver' | 'think' | 'reply';
/** pending 还没到 / active 正在进行 / wait 在等（合并消息、限流） / done 完成 / skip 不适用 / stop 正常停在这里 / blocked 卡住了 */
export type StepState = 'pending' | 'active' | 'wait' | 'done' | 'skip' | 'stop' | 'blocked';
export interface Step { key: StepKey; label: string; state: StepState; note: string; at: number; fix?: { label: string; to: string } }
export interface Trace {
  id: number;
  conv: string;
  convName: string;
  /** 是什么触发的：某人的消息，或冷场、回来看看等 */
  origin: string;
  sender?: string;
  text?: string;
  /** 合并进这次唤醒的消息条数 */
  merged: number;
  startedAt: number;
  endedAt?: number;
  /** 结束方式：replied 已回复 / silent 看了没说话 / stopped 正常没唤醒 / blocked 卡住 */
  outcome?: 'replied' | 'silent' | 'stopped' | 'blocked';
  steps: Step[];
}

const LABELS: Record<StepKey, string> = { receive: '收到', scope: '会话启用', wake: '唤醒', deliver: '交给 AI', think: 'AI 处理', reply: '回复' };
const ORDER: StepKey[] = ['receive', 'scope', 'wake', 'deliver', 'think', 'reply'];
const KEEP = 30;
/** 一轮回复的工具名：调用过这些才算「发出去了」 */
export const SEND_TOOLS = /^qq_(send|reply|react|poke|speak|forward_message)/;

export class ReplyTracer extends EventEmitter {
  private list: Trace[] = [];
  private seq = 0;
  /** 每个会话：还没交给 AI 的那条（新消息合并进来），和正在处理的那条 */
  private waiting = new Map<string, Trace>();
  private running = new Map<string, Trace>();

  constructor(private convName: (conv: string) => string) { super(); }

  recent(): Trace[] { return this.list; }

  private emitTrace(t: Trace) { this.emit('trace', t); }

  start(conv: string, origin: string, info: { sender?: string; text?: string } = {}): Trace {
    const now = Date.now();
    const t: Trace = {
      id: ++this.seq, conv, convName: this.convName(conv) || conv, origin, sender: info.sender, text: info.text?.slice(0, 120), merged: 1, startedAt: now,
      steps: ORDER.map((key) => ({ key, label: LABELS[key], state: 'pending', note: '', at: 0 })),
    };
    this.list.unshift(t);
    if (this.list.length > KEEP) this.list.length = KEEP;
    return t;
  }

  step(t: Trace, key: StepKey, state: StepState, note = '', fix?: Step['fix']) {
    const s = t.steps.find((x) => x.key === key)!;
    // 前面还没走到的步骤：跳过了就标成「不适用」，免得流程条中间留空
    for (const p of t.steps) {
      if (p.key === key) break;
      if (p.state === 'pending') p.state = 'skip';
      else if (p.state === 'active' || p.state === 'wait') p.state = 'done'; // 已经走过去了
    }
    Object.assign(s, { state, note, at: Date.now(), fix });
    if (state === 'blocked' || state === 'stop') this.end(t, state === 'blocked' ? 'blocked' : 'stopped');
    else this.emitTrace(t);
  }

  end(t: Trace, outcome: NonNullable<Trace['outcome']>) {
    if (t.endedAt) return;
    t.endedAt = Date.now();
    t.outcome = outcome;
    if (this.waiting.get(t.conv) === t) this.waiting.delete(t.conv);
    if (this.running.get(t.conv) === t) this.running.delete(t.conv);
    this.emitTrace(t);
  }

  // ---------------------------------------------------------------- 给仿真功能用的几个入口
  /** 收到一条可能叫醒 AI 的消息。已经有等着唤醒的就合并进去 */
  message(conv: string, sender: string, text: string): { trace: Trace; merged: boolean } {
    const w = this.waiting.get(conv);
    if (w && !w.endedAt) { w.merged++; w.text = text.slice(0, 120); w.sender = sender; this.emitTrace(w); return { trace: w, merged: true }; }
    const t = this.start(conv, '消息', { sender, text });
    this.step(t, 'receive', 'done');
    return { trace: t, merged: false };
  }

  /**
   * 消息没能叫醒 AI，停在 key 这一步（前面的步骤都算通过）。
   * 同一个会话一分钟内因为完全相同的原因停下：并成一条，免得刷满列表。
   */
  halt(conv: string, sender: string, text: string, key: StepKey, state: 'blocked' | 'stop', note: string, fix?: Step['fix']) {
    const last = this.list.find((x) => x.conv === conv);
    const prev = last?.steps.find((x) => x.key === key);
    if (last?.endedAt && prev?.state === state && prev.note === note && Date.now() - last.endedAt < 60_000) {
      last.merged++; last.text = text.slice(0, 120); last.sender = sender; last.endedAt = Date.now(); this.emitTrace(last);
      return;
    }
    if (this.waiting.get(conv)) return; // 已经有一次唤醒在等着，这条会被一起看到
    const t = this.start(conv, '消息', { sender, text });
    for (const s of t.steps) { if (s.key === key) break; Object.assign(s, { state: 'done', at: Date.now() }); }
    this.step(t, key, state, note, fix);
  }

  /** 决定唤醒，等合并窗口 */
  waitWake(t: Trace, why: string, inMs: number) {
    this.waiting.set(t.conv, t);
    this.step(t, 'wake', 'wait', inMs > 0 ? `${why}，${Math.round(inMs / 100) / 10} 秒后唤醒（期间的新消息合并到这一次）` : why);
  }

  /** 唤醒被限流 */
  limited(conv: string, note: string) {
    const t = this.waiting.get(conv);
    if (t) this.step(t, 'wake', 'wait', note, { label: '调整唤醒上限', to: '/features/social/config' });
  }

  /** 开始交给 AI。没有消息触发的唤醒（冷场、回来看看）在这里新建 */
  deliver(conv: string, reasonLabel: string): Trace {
    let t = this.waiting.get(conv);
    if (!t || t.endedAt) { t = this.start(conv, reasonLabel); }
    else this.step(t, 'wake', 'done', reasonLabel + (t.merged > 1 ? `，合并了 ${t.merged} 条消息` : ''));
    this.waiting.delete(conv);
    this.running.set(conv, t);
    this.step(t, 'deliver', 'active', '正在把消息交给 AI');
    return t;
  }

  /** 等着唤醒的全部卡住（比如没有 AI 驱动） */
  failWaiting(why: string, fix?: Step['fix']) {
    for (const t of [...this.waiting.values()]) this.step(t, 'deliver', 'blocked', why, fix);
  }

  deliverFailed(conv: string, why: string, fix?: Step['fix']) {
    const t = this.running.get(conv);
    if (!t) return;
    // 一分钟内同一个会话、同样的原因又失败了：并进上一条，免得满屏都是同一个错误
    const prev = this.list.find((x) => x !== t && x.conv === conv);
    const ps = prev?.steps.find((x) => x.key === 'deliver');
    if (prev?.endedAt && ps?.state === 'blocked' && ps.note === why && Date.now() - prev.endedAt < 60_000) {
      this.running.delete(conv);
      this.list.splice(this.list.indexOf(t), 1);
      this.emit('trace', { ...t, removed: true });
      prev.merged += t.merged;
      prev.endedAt = Date.now();
      if (t.sender) { prev.sender = t.sender; prev.text = t.text; }
      this.emitTrace(prev);
      return;
    }
    this.step(t, 'deliver', 'blocked', why, fix);
  }

  thinking(conv: string) {
    const t = this.running.get(conv);
    if (!t || t.endedAt) return;
    this.step(t, 'deliver', 'done');
    this.step(t, 'think', 'active', 'AI 正在看消息、决定怎么回复');
  }

  /** 工具调用出错（发送被拒、令牌不对等）：记在正在处理的那条上，回合结束时一起说明 */
  toolError(conv: string | undefined, tool: string, why: string) {
    const t = conv ? this.running.get(conv) : this.running.size === 1 ? [...this.running.values()][0] : undefined;
    if (!t || t.endedAt) return;
    const s = t.steps.find((x) => x.key === 'think')!;
    s.note = `${tool} 出错：${why}`.slice(0, 300);
    (t as any).toolError = s.note;
    this.emitTrace(t);
  }

  /** 机器人在这个会话里发出了一条消息（不管用的哪个工具） */
  selfSent(conv: string) {
    const t = this.running.get(conv);
    if (t && !t.endedAt) (t as any).sentCount = ((t as any).sentCount ?? 0) + 1;
  }

  /** 这一轮结束 */
  turnEnd(conv: string, r: { reason: string; error?: string; tools: string[]; durationMs: number }) {
    const t = this.running.get(conv);
    if (!t || t.endedAt) return;
    const secs = `${Math.round(r.durationMs / 100) / 10} 秒`;
    const err = (t as any).toolError as string | undefined;
    if (r.reason !== 'completed') {
      const why = r.reason === 'aborted' ? `这一轮被结束了${r.error ? `：${r.error}` : ''}` : r.reason === 'timeout' ? '超时' : `出错：${r.error ?? '未知错误'}`;
      this.step(t, 'think', 'blocked', why, { label: 'AI 接入', to: '/agent' });
      return;
    }
    this.step(t, 'think', 'done', `用了 ${secs}${r.tools.length ? `，调用 ${r.tools.length} 次工具` : ''}`);
    const n = (t as any).sentCount ?? 0;
    const acts = [...new Set(r.tools.filter((x) => SEND_TOOLS.test(x)))];
    if (n || acts.length) { this.step(t, 'reply', 'done', n ? `发出 ${n} 条消息` : `已${acts.join('、')}`); this.end(t, 'replied'); return; }
    if (err) { this.step(t, 'reply', 'blocked', `没发出去。${err}`, { label: '调用审计', to: '/audit' }); return; }
    this.step(t, 'reply', 'done', 'AI 看过了，决定这次不说话');
    this.end(t, 'silent');
  }
}
