/**
 * 记忆检索评测：npm run eval:memory
 *
 * 目的是回答「这项改动有没有用」，每项功能都对比开启前后的成绩。
 * 评测集是人工编写的中文群聊样例，只能说明相对改进，不代表真实群聊里的绝对效果。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { MemoryEngine as EngineV1 } from './fixtures/memory-engine-v1.ts';

const DAY = 86_400_000;
export const NOW = Date.UTC(2026, 9, 1);

export interface Fixture {
  people: Record<string, string[]>;
  memories: { key: string; content: string; scope: string; subject: string; kind: string; importance: number; ageDays: number; attr?: string }[];
  queries: { id: string; type: string; conv: string; query: string; agentQueries?: string[]; expect?: string[]; forbid?: string[]; match?: 'any' | 'all' }[];
  wakes: { id: string; conv: string; speakers: string[]; messages: string[]; expect: string[]; forbid?: string[]; match?: 'any' | 'all' }[];
}
export const fixture: Fixture = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'memory-eval.json'), 'utf8'));

/** 被测系统：给查询，返回按排名排序的记忆 key；给唤醒场景，返回注入的 key 和字数。 */
export interface Adapter {
  name: string;
  query(q: Fixture['queries'][number]): string[];
  wake(w: Fixture['wakes'][number]): { keys: string[]; chars: number };
}

const OLD_OPTS = { forgetting: true, baseStabilityDays: 3, growth: 1.5, forgetThreshold: 0.05, dedupThreshold: 0.75, wRelevance: 0.6, wRetention: 0.25, wImportance: 0.15 };

/** 旧版：行为与升级前的 qq_memory_recall 和 social 唤醒注入一致。 */
export function baselineAdapter(fx: Fixture = fixture, forgetting = true): Adapter {
  const db = new DatabaseSync(':memory:');
  const engine = new EngineV1(db, { ...OLD_OPTS, forgetting });
  const keyOf = new Map<number, string>();
  for (const m of fx.memories) {
    const r = engine.remember({ content: m.content.replace(/\[\[|\]\]/g, ''), scope: m.scope, subject: m.subject, kind: m.kind as any, importance: m.importance }, NOW - m.ageDays * DAY);
    keyOf.set(r.id, m.key);
  }
  const visible = (conv: string) => (m: { scope: string }) => m.scope === conv || m.scope === 'global';
  return {
    name: forgetting ? '旧版' : '旧版（关遗忘）',
    query: (q) => engine.recall({ query: q.query, limit: 20, reinforce: false }, NOW).filter(visible(q.conv)).slice(0, 10).map((m) => keyOf.get(m.id)!),
    wake: (w) => {
      const list = [...engine.recall({ scope: w.conv, limit: 4, reinforce: false }, NOW), ...w.speakers.flatMap((sp) => engine.recall({ subject: sp, limit: 2, reinforce: false }, NOW))];
      const uniq = [...new Map(list.map((x) => [x.id, x])).values()].slice(0, 8);
      return { keys: uniq.map((m) => keyOf.get(m.id)!), chars: uniq.reduce((n, m) => n + m.content.length, 0) };
    },
  };
}

const hit = (top: string[], expect: string[], match: 'any' | 'all' = 'all') => (match === 'any' ? expect.some((k) => top.includes(k)) : expect.every((k) => top.includes(k)));

export function evaluate(a: Adapter, fx: Fixture = fixture) {
  const byType = new Map<string, { n: number; hit: number; rr: number }>();
  const fails: string[] = [];
  let stale = 0, staleN = 0, leaks = 0, noise = 0, noiseN = 0;
  for (const q of fx.queries) {
    const ranked = a.query(q);
    const top = ranked.slice(0, 5);
    if (q.type === '噪音') { noiseN++; if (top.length) { noise++; fails.push(`${q.id} 噪音查询返回了 ${top.join(',')}`); } continue; }
    if (q.forbid?.length) {
      const bad = q.forbid.filter((k) => top.includes(k));
      if (q.type === '隔离') { leaks += bad.length; if (bad.length) fails.push(`${q.id} 泄露 ${bad.join(',')}`); }
      else { staleN++; if (bad.length) { stale++; fails.push(`${q.id} 取到过期事实 ${bad.join(',')}`); } }
    }
    if (!q.expect?.length) continue;
    const t = byType.get(q.type) ?? { n: 0, hit: 0, rr: 0 };
    t.n++;
    if (hit(top, q.expect, q.match)) t.hit++; else fails.push(`${q.id}「${q.query}」未命中，返回 ${top.join(',') || '空'}`);
    const rank = ranked.findIndex((k) => q.expect!.includes(k));
    t.rr += rank >= 0 ? 1 / (rank + 1) : 0;
    byType.set(q.type, t);
  }
  let wakeHit = 0, wakeBad = 0, chars = 0;
  for (const w of fx.wakes) {
    const r = a.wake(w);
    chars += r.chars;
    if (hit(r.keys, w.expect, w.match)) wakeHit++; else fails.push(`${w.id} 唤醒未带上 ${w.expect.join(',')}，实际 ${r.keys.join(',') || '空'}`);
    const bad = (w.forbid ?? []).filter((k) => r.keys.includes(k));
    if (bad.length) { wakeBad += bad.length; fails.push(`${w.id} 唤醒带上了不该出现的 ${bad.join(',')}`); }
  }
  const all = [...byType.values()].reduce((s, t) => ({ n: s.n + t.n, hit: s.hit + t.hit, rr: s.rr + t.rr }), { n: 0, hit: 0, rr: 0 });
  return {
    name: a.name, recall5: all.hit / all.n, mrr: all.rr / all.n, byType: Object.fromEntries([...byType].map(([k, t]) => [k, `${t.hit}/${t.n}`])),
    staleRate: staleN ? stale / staleN : 0, leaks, noiseRate: noiseN ? noise / noiseN : 0,
    wakeHit: wakeHit / fx.wakes.length, wakeBad, wakeChars: Math.round(chars / fx.wakes.length), fails,
  };
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function printTable(results: ReturnType<typeof evaluate>[]) {
  const types = [...new Set(results.flatMap((r) => Object.keys(r.byType)))];
  const head = ['方案', 'Recall@5', 'MRR', ...types, '过期事实', '查询泄露', '噪音误报', '唤醒命中', '唤醒违规', '唤醒字数'];
  console.log(`| ${head.join(' | ')} |\n|${head.map(() => '---').join('|')}|`);
  for (const r of results) {
    console.log(`| ${[r.name, pct(r.recall5), r.mrr.toFixed(2), ...types.map((t) => r.byType[t] ?? '-'), pct(r.staleRate), r.leaks, pct(r.noiseRate), pct(r.wakeHit), r.wakeBad, r.wakeChars].join(' | ')} |`);
  }
}

if (import.meta.main) {
  const results = [evaluate(baselineAdapter()), evaluate(baselineAdapter(fixture, false))];
  try {
    const { candidateAdapters } = await import('./memory-eval.candidates.ts');
    for (const a of candidateAdapters()) results.push(evaluate(a));
  } catch (e: any) { if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
  printTable(results);
  if (process.argv.includes('--fails')) for (const r of results) console.log(`\n## ${r.name}\n${r.fails.join('\n')}`);
}
