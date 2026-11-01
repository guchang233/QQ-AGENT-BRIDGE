/** 记忆检索评测：npm run eval:memory，加 --fails 列出未通过的用例。 */
import fs from 'node:fs';
import path from 'node:path';
import { baselineAdapter, evaluate, fixture, printTable, type Fixture } from './memory-eval.lib.ts';
import { candidateAdapters } from './memory-eval.candidates.ts';

const holdout: Fixture = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'memory-eval-holdout.json'), 'utf8'));
const showFails = process.argv.includes('--fails');

for (const [title, fx] of [['开发集（实现时参考过）', fixture], ['留出集（实现完成后才编写）', holdout]] as const) {
  const results = [evaluate(baselineAdapter(fx), fx), evaluate(baselineAdapter(fx, false), fx), ...candidateAdapters(fx).map((a) => evaluate(a, fx))];
  console.log(`\n### ${title}\n`);
  printTable(results);
  if (showFails) {
    for (const r of results.slice(2)) {
      console.log(`\n## ${r.name}`);
      for (const f of r.fails) console.log(f);
    }
  }
}
