import type { DatabaseSync } from 'node:sqlite';

/**
 * Token 用量账本。
 *
 * 分桶（互不重叠）：cacheMiss 未命中输入、cacheHit 缓存命中输入、cacheWrite 缓存写入、output 输出、
 * reasoning 推理（已含在 output 内，仅展示不重复计费）。
 * 每条样本以 (driver, session, turn, step, retry) 为键，较新的 seq 覆盖旧值——
 * DSH 会对同一步多次上报（流式中间值 / 最终值 / 重试），这样不会重复计数。
 */

export interface UsageBuckets { cacheMiss: number; cacheHit: number; cacheWrite: number; output: number; reasoning: number }
export interface UsageSample extends UsageBuckets {
  driver: string; conv: string; session: string; turn: number; step: number; retry: number; seq: number;
  model: string; provider: string; ts?: number;
}

export interface ModelPrice { label?: string; cacheHit: number; cacheMiss: number; cacheWrite?: number; output: number }
export interface PriceTable {
  currency: string; symbol: string;
  /** 价格单位：每多少 token（默认 1e6 = 每百万） */
  unit: number;
  peakMultiplier: number;
  /** 北京时间高峰时段 [起, 止) 小时 */
  peakWindows: [number, number][];
  peakWeekdays: number[];
  holidays: string[];
  fallbackModel: string;
  models: Record<string, ModelPrice>;
}

export const CN_HOLIDAYS = [
  '2026-01-01', '2026-01-02', '2026-01-03', '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21',
  '2026-02-22', '2026-02-23', '2026-04-04', '2026-04-05', '2026-04-06', '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21', '2026-09-25', '2026-09-26', '2026-09-27', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07',
  '2027-01-01', '2027-01-02', '2027-01-03', '2027-02-05', '2027-02-06', '2027-02-07', '2027-02-08', '2027-02-09', '2027-02-10', '2027-02-11',
  '2027-02-12', '2027-02-13', '2027-04-04', '2027-04-05', '2027-04-06', '2027-05-01', '2027-05-02', '2027-05-03', '2027-05-04', '2027-05-05',
  '2027-06-09', '2027-06-10', '2027-06-11', '2027-09-15', '2027-09-16', '2027-09-17', '2027-10-01', '2027-10-02', '2027-10-03', '2027-10-04',
  '2027-10-05', '2027-10-06', '2027-10-07',
];

/** 默认价目（元 / 百万 token，空闲时段价；高峰 = × peakMultiplier）。可在设置中覆盖。 */
export const DEFAULT_PRICES: PriceTable = {
  currency: 'CNY', symbol: '¥', unit: 1e6, peakMultiplier: 2, peakWindows: [[9, 12], [14, 18]], peakWeekdays: [1, 2, 3, 4, 5],
  holidays: CN_HOLIDAYS, fallbackModel: 'deepseek-flash',
  models: {
    'deepseek-flash': { label: 'DeepSeek Flash', cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 },
    'deepseek-v4-flash': { label: 'DeepSeek V4 Flash', cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 },
    'deepseek-v4-pro': { label: 'DeepSeek V4 Pro', cacheHit: 0.15, cacheMiss: 4.5, cacheWrite: 4.5, output: 13.5 },
    'deepseek-pro': { label: 'DeepSeek Pro', cacheHit: 0.15, cacheMiss: 4.5, cacheWrite: 4.5, output: 13.5 },
    'deepseek-chat': { label: 'DeepSeek Chat', cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 },
    'deepseek-reasoner': { label: 'DeepSeek Reasoner', cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 },
  },
};

/** 北京时间是否高峰。 */
export function isPeak(ts: number, p: PriceTable): boolean {
  const bj = new Date(ts + 8 * 3600_000);
  const day = bj.toISOString().slice(0, 10);
  if (p.holidays.includes(day)) return false;
  if (!p.peakWeekdays.includes(bj.getUTCDay())) return false;
  const h = bj.getUTCHours() + bj.getUTCMinutes() / 60;
  return p.peakWindows.some(([a, b]) => h >= a && h < b);
}

export function costOf(b: UsageBuckets, model: string, ts: number, p: PriceTable): { cost: number; peak: boolean; estimated: boolean } {
  const key = Object.keys(p.models).find((m) => m.toLowerCase() === model.toLowerCase());
  const price = p.models[key ?? ''] ?? p.models[p.fallbackModel];
  if (!price) return { cost: 0, peak: false, estimated: true };
  const peak = isPeak(ts, p);
  const k = (peak ? p.peakMultiplier : 1) / p.unit;
  const cost = (b.cacheMiss * price.cacheMiss + b.cacheHit * price.cacheHit + b.cacheWrite * (price.cacheWrite ?? price.cacheMiss) + b.output * price.output) * k;
  return { cost, peak, estimated: !key };
}

