/**
 * 消息信封：把聊天消息渲染成给模型看的一行 JSON。
 *
 * 模型分不清「系统给的元数据」和「用户打的字」，所以用户原文绝不能和元数据写在同一层：
 *  - 身份字段（qq / name / role / mentions）由系统填写，放在前面；
 *  - 用户原文只进最后的 text 字段，换行和引号都被转义，无法另起一行，也无法跳出字段。
 *
 * 这只是降低模型被文字带偏的概率；越权操作由工具侧按消息 ID 查真实发送者来兜底（见 qq_memory_remember、qq_ask_admin）。
 */

export type SenderRole = 'admin' | 'member' | 'self';

export interface Envelope {
  id: string;
  time: string;
  qq: string;
  name: string;
  role: SenderRole;
  /** 真实的 at 消息段（手打的 @某人 不算） */
  mentions?: string[];
  replyTo?: string;
  recalled?: boolean;
  /** 消息是多久以前发的（较早的消息才有） */
  age?: string;
  text: string;
}

// JSON.stringify 不转义这些字符，但它们同样能断行或改变文字显示方向（用码点构造，避免源码里出现不可见字符）
const cp = (a: number, b = a) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`;
const INVISIBLE_BREAKERS = new RegExp(`[${cp(0x85)}${cp(0x2028, 0x2029)}${cp(0x202a, 0x202e)}${cp(0x2066, 0x2069)}]`, 'g');

/** 序列化成一行 JSON，保证输出里没有任何真实的换行。 */
export function jsonLine(v: unknown): string {
  return JSON.stringify(v).replace(INVISIBLE_BREAKERS, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** 把不可信文本写成带引号的字符串字面量，用于拼进提示词。 */
export const quote = (text: unknown) => jsonLine(String(text ?? ''));

const LOG_LINE = /\b\d{1,2}:\d{2}:\d{2}\b\s+(OK|INFO|WARN|WARNING|ERROR|DEBUG)\b|\[Event\]|\bID:\s*-?\d{5,}|\[\d{5,12}\]\s*\[/i;
const FAKE_SPEAKER = /[(（]\s*\d{5,12}\s*[)）]\s*[\]】]?\s*[:：]|"qq"\s*:\s*"?\d{5,}|"role"\s*:\s*"admin"|#-?\d+\s*\[\d{1,2}:\d{2}\]/i;
const FAKE_SYSTEM = /【\s*(系统|管理员|会话|当前|新消息|相关记忆|记忆|人格|此刻状态|你的身份|最近的聊天)[^】]{0,16}】|⟦|^\s*(system|assistant)\s*[:：]/im;

/** 识别「长得像系统内容」的文本。只作提示，容易绕过，不能当防线。 */
export function forgeryFlags(text: string): string[] {
  const t = text.normalize('NFKC');
  const flags: string[] = [];
  if (LOG_LINE.test(t)) flags.push('疑似网关日志');
  if (FAKE_SPEAKER.test(t)) flags.push('疑似伪造发言记录');
  if (FAKE_SYSTEM.test(t)) flags.push('疑似伪造系统内容');
  return flags;
}

export function renderEnvelope(e: Envelope): string {
  const flags = e.role === 'self' ? [] : forgeryFlags(e.text);
  return jsonLine({
    id: e.id, time: e.time, qq: e.qq, name: e.name, role: e.role,
    ...(e.mentions?.length ? { mentions: e.mentions } : {}),
    ...(e.replyTo ? { reply_to: e.replyTo } : {}),
    ...(e.recalled ? { recalled: true } : {}),
    ...(e.age ? { age: e.age } : {}),
    ...(flags.length ? { flags } : {}),
    text: e.text, // 必须放最后：先读到身份，再读到原文
  });
}

/** 合并转发里的节点：发送者可以任意伪造，用 claimed_ 前缀说明这不是真实身份。 */
export const renderForwardNode = (n: { index: number; name: string; qq: string; text: string }) =>
  jsonLine({ index: n.index, claimed_name: n.name, claimed_qq: n.qq, text: n.text });
