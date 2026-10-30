/**
 * 仿真引擎：每个会话一个显式状态机，所有时间点由一个统一调度器（tick）检查。
 *
 * 模式（与 qq-bridge 二代一致）：
 *   active   活跃：任何新消息都会唤醒
 *   diving   潜水：只在 私聊 / @我或回复我 / 戳我 / 叫名字 / 关键词 / 问句 / 指定的人 / 概率 命中时唤醒
 *   sleeping 沉睡：到 sleepUntil 前只响应 私聊 / @我 / 戳我 / 指定的人；到点后回到潜水并唤醒一次看看
 *
 * 唤醒原因与优先级（同 qq-bridge）：private 100 > poke 95 > atMention 90 > question 80 > speaker 75 >
 *   nameMention 70 > keyword 60 > anyMessage 50 > replyCheck 40 > timeout 30 > probability 25 > proactive 20
 * 批量窗口内的后续触发只会提升原因优先级，不会延长窗口；会话忙（回合进行中）时保留待唤醒，回合结束后补发。
 */
export type Mode = 'active' | 'diving' | 'sleeping';

export const PRIORITY: Record<string, number> = {
  private: 100, poke: 95, atMention: 90, question: 80, speaker: 75, nameMention: 70, keyword: 60, anyMessage: 50,
  replyCheck: 40, timeout: 30, probability: 25, proactive: 20, manual: 110, bootstrap: 105, adminReply: 85, bubble: 45, bubbleEnd: 22,
};

export const REASON_LABEL: Record<string, string> = {
  private: '私聊新消息', poke: '有人戳了你', atMention: '有人 @ 你或回复了你', question: '有人在问问题', speaker: '你关注的人说话了',
  nameMention: '有人提到了你的名字', keyword: '出现了你关注的关键词', anyMessage: '群里有新消息（你处于活跃状态）',
  replyCheck: '你刚说过话，回来看看有没有人接', timeout: '沉睡结束，回来看看', probability: '你随手刷了一下群', proactive: '群里安静了一阵，你可以考虑主动开个话题（也可以不说）',
  manual: '管理员手动唤醒', adminReply: '管理员回复了你的请示，按答复去处理', bubble: '你刚上线，出来冒个泡', bubbleEnd: '冒泡时间到了，准备潜水', bootstrap: '你刚加入这个会话，先熟悉一下',
};

export interface Triggers {
  atMention: boolean; nameMention: boolean; question: boolean; poke: boolean;
  keywords: string[]; speakerIds: string[]; probability: number;
}

export interface ConvState {
  conv: string;
  mode: Mode;
  sleepUntil: number;
  triggers: Triggers;
  /** 由 Agent 设置 / 默认 */
  confirmedBy: 'default' | 'agent' | 'owner';
  pending: { reason: string; dueAt: number; since: number } | null;
  replyCheckAt: number;
  proactiveAt: number;
  lastWakeAt: number;
  lastAiSendAt: number;
  lastIncomingAt: number;
  wakeTimes: number[];
  noActionCount: number;
  /** 发给模型的人格卡版本（变了要重发完整人格） */
  roleVersion: string;
  wakes: number;
  lastReason: string;
  /** 当前待唤醒是否正被限流延后 */
  limited?: boolean;
}

export interface EngineConfig {
  defaultMode: 'active' | 'diving';
  triggers: Triggers;
  batchWindowMs: number;
  /** 私聊 / @我 / 戳我 时的等待窗口 */
  directWindowMs: number;
  maxWakePerMinute: number;
  maxWakePerHour: number;
  noActionLimit: number;
  replyCheckMs: number;
  proactive: { enabled: boolean; idleMs: number; checkMinMs: number; checkMaxMs: number; probability: number };
}

const randBetween = (a: number, b: number) => a + Math.random() * Math.max(0, b - a);

export function newState(conv: string, c: EngineConfig, now = Date.now()): ConvState {
  return {
    conv, mode: c.defaultMode, sleepUntil: 0, triggers: structuredClone(c.triggers), confirmedBy: 'default', pending: null,
    replyCheckAt: 0, proactiveAt: c.proactive.enabled ? now + randBetween(c.proactive.checkMinMs, c.proactive.checkMaxMs) : 0,
    lastWakeAt: 0, lastAiSendAt: 0, lastIncomingAt: 0, wakeTimes: [], noActionCount: 0, roleVersion: '', wakes: 0, lastReason: '',
  };
}

