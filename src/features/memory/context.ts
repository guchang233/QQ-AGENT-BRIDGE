import type { MemoryEngine, MemoryView, RecallQuery } from './engine.ts';

export interface ContextRequest {
  conv: string;
  /** 最近的消息原文，旧到新 */
  messages: string[];
  /** 最近发言的人（QQ） */
  speakers: string[];
  /** 记忆内容总字数上限 */
  budget?: number;
  channels?: RecallQuery['channels'];
  queryEmbeddings?: Float32Array[];
  embedModel?: string;
}

const RECENT_MESSAGES = 6;
const FACTS_PER_SPEAKER = 3;
const DEFAULT_BUDGET = 600;
const RELEVANT_LIMIT = 6;

/**
 * 唤醒时带给 AI 的记忆。优先级：和当前话题相关的 → 发言人的关键事实。
 * 只看当前会话和 global，私聊里的事不会被带进群。
 */
export function contextFor(engine: MemoryEngine, req: ContextRequest, now = Date.now()) {
  const budget = req.budget ?? DEFAULT_BUDGET;
  const scopes = [req.conv, 'global'];
  const recent = req.messages.slice(-RECENT_MESSAGES).filter(Boolean);
  const relevant = recent.length
    ? engine.recall({ queries: [...recent].reverse(), scopes, limit: RELEVANT_LIMIT, reinforce: false, channels: req.channels, queryEmbeddings: req.queryEmbeddings, embedModel: req.embedModel }, now)
    : [];
  const facts = req.speakers.flatMap((qq) => engine.personFacts(qq, scopes, FACTS_PER_SPEAKER, now).map((m) => ({ ...m, why: ['发言人'] })));
  const items: MemoryView[] = [];
  const seen = new Set<number>();
  let used = 0;
  // 轮流取：相关记忆和发言人事实都不能把对方挤掉
  for (let i = 0; i < Math.max(relevant.length, facts.length); i++) {
    for (const m of [relevant[i], facts[i]]) {
      if (!m || seen.has(m.id) || used + m.content.length > budget) continue;
      seen.add(m.id); used += m.content.length; items.push(m);
    }
  }
  return { items, chars: used };
}
