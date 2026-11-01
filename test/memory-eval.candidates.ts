/** 新版检索的被测配置。每个配置只改一处，用来判断这项功能有没有用。 */
import { DatabaseSync } from 'node:sqlite';
import { MemoryEngine, type RecallQuery } from '../src/system-plugins/memory/engine.ts';
import { contextFor } from '../src/system-plugins/memory/context.ts';
import { fixture, NOW, type Adapter, type Fixture } from './memory-eval.lib.ts';

const DAY = 86_400_000;
const OPTS = { forgetting: true, baseStabilityDays: 3, growth: 1.5, archiveBelow: 0.5, dedupThreshold: 0.75 };

interface Variant { name: string; useAttr?: boolean; forgetting?: boolean; channels?: RecallQuery['channels']; agentQueries?: boolean }

function adapter(v: Variant, fx: Fixture): Adapter {
  const engine = new MemoryEngine(new DatabaseSync(':memory:'), { ...OPTS, forgetting: v.forgetting ?? true });
  for (const [qq, names] of Object.entries(fx.people)) engine.registerPerson(qq, ...names);
  const keyOf = new Map<number, string>();
  // 按时间先后写入，事实替代才符合真实顺序
  for (const m of [...fx.memories].sort((a, b) => b.ageDays - a.ageDays)) {
    const r = engine.remember({ content: m.content, scope: m.scope, subject: m.subject, kind: m.kind as any, importance: m.importance, attr: v.useAttr === false ? undefined : m.attr, source: 'agent:eval' }, NOW - m.ageDays * DAY);
    keyOf.set(r.id, m.key);
  }
  const scopesOf = (conv: string) => [conv, 'global'];
  return {
    name: v.name,
    query: (q) => engine.recall({ query: q.query, queries: v.agentQueries ? q.agentQueries : undefined, scopes: scopesOf(q.conv), limit: 10, reinforce: false, channels: v.channels }, NOW).map((m) => keyOf.get(m.id)!),
    wake: (w) => {
      const r = contextFor(engine, { conv: w.conv, messages: w.messages, speakers: w.speakers, budget: 500, channels: v.channels }, NOW);
      return { keys: r.items.map((m) => keyOf.get(m.id)!), chars: r.items.reduce((n, m) => n + m.content.length, 0) };
    },
  };
}

export function candidateAdapters(fx: Fixture = fixture): Adapter[] {
  return ([
    { name: '仅全文', channels: { entity: false, graph: false } },
    { name: '+人物', channels: { graph: false } },
    { name: '+关联', channels: {} },
    { name: '+关联（关替代）', useAttr: false },
    { name: '+关联（关遗忘）', forgetting: false },
    { name: '+关联+Agent 多路查询', agentQueries: true },
  ] as Variant[]).map((v) => adapter(v, fx));
}