/** 从各种上报形状里取用量（DSH / OpenAI / Anthropic 风格字段都兼容）。 */
export function normalizeUsage(u: any): UsageBuckets | null {
  if (!u || typeof u !== 'object') return null;
  const pick = (...keys: string[]) => { for (const k of keys) { const v = Number(u[k]); if (Number.isFinite(v) && v > 0) return v; } return 0; };
  const hit = pick('cacheHit', 'cacheReadTokens', 'cache_read_input_tokens', 'prompt_cache_hit_tokens');
  let miss = pick('cacheMiss', 'uncachedInputTokens', 'inputTokens', 'prompt_cache_miss_tokens', 'input_tokens');
  // OpenAI 风格：prompt_tokens 含命中部分
  if (!miss && u.prompt_tokens !== undefined) miss = Math.max(0, Number(u.prompt_tokens) - hit);
  const out = pick('output', 'outputTokens', 'completion_tokens', 'output_tokens');
  const reasoning = pick('reasoning', 'reasoningTokens', 'reasoning_tokens') || Number(u.completion_tokens_details?.reasoning_tokens ?? 0);
  const write = pick('cacheWrite', 'cacheWriteTokens', 'cache_creation_input_tokens');
  if (!hit && !miss && !out && !write) return null;
  return { cacheMiss: miss, cacheHit: hit, cacheWrite: write, output: out, reasoning };
}

