import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { baselineAdapter, evaluate, fixture, type Fixture } from './memory-eval.lib.ts';
import { candidateAdapters } from './memory-eval.candidates.ts';

const holdout: Fixture = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'memory-eval-holdout.json'), 'utf8'));
const FULL = '+关联';

/** 记忆检索的回归底线。这里的门槛不是成绩目标，只防止改动把效果改差。 */
describe.each([['开发集', fixture, 0.8], ['留出集', holdout, 0.6]] as const)('记忆检索评测：%s', (_name, fx, minRecall) => {
  const old = evaluate(baselineAdapter(fx, false), fx);
  const now = evaluate(candidateAdapters(fx).find((a) => a.name === FULL)!, fx);

  it('隐私和时效是硬指标：不泄露、不带过期事实、不凑数', () => {
    expect(now.leaks).toBe(0);
    expect(now.wakeBad).toBe(0);
    expect(now.staleRate).toBe(0);
    expect(now.noiseRate).toBe(0);
  });

  it('不低于升级前的成绩', () => {
    expect(now.recall5).toBeGreaterThan(old.recall5);
    expect(now.wakeHit).toBeGreaterThanOrEqual(old.wakeHit);
    expect(now.recall5).toBeGreaterThanOrEqual(minRecall);
  });
});