/** 判断"是不是在问 AI"：问句 + 指向你（你/机器人/名字）。 */
export function isDirectedQuestion(text: string, names: string[]) {
  const t = text.trim();
  if (!/[?？]$|吗[?？]?$|呢[?？]?$|么[?？]?$|是不是|能不能|会不会|怎么|为什么|啥/.test(t)) return false;
  return /你|机器人|bot|AI|ai/.test(t) || names.some((n) => n && t.includes(n));
}

function keywordHit(text: string, kw: string) {
  if (!kw) return false;
  // 短 ASCII 关键词按词边界匹配（避免 "DS" 命中 "ADS"）
  if (/^[\x20-\x7e]{1,4}$/.test(kw)) return new RegExp(`(^|[^A-Za-z0-9])${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9]|$)`, 'i').test(text);
  return text.toLowerCase().includes(kw.toLowerCase());
}

export interface IncomingInfo {
  isPrivate: boolean; mentioned: boolean; poke: boolean; text: string; senderId: string;
}

/** 根据消息与当前模式算出唤醒原因（null = 不唤醒）。 */
export function evaluate(s: ConvState, m: IncomingInfo, names: string[], now = Date.now()): string | null {
  const t = s.triggers;
  if (s.mode === 'sleeping' && s.sleepUntil <= now) s.mode = 'diving';
  if (m.isPrivate) return 'private';
  if (m.poke && t.poke) return 'poke';
  if (m.mentioned && t.atMention) return 'atMention';
  if (t.speakerIds.includes(m.senderId)) return 'speaker';
  if (s.mode === 'sleeping') return null;
  if (s.mode === 'active') return 'anyMessage';
  if (t.question && isDirectedQuestion(m.text, names)) return 'question';
  if (t.nameMention && names.some((n) => n && m.text.includes(n))) return 'nameMention';
  if (t.keywords.some((k) => keywordHit(m.text, k))) return 'keyword';
  if (t.probability > 0 && Math.random() < t.probability) return 'probability';
  return null;
}

/** 安排一次唤醒（批量窗口内只升级原因）。 */
/** 直接对话（私聊 / @我 / 戳我）：对方在等你，用短窗口；群聊闲聊用长窗口合并连续消息。 */
const DIRECT = new Set(['private', 'atMention', 'poke', 'adminReply']);
const windowOf = (reason: string, c: EngineConfig) => (reason === 'manual' ? 0 : DIRECT.has(reason) ? c.directWindowMs : c.batchWindowMs);

export function schedule(s: ConvState, reason: string, c: EngineConfig, now = Date.now()) {
  if (!s.pending) { s.pending = { reason, dueAt: now + windowOf(reason, c), since: now }; return; }
  if ((PRIORITY[reason] ?? 0) > (PRIORITY[s.pending.reason] ?? 0)) s.pending.reason = reason;
  // 更急的触发可以提前唤醒时间；同一窗口内的普通消息不延长等待
  s.pending.dueAt = Math.min(s.pending.dueAt, now + windowOf(reason, c));
}

const BYPASS_LIMIT = new Set(['manual', 'adminReply']);

/** 被限流时，什么时候能恢复唤醒 */
export function limitResumeAt(s: ConvState, c: EngineConfig, now = Date.now()) {
  const inMin = s.wakeTimes.filter((t) => now - t < 60_000);
  const minuteFull = inMin.length >= c.maxWakePerMinute;
  const hourFull = s.wakeTimes.length >= c.maxWakePerHour;
  return { hourFull, at: Math.max(minuteFull ? Math.min(...inMin) + 60_000 : now, hourFull ? s.wakeTimes[s.wakeTimes.length - c.maxWakePerHour] + 3_600_000 : now) };
}

export function rateOk(s: ConvState, c: EngineConfig, now = Date.now()) {
  s.wakeTimes = s.wakeTimes.filter((t) => now - t < 3_600_000);
  const lastMin = s.wakeTimes.filter((t) => now - t < 60_000).length;
  return lastMin < c.maxWakePerMinute && s.wakeTimes.length < c.maxWakePerHour;
}

