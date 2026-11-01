/**
 * 中文文本处理。Intl.Segmenter 对人名和网络用语切得不准（「胖虎」→「胖/虎」），
 * 所以索引同时存词和二元组，查询时再用已知人名修正。
 */
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const CJK_RUN = /[㐀-鿿豈-﫿]+/g;

/** 查询里没有区分度的词。 */
export const STOPWORDS = new Set(('的 了 吗 呢 吧 啊 呀 哦 嗯 是 在 有 和 与 或 也 都 就 还 很 又 没 不 我 你 他 她 它 们 我们 你们 他们 她们 这 那 这个 那个 哪 哪里 哪个 哪些 哪天 '
  + '什么 怎么 怎样 怎么样 为什么 多少 几 谁 么 嘛 要 会 能 想 去 来 对 给 把 被 让 跟 着 过 个 一个 一下 现在 最近 今天 明天 昨天 大家 有人 别人 时候 干嘛 做 帮 写 觉得').split(' '));

export function segment(text: string): string[] {
  const out: string[] = [];
  for (const s of segmenter.segment(text.toLowerCase())) if (s.isWordLike) out.push(s.segment);
  return out;
}

/** 词集合：英文单词 + 中文二元组（单字串保留单字）。 */
export function tokens(text: string): Set<string> {
  const s = text.toLowerCase();
  const out = new Set<string>();
  for (const w of s.match(/[a-z0-9_]+/g) ?? []) if (w.length > 1) out.add(w);
  for (const run of s.match(CJK_RUN) ?? []) {
    if (run.length === 1) out.add(run);
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

/** 重叠系数：|A∩B| / min(|A|,|B|)，适合"查询短、内容长"。 */
export function overlap(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / Math.min(a.size, b.size);
}

export function jaccard(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
}

export function cosine(a: Float32Array, b: Float32Array) {
  if (a.length !== b.length) return 0;
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
}

/** 写进全文索引的内容：词 + 二元组，用空格分开交给 FTS5。 */
export function indexTerms(text: string) {
  return [...new Set([...segment(text), ...tokens(text)])].join(' ');
}

/** 查询的核心词：去掉停用词和人名后，用于判断一条记忆是否真的相关。 */
export function coreWords(query: string, names: string[] = []) {
  let rest = query.toLowerCase();
  for (const n of [...names].sort((a, b) => b.length - a.length)) rest = rest.split(n.toLowerCase()).join(' ');
  const words = segment(rest).filter((w) => !STOPWORDS.has(w));
  const long = words.filter((w) => w.length >= 2);
  return long.length ? long : words;
}

/** FTS5 查询语句。全部加引号，避免用户文本被当成语法。 */
export function matchExpr(query: string) {
  const terms = [...new Set([...segment(query), ...tokens(query)])].filter((t) => !STOPWORDS.has(t));
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

/** 取出 [[双链]]。 */
export function wikiLinks(content: string) {
  return [...new Set([...content.matchAll(/\[\[([^\[\]\n]{1,40})\]\]/g)].map((m) => m[1].trim()).filter(Boolean))];
}

export const plainContent = (content: string) => content.replace(/\[\[|\]\]/g, '');
