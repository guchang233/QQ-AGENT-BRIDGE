/** 记忆检索评测：npm run eval:memory，加 --fails 列出未通过的用例。 */
import { baselineAdapter, evaluate, fixture, printTable } from './memory-eval.lib.ts';
import { candidateAdapters } from './memory-eval.candidates.ts';

const results = [evaluate(baselineAdapter()), evaluate(baselineAdapter(fixture, false)), ...candidateAdapters().map((a) => evaluate(a))];
printTable(results);
if (process.argv.includes('--fails')) {
  for (const r of results.slice(2)) {
    console.log(`\n## ${r.name}`);
    for (const f of r.fails) console.log(f);
  }
}