export class UsageLedger {
  constructor(private db: DatabaseSync, public prices: () => PriceTable) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS usage_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, driver TEXT NOT NULL, conv TEXT NOT NULL DEFAULT '', session TEXT NOT NULL DEFAULT '',
        turn INTEGER NOT NULL DEFAULT 0, step INTEGER NOT NULL DEFAULT 0, retry INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL DEFAULT 0,
        model TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL DEFAULT '',
        cache_miss INTEGER NOT NULL DEFAULT 0, cache_hit INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
        output INTEGER NOT NULL DEFAULT 0, reasoning INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0, peak INTEGER NOT NULL DEFAULT 0, estimated INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ux_usage_key ON usage_samples(driver, session, turn, step, retry);
      CREATE INDEX IF NOT EXISTS ix_usage_ts ON usage_samples(ts);
    `);
  }

  /** 记录一条样本；同键且 seq 更大才覆盖。返回是否写入。 */
  record(s: UsageSample): boolean {
    const ts = s.ts ?? Date.now();
    const ex = this.db.prepare('SELECT seq, ts FROM usage_samples WHERE driver = ? AND session = ? AND turn = ? AND step = ? AND retry = ?')
      .get(s.driver, s.session, s.turn, s.step, s.retry) as any;
    if (ex && Number(ex.seq) >= s.seq && s.seq > 0) return false;
    const t = ex ? Number(ex.ts) : ts;
    const { cost, peak, estimated } = costOf(s, s.model, t, this.prices());
    this.db.prepare(`INSERT INTO usage_samples (ts, driver, conv, session, turn, step, retry, seq, model, provider, cache_miss, cache_hit, cache_write, output, reasoning, cost, peak, estimated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(driver, session, turn, step, retry) DO UPDATE SET seq = excluded.seq, model = excluded.model, provider = excluded.provider,
        cache_miss = excluded.cache_miss, cache_hit = excluded.cache_hit, cache_write = excluded.cache_write, output = excluded.output,
        reasoning = excluded.reasoning, cost = excluded.cost, peak = excluded.peak, estimated = excluded.estimated`)
      .run(t, s.driver, s.conv, s.session, s.turn, s.step, s.retry, s.seq, s.model, s.provider, s.cacheMiss, s.cacheHit, s.cacheWrite, s.output, s.reasoning, cost, peak ? 1 : 0, estimated ? 1 : 0);
    return true;
  }

  private agg(where: string, args: any[]) {
    const r = this.db.prepare(`SELECT COUNT(DISTINCT driver || session || turn) AS turns, SUM(cache_miss) AS miss, SUM(cache_hit) AS hit, SUM(cache_write) AS write,
      SUM(output) AS output, SUM(reasoning) AS reasoning, SUM(cost) AS cost, SUM(estimated) AS est FROM usage_samples ${where}`).get(...args) as any;
    const n = (v: any) => Number(v ?? 0);
    const input = n(r.miss) + n(r.hit) + n(r.write);
    return {
      turns: n(r.turns), cacheMiss: n(r.miss), cacheHit: n(r.hit), cacheWrite: n(r.write), output: n(r.output), reasoning: n(r.reasoning),
      input, total: input + n(r.output), cost: n(r.cost), cacheHitRate: input ? n(r.hit) / input : 0, hasEstimated: n(r.est) > 0,
    };
  }

  summary(sinceTs = 0) {
    const now = Date.now();
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    return {
      currency: this.prices().currency, symbol: this.prices().symbol,
      total: this.agg('WHERE ts >= ?', [sinceTs]),
      today: this.agg('WHERE ts >= ?', [dayStart.getTime()]),
      last7d: this.agg('WHERE ts >= ?', [now - 7 * 86400_000]),
      last30d: this.agg('WHERE ts >= ?', [now - 30 * 86400_000]),
    };
  }

  /** 按天（本地时区）的序列。 */
  series(days = 30) {
    const since = Date.now() - days * 86400_000;
    const rows = this.db.prepare(`SELECT date(ts / 1000, 'unixepoch', 'localtime') AS day, SUM(cache_miss) AS miss, SUM(cache_hit) AS hit, SUM(output) AS output,
      SUM(cost) AS cost, SUM(CASE WHEN peak = 1 THEN cost ELSE 0 END) AS peak_cost, COUNT(DISTINCT driver || session || turn) AS turns
      FROM usage_samples WHERE ts >= ? GROUP BY day ORDER BY day`).all(since) as any[];
    return rows.map((r) => ({ day: r.day, cacheMiss: Number(r.miss), cacheHit: Number(r.hit), output: Number(r.output), cost: Number(r.cost), peakCost: Number(r.peak_cost), turns: Number(r.turns) }));
  }

  /** 分组汇总：conv / model / driver。 */
  breakdown(by: 'conv' | 'model' | 'driver', sinceTs = 0) {
    const col = by === 'conv' ? 'conv' : by === 'model' ? 'model' : 'driver';
    const rows = this.db.prepare(`SELECT ${col} AS k, COUNT(DISTINCT driver || session || turn) AS turns, SUM(cache_miss) AS miss, SUM(cache_hit) AS hit,
      SUM(cache_write) AS write, SUM(output) AS output, SUM(cost) AS cost, MAX(ts) AS last FROM usage_samples WHERE ts >= ? GROUP BY ${col} ORDER BY cost DESC`).all(sinceTs) as any[];
    return rows.map((r) => {
      const input = Number(r.miss) + Number(r.hit) + Number(r.write);
      return { key: r.k, turns: Number(r.turns), input, output: Number(r.output), cacheHitRate: input ? Number(r.hit) / input : 0, cost: Number(r.cost), last: Number(r.last) };
    });
  }

  /** 最近的回合（按 driver+session+turn 合并各步）。 */
  recentTurns(limit = 50) {
    const rows = this.db.prepare(`SELECT driver, conv, session, turn, MIN(ts) AS ts, GROUP_CONCAT(DISTINCT model) AS models, COUNT(*) AS steps,
      SUM(cache_miss) AS miss, SUM(cache_hit) AS hit, SUM(output) AS output, SUM(cost) AS cost
      FROM usage_samples GROUP BY driver, session, turn ORDER BY MAX(ts) DESC LIMIT ?`).all(limit) as any[];
    return rows.map((r) => ({ driver: r.driver, conv: r.conv, session: r.session, turn: Number(r.turn), ts: Number(r.ts), models: r.models, steps: Number(r.steps),
      cacheMiss: Number(r.miss), cacheHit: Number(r.hit), output: Number(r.output), cost: Number(r.cost) }));
  }

  /** 价目调整后重算全部费用。 */
  recompute() {
    const rows = this.db.prepare('SELECT * FROM usage_samples').all() as any[];
    const up = this.db.prepare('UPDATE usage_samples SET cost = ?, peak = ?, estimated = ? WHERE id = ?');
    for (const r of rows) {
      const c = costOf({ cacheMiss: r.cache_miss, cacheHit: r.cache_hit, cacheWrite: r.cache_write, output: r.output, reasoning: r.reasoning }, r.model, r.ts, this.prices());
      up.run(c.cost, c.peak ? 1 : 0, c.estimated ? 1 : 0, r.id);
    }
    return rows.length;
  }

  reset(beforeTs = Date.now()) { return this.db.prepare('DELETE FROM usage_samples WHERE ts < ?').run(beforeTs).changes; }
}