/** 主动发言的概率修正（同 qq-bridge）：深夜 ×0.3、刚说过话 ×0.5、最近发太多 ×0.3。 */
export function proactiveProbability(s: ConvState, c: EngineConfig, recentSelfSends: number, now = Date.now()) {
  let p = c.proactive.probability;
  const h = new Date(now).getHours();
  if (h >= 23 || h < 8) p *= 0.3;
  if (now - s.lastAiSendAt < 30 * 60_000) p *= 0.5;
  if (recentSelfSends >= 5) p *= 0.3;
  return p;
}

/**
 * 调度器的一步：返回此刻应发出的唤醒原因（并更新内部时间点）；null = 暂不唤醒。
 * busy：该会话回合进行中（保留 pending，等回合结束）。
 */
export function tick(s: ConvState, c: EngineConfig, ctx: { busy: boolean; recentSelfSends: number }, now = Date.now()): string | null {
  if (s.mode === 'sleeping' && s.sleepUntil > 0 && s.sleepUntil <= now) {
    s.mode = 'diving'; s.sleepUntil = 0;
    schedule(s, 'timeout', c, now);
  }
  if (s.replyCheckAt && s.replyCheckAt <= now) { s.replyCheckAt = 0; if (s.lastIncomingAt > s.lastAiSendAt) schedule(s, 'replyCheck', c, now); }
  if (c.proactive.enabled && s.proactiveAt && s.proactiveAt <= now) {
    s.proactiveAt = now + randBetween(c.proactive.checkMinMs, c.proactive.checkMaxMs);
    const idle = now - Math.max(s.lastIncomingAt, s.lastAiSendAt);
    if (s.mode !== 'sleeping' && s.lastIncomingAt > 0 && idle >= c.proactive.idleMs && Math.random() < proactiveProbability(s, c, ctx.recentSelfSends, now)) schedule(s, 'proactive', c, now);
  }
  if (!s.pending || s.pending.dueAt > now || ctx.busy) return null;
  // 限流：延后而不是丢弃（qq-bridge 丢弃导致过永久沉睡）；管理员手动唤醒不受限
  if (!BYPASS_LIMIT.has(s.pending.reason) && !rateOk(s, c, now)) { s.pending.dueAt = now + 15_000; s.limited = true; return null; }
  s.limited = false;
  const reason = s.pending.reason;
  s.pending = null;
  s.wakeTimes.push(now);
  s.lastWakeAt = now;
  s.wakes++;
  s.lastReason = reason;
  return reason;
}

const ACTION_TOOLS = /^qq_(send|reply|send_burst|send_sticker|speak|send_image|send_voice|react|poke|set_wake|recall|forward_message|schedule)/;
const SEND_TOOLS = /^qq_(send|reply|send_burst|send_sticker|speak|send_image|send_voice|poke)/;

/** 回合结束：统计"无动作"、安排回复检查。返回是否发过言。 */
export function onTurnEnd(s: ConvState, c: EngineConfig, tools: string[], now = Date.now()): { sent: boolean; reset: boolean } {
  const acted = tools.some((t) => ACTION_TOOLS.test(t));
  const sent = tools.some((t) => SEND_TOOLS.test(t));
  const setWake = tools.some((t) => t === 'qq_set_wake');
  let reset = false;
  if (acted) s.noActionCount = 0;
  else if (++s.noActionCount >= c.noActionLimit) {
    // 连续多轮什么都没做：恢复默认唤醒配置，防止卡在奇怪的状态
    Object.assign(s, { mode: c.defaultMode, sleepUntil: 0, triggers: structuredClone(c.triggers), confirmedBy: 'default', noActionCount: 0 });
    reset = true;
  }
  if (sent) { s.lastAiSendAt = now; s.replyCheckAt = now + c.replyCheckMs; }
  // 没有显式设置唤醒：沉睡/活跃状态保持，但保证至少能被强触发唤醒（模式本身已保证）
  void setWake;
  return { sent, reset };
}

export function fmtAgo(ms: number) {
  if (ms < 60_000) return '刚刚';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} 分钟前`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} 小时前`;
  return `${Math.round(ms / 86_400_000)} 天前`;
}

/** 看起来没说完（结尾是逗号、语气连接词、省略号等）。 */
export function looksUnfinished(text: string) {
  return /[，,、…~—\-]$|(然后|但是|而且|就是|所以|因为|的话|我觉得|那个)$/.test(text.trim());
}
