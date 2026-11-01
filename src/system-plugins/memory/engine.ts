import type { DatabaseSync } from 'node:sqlite';
import { coreWords, cosine, indexTerms, jaccard, matchExpr, overlap, plainContent, tokens, wikiLinks } from './text.ts';

export { cosine, jaccard, overlap, tokens } from './text.ts';

/**
 * 记忆引擎（与插件框架无关，便于单测与复用）。
 *
 * 遗忘：FSRS 的幂函数曲线 R(t) = (1 + 19/81 · t/S)^-0.5，S 为保持率降到 90% 的天数。
 *   遗忘主要影响排序。事实、偏好、关系不自动归档；事件、待办、笔记保持率过低才归档（可找回）。
 * 更新：同一主体同一 attr 的新值让旧值失效（valid_to），旧记录保留，不删除。
 * 关联：记忆和实体（人、话题）组成二部图，边来自 subject、[[双链]]、已知人名和标签。
 * 检索：全文、实体、向量、图扩散多路召回，RRF 融合，再按保持率、重要度、可信度重排。
 *   没有相关内容就不返回。可信度来自写入时核实的来源，群友的一面之词排在后面。
 */

export type MemoryKind = 'fact' | 'preference' | 'event' | 'relation' | 'task' | 'note' | 'rule';
export const KINDS: MemoryKind[] = ['fact', 'preference', 'event', 'relation', 'task', 'note', 'rule'];
/** Agent 可写的类型（rule 只能由管理员通过命令/控制台设定） */
export const AGENT_KINDS = KINDS.filter((k) => k !== 'rule');
export const KIND_LABEL: Record<MemoryKind, string> = { fact: '事实', preference: '偏好', event: '事件', relation: '关系', task: '待办', note: '笔记', rule: '管理员规则' };

export type Trust = 'owner' | 'self' | 'imported' | 'member';
export const TRUST_LABEL: Record<Trust, string> = { owner: '管理员确认', self: 'AI 观察', imported: '导入', member: '群友自述' };
const TRUST_RANK: Record<Trust, number> = { member: 0, imported: 1, self: 1, owner: 2 };
const TRUST_WEIGHT: Record<Trust, number> = { owner: 1.1, self: 1, imported: 0.95, member: 0.9 };

/** 长期事实衰减慢，事件衰减快 */
const KIND_STABILITY: Record<MemoryKind, number> = { fact: 8, preference: 8, relation: 8, rule: 8, note: 2, event: 1, task: 1 };
const ARCHIVABLE = new Set<MemoryKind>(['event', 'task', 'note']);

export interface MemoryRow {
  id: number; scope: string; subject: string; kind: MemoryKind; content: string; tags: string; importance: number;
  stability: number; created: number; last_access: number; access_count: number; source: string; pinned: number; archived: number;
  embedding: Uint8Array | null; embed_model: string;
  attr: string; valid_from: number; valid_to: number; superseded_by: number; trust: Trust; source_msg: string;
}

export interface MemoryView extends Omit<MemoryRow, 'embedding'> {
  retention: number; forgotten: boolean; expired: boolean; score?: number; relevance?: number;
  /** 被取出的原因，用于「提示词预览」和调试 */
  why?: string[];
}

export interface EntityRow { id: number; kind: 'person' | 'topic'; key: string; name: string; aliases: string }

export interface EngineOptions {
  forgetting: boolean;
  baseStabilityDays: number;
  growth: number;
  /** 保持率低于此值的事件、待办、笔记会被归档 */
  archiveBelow: number;
  dedupThreshold: number;
}

export interface RememberInput {
  content: string; scope?: string; subject?: string; kind?: MemoryKind; tags?: string[] | string; importance?: number; pinned?: boolean;
  source?: string; embedding?: Float32Array | null; embedModel?: string;
  /** 单值属性（住址、称呼、工作等）：同一主体同一 attr 只保留最新值 */
  attr?: string;
  /** 这条记忆替代的旧记忆 ID */
  supersedes?: number;
  trust?: Trust;
  /** 来源消息（conv|msgId） */
  sourceMsg?: string;
}

export interface RememberResult {
  id: number; merged: boolean; superseded: number[];
  /** 想替代但可信度不够，旧值保留 */
  blocked: number[];
  /** 内容相近但没合并的旧记忆，由 Agent 判断是否替代 */
  similar: { id: number; content: string }[];
}

export interface RecallQuery {
  query?: string;
  /** 多路查询：Agent 可以自己展开同义词 */
  queries?: string[];
  scope?: string; scopes?: string[]; subject?: string; kind?: string; limit?: number;
  includeForgotten?: boolean; includeArchived?: boolean;
  /** 包含已被替代的旧事实 */
  includeHistory?: boolean;
  /** 只看这些范围（按调用方权限过滤） */
  visible?: (scope: string) => boolean;
  queryEmbeddings?: Float32Array[]; embedModel?: string; reinforce?: boolean;
  channels?: Partial<Record<Channel, boolean>>;
}

export type Channel = 'lexical' | 'entity' | 'vector' | 'graph';
const CHANNEL_LABEL: Record<Channel, string> = { lexical: '关键词', entity: '人物', vector: '语义', graph: '关联' };

const DAY = 86_400_000;
const FSRS_FACTOR = 19 / 81;
const FSRS_DECAY = -0.5;
const RRF_K = 60;
const MIN_COVERAGE = 0.5;
const MIN_COSINE = 0.35;
const GRAPH_RESTART = 0.5;
const GRAPH_STEPS = 3;
const NEAR_DUPLICATE = 0.7;
const SIMILAR_FLOOR = 0.3;

export function trustFromSource(source: string, kind?: string): Trust {
  if (kind === 'rule' || /^(owner|admin-approved|console)/.test(source)) return 'owner';
  if (/^(member|user):/.test(source)) return 'member';
  if (/^(legacy|qq-bridge)/.test(source)) return 'imported';
  return 'self';
}

export class MemoryEngine {
  /** 图的邻接表缓存，写入时失效 */
  private graph: Map<string, string[]> | null = null;
  private entityCache: EntityRow[] | null = null;

  constructor(private db: DatabaseSync, public opts: EngineOptions) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mem_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL DEFAULT 'global', subject TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT 'fact', content TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '', importance INTEGER NOT NULL DEFAULT 3,
        stability REAL NOT NULL, created INTEGER NOT NULL, last_access INTEGER NOT NULL, access_count INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT '', pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, embedding BLOB
      );
      CREATE INDEX IF NOT EXISTS ix_mem_scope ON mem_items(scope, subject);
      CREATE INDEX IF NOT EXISTS ix_mem_subject ON mem_items(subject);
      CREATE TABLE IF NOT EXISTS mem_entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, aliases TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS mem_edges (
        src INTEGER NOT NULL, rel TEXT NOT NULL, dst_kind TEXT NOT NULL, dst INTEGER NOT NULL, PRIMARY KEY (src, rel, dst_kind, dst)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS ix_mem_edges_dst ON mem_edges(dst_kind, dst);
      CREATE VIRTUAL TABLE IF NOT EXISTS mem_search USING fts5(terms, tokenize='unicode61');
      DROP TRIGGER IF EXISTS mem_ai; DROP TRIGGER IF EXISTS mem_ad; DROP TRIGGER IF EXISTS mem_au;
      DROP TABLE IF EXISTS mem_fts;
    `);
    const has = new Set((db.prepare('PRAGMA table_info(mem_items)').all() as any[]).map((c) => c.name));
    const added = !has.has('valid_to');
    for (const [col, type] of Object.entries({
      attr: "TEXT NOT NULL DEFAULT ''", valid_from: 'INTEGER NOT NULL DEFAULT 0', valid_to: 'INTEGER NOT NULL DEFAULT 0', superseded_by: 'INTEGER NOT NULL DEFAULT 0',
      trust: "TEXT NOT NULL DEFAULT 'self'", source_msg: "TEXT NOT NULL DEFAULT ''", embed_model: "TEXT NOT NULL DEFAULT ''",
    })) if (!has.has(col)) db.exec(`ALTER TABLE mem_items ADD COLUMN ${col} ${type}`);
    db.exec('CREATE INDEX IF NOT EXISTS ix_mem_attr ON mem_items(subject, attr)');
    if (added) this.upgradeRows();
  }

  /** 升级旧数据：补来源可信度、按新曲线重算稳定度，再建索引和关联。 */
  private upgradeRows() {
    for (const r of this.db.prepare('SELECT id, source, kind, importance, stability, created FROM mem_items').all() as any[]) {
      this.db.prepare('UPDATE mem_items SET trust = ?, stability = ?, valid_from = ? WHERE id = ?')
        .run(trustFromSource(r.source, r.kind), Math.max(r.stability, this.initialStability(r.importance, r.kind)), r.created, r.id);
    }
    this.rebuildIndex();
  }

  // ------------------------------------------------------------ 遗忘曲线
  initialStability(importance: number, kind: MemoryKind = 'fact') {
    return this.opts.baseStabilityDays * 2 ** (Math.min(5, Math.max(1, importance)) - 1) * (KIND_STABILITY[kind] ?? 1);
  }

  retention(r: Pick<MemoryRow, 'stability' | 'last_access' | 'pinned'>, now = Date.now()) {
    if (!this.opts.forgetting || r.pinned) return 1;
    const t = Math.max(0, now - r.last_access) / DAY;
    return (1 + FSRS_FACTOR * t / Math.max(0.01, r.stability)) ** FSRS_DECAY;
  }

  private archivable(r: Pick<MemoryRow, 'kind' | 'pinned' | 'importance'>) { return ARCHIVABLE.has(r.kind) && !r.pinned && r.importance < 4; }

  view(r: MemoryRow, now = Date.now()): MemoryView {
    const { embedding, ...rest } = r;
    const retention = this.retention(r, now);
    return { ...rest, retention, forgotten: this.opts.forgetting && this.archivable(r) && retention < this.opts.archiveBelow, expired: r.valid_to > 0 };
  }

  /** 被回忆 → 强化（同一小时内重复回忆不再累加，防止刷强度）。 */
  reinforce(id: number, now = Date.now()) {
    const r = this.get(id);
    if (!r) return;
    if (now - r.last_access < 3_600_000) { this.db.prepare('UPDATE mem_items SET access_count = access_count + 1 WHERE id = ?').run(id); return; }
    const R = this.retention(r, now);
    const S = r.stability * (1 + this.opts.growth * (1 - R) + 0.05);
    this.db.prepare('UPDATE mem_items SET stability = ?, last_access = ?, access_count = access_count + 1, archived = 0 WHERE id = ?').run(S, now, id);
  }

  // ------------------------------------------------------------ 实体
  private entities() {
    return this.entityCache ??= this.db.prepare('SELECT * FROM mem_entities').all() as unknown as EntityRow[];
  }
  private namesOf(e: EntityRow): string[] { return [e.name, ...(JSON.parse(e.aliases) as string[])].filter(Boolean); }

  /** 登记一个人：QQ 号是身份，昵称会变，旧昵称留作别名，所以改名不断链。 */
  registerPerson(qq: string, ...names: string[]) {
    const key = `qq:${qq}`;
    const clean = names.map((n) => String(n ?? '').trim()).filter((n) => n && n !== qq);
    const cur = this.db.prepare('SELECT * FROM mem_entities WHERE key = ?').get(key) as unknown as EntityRow | undefined;
    if (!cur) {
      const r = this.db.prepare("INSERT INTO mem_entities (kind, key, name, aliases) VALUES ('person', ?, ?, ?)").run(key, clean[0] ?? qq, JSON.stringify(clean.slice(1)));
      this.entityCache = null;
      return Number(r.lastInsertRowid);
    }
    const known = new Set(this.namesOf(cur));
    const fresh = clean.filter((n) => !known.has(n));
    if (fresh.length) {
      const name = cur.name === qq ? fresh.shift()! : cur.name;
      this.db.prepare('UPDATE mem_entities SET name = ?, aliases = ? WHERE id = ?').run(name, JSON.stringify([...JSON.parse(cur.aliases), ...fresh].filter((n) => n !== name)), cur.id);
      this.entityCache = null;
    }
    return cur.id;
  }

  private topicEntity(name: string) {
    const key = `topic:${name.toLowerCase()}`;
    const hit = this.entities().find((e) => e.key === key || this.namesOf(e).some((n) => n === name));
    if (hit) return hit.id;
    const r = this.db.prepare("INSERT INTO mem_entities (kind, key, name) VALUES ('topic', ?, ?)").run(key, name);
    this.entityCache = null;
    return Number(r.lastInsertRowid);
  }

  /** 文本里出现的实体。同一称呼对应多个人时不判定，避免连错人。 */
  entitiesIn(text: string) {
    const t = text.toLowerCase();
    const byName = new Map<string, EntityRow[]>();
    for (const e of this.entities()) for (const n of this.namesOf(e)) if ([...n].length >= 2 && t.includes(n.toLowerCase())) byName.set(n, [...(byName.get(n) ?? []), e]);
    const out = new Map<number, EntityRow>();
    const names: string[] = [];
    for (const [n, list] of byName) { names.push(n); if (list.length === 1) out.set(list[0].id, list[0]); }
    return { entities: [...out.values()], names };
  }

  /** 重建一条记忆的边和索引。 */
  private link(r: Pick<MemoryRow, 'id' | 'content' | 'tags' | 'subject' | 'attr'>) {
    this.db.prepare("DELETE FROM mem_edges WHERE src = ? AND rel <> 'supersedes'").run(r.id);
    const edge = this.db.prepare("INSERT OR IGNORE INTO mem_edges (src, rel, dst_kind, dst) VALUES (?, ?, 'e', ?)");
    if (r.subject) edge.run(r.id, 'about', this.registerPerson(r.subject));
    for (const name of wikiLinks(r.content)) {
      const person = this.entitiesIn(name).entities.find((e) => this.namesOf(e).includes(name));
      edge.run(r.id, 'link', person?.id ?? this.topicEntity(name));
    }
    for (const e of this.entitiesIn(plainContent(r.content)).entities) edge.run(r.id, 'mentions', e.id);
    for (const t of r.tags.split(',').filter(Boolean)) edge.run(r.id, 'tag', this.topicEntity(t));
    this.db.prepare('DELETE FROM mem_search WHERE rowid = ?').run(r.id);
    this.db.prepare('INSERT INTO mem_search (rowid, terms) VALUES (?, ?)').run(r.id, indexTerms(this.searchText(r)));
    this.graph = null;
  }

  /** 参与检索的文本：带上主体名字和属性，「老王是做什么的」才能搜到只写了「开奶茶店」的记忆。 */
  private searchText(r: Pick<MemoryRow, 'content' | 'tags' | 'subject' | 'attr'>) {
    const e = r.subject ? this.entities().find((x) => x.key === `qq:${r.subject}`) : undefined;
    return [plainContent(r.content), r.tags.replace(/,/g, ' '), r.attr, ...(e ? this.namesOf(e) : [])].filter(Boolean).join(' ');
  }

  // ------------------------------------------------------------ 增删改
  get(id: number): MemoryRow | undefined {
    return this.db.prepare('SELECT * FROM mem_items WHERE id = ?').get(id) as MemoryRow | undefined;
  }

  /**
   * 写入：高度相似的合并；同一 attr 的新值替代旧值；相近但不确定的列给调用方判断。
   * 低可信度的来源不能替代高可信度的记忆，防止群友改写管理员确认过的事实。
   */
  remember(input: RememberInput, now = Date.now()): RememberResult {
    const content = input.content.trim();
    if (!content) throw new Error('记忆内容为空');
    const scope = input.scope || 'global';
    const subject = input.subject ?? '';
    const kind = input.kind ?? 'fact';
    const attr = (input.attr ?? '').trim();
    const source = input.source ?? '';
    const trust = input.trust ?? trustFromSource(source, kind);
    const tags = (Array.isArray(input.tags) ? input.tags : String(input.tags ?? '').split(/[,，\s]+/)).map((t) => t.trim()).filter(Boolean).join(',');
    const importance = Math.round(Math.min(5, Math.max(1, input.importance ?? 3)));
    const tk = tokens(plainContent(content));
    const peers = this.db.prepare('SELECT * FROM mem_items WHERE scope = ? AND subject = ? AND valid_to = 0').all(scope, subject) as unknown as MemoryRow[];
    let best: MemoryRow | undefined; let bestSim = 0;
    const similar: RememberResult['similar'] = [];
    for (const c of peers) {
      const sim = jaccard(tk, tokens(plainContent(c.content)));
      if (sim > bestSim) { bestSim = sim; best = c; }
      if (subject && sim >= SIMILAR_FLOOR && sim < this.opts.dedupThreshold) similar.push({ id: c.id, content: c.content });
    }
    if (best && bestSim >= this.opts.dedupThreshold) {
      const mergedTags = [...new Set([...best.tags.split(','), ...tags.split(',')].filter(Boolean))].join(',');
      this.db.prepare('UPDATE mem_items SET content = ?, tags = ?, importance = MAX(importance, ?), pinned = MAX(pinned, ?), kind = ?, attr = ?, archived = 0 WHERE id = ?')
        .run(content.length >= best.content.length ? content : best.content, mergedTags, importance, input.pinned ? 1 : 0, kind, attr || best.attr, best.id);
      this.reinforce(best.id, now);
      if (input.embedding) this.setEmbedding(best.id, input.embedding, input.embedModel);
      this.link(this.get(best.id)!);
      return { id: best.id, merged: true, superseded: [], blocked: [], similar: [] };
    }
    const targets = [...(attr ? peers.filter((p) => p.attr === attr) : []), ...(input.supersedes ? [this.get(input.supersedes)].filter((x): x is MemoryRow => !!x && !x.valid_to) : [])];
    const allowed = targets.filter((t) => TRUST_RANK[trust] >= TRUST_RANK[t.trust]);
    const blocked = targets.filter((t) => !allowed.includes(t)).map((t) => t.id);
    const r = this.db.prepare(`INSERT INTO mem_items (scope, subject, kind, content, tags, importance, stability, created, last_access, source, pinned, embedding, embed_model, attr, valid_from, trust, source_msg)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(scope, subject, kind, content, tags, importance, this.initialStability(importance, kind), now, now,
      source, input.pinned ? 1 : 0, input.embedding ? new Uint8Array(input.embedding.buffer) : null, input.embedding ? input.embedModel ?? '' : '', blocked.length ? '' : attr, now, trust, input.sourceMsg ?? '');
    const id = Number(r.lastInsertRowid);
    for (const t of allowed) this.supersede(t.id, id, now);
    this.link(this.get(id)!);
    return { id, merged: false, superseded: allowed.map((t) => t.id), blocked, similar: similar.filter((s) => !allowed.some((t) => t.id === s.id)) };
  }

  /** 让旧记忆失效：不删除，保留时间线。 */
  supersede(oldId: number, newId: number, now = Date.now()) {
    this.db.prepare('UPDATE mem_items SET valid_to = ?, superseded_by = ? WHERE id = ?').run(now, newId, oldId);
    this.db.prepare("INSERT OR IGNORE INTO mem_edges (src, rel, dst_kind, dst) VALUES (?, 'supersedes', 'm', ?)").run(newId, oldId);
    this.graph = null;
  }

  /** 恢复被替代的记忆。 */
  restore(id: number) {
    this.db.prepare('UPDATE mem_items SET valid_to = 0, superseded_by = 0 WHERE id = ?').run(id);
    this.db.prepare("DELETE FROM mem_edges WHERE rel = 'supersedes' AND dst_kind = 'm' AND dst = ?").run(id);
    this.graph = null;
  }

  update(id: number, patch: Partial<Pick<MemoryRow, 'content' | 'tags' | 'importance' | 'pinned' | 'kind' | 'scope' | 'subject' | 'attr'>>) {
    const r = this.get(id);
    if (!r) throw new Error(`记忆 #${id} 不存在`);
    const next = { ...r, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
    this.db.prepare('UPDATE mem_items SET content = ?, tags = ?, importance = ?, pinned = ?, kind = ?, scope = ?, subject = ?, attr = ? WHERE id = ?')
      .run(next.content, next.tags, next.importance, next.pinned ? 1 : 0, next.kind, next.scope, next.subject, next.attr, id);
    if (patch.content !== undefined) this.db.prepare("UPDATE mem_items SET embedding = NULL, embed_model = '' WHERE id = ?").run(id);
    this.link(next);
  }

  setEmbedding(id: number, v: Float32Array, model = '') { this.db.prepare('UPDATE mem_items SET embedding = ?, embed_model = ? WHERE id = ?').run(new Uint8Array(v.buffer), model, id); }

  archive(id: number, archived = true) { return this.db.prepare('UPDATE mem_items SET archived = ? WHERE id = ?').run(archived ? 1 : 0, id).changes > 0; }

  purge(id: number) {
    this.db.prepare('DELETE FROM mem_edges WHERE src = ?').run(id);
    this.db.prepare("DELETE FROM mem_edges WHERE dst_kind = 'm' AND dst = ?").run(id);
    this.db.prepare('DELETE FROM mem_search WHERE rowid = ?').run(id);
    this.graph = null;
    return this.db.prepare('DELETE FROM mem_items WHERE id = ?').run(id).changes > 0;
  }

  // ------------------------------------------------------------ 检索
  private rows(q: RecallQuery, now: number) {
    const where: string[] = []; const args: any[] = [];
    if (!q.includeArchived) where.push('archived = 0');
    if (!q.includeHistory) where.push('valid_to = 0');
    const scopes = q.scopes ?? (q.scope ? [q.scope] : undefined);
    if (scopes?.length) { where.push(`scope IN (${scopes.map(() => '?').join(',')})`); args.push(...scopes); }
    if (q.subject) { where.push('subject = ?'); args.push(q.subject); }
    if (q.kind) { where.push('kind = ?'); args.push(q.kind); }
    const rows = this.db.prepare(`SELECT * FROM mem_items ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`).all(...args) as unknown as MemoryRow[];
    return rows.filter((r) => (q.includeForgotten || !this.view(r, now).forgotten) && (!q.visible || q.visible(r.scope)));
  }

  /** 查询核心词里有多少出现在这条记忆中。 */
  private coverage(r: MemoryRow, words: string[]) {
    if (!words.length) return 1;
    const text = this.searchText(r).toLowerCase();
    return words.filter((w) => text.includes(w)).length / words.length;
  }

  private lexical(query: string, names: string[], pool: Map<number, MemoryRow>) {
    const expr = matchExpr(query);
    if (!expr) return [];
    let hits: { id: number }[];
    try { hits = this.db.prepare('SELECT rowid AS id FROM mem_search WHERE mem_search MATCH ? ORDER BY bm25(mem_search) LIMIT 80').all(expr) as any[]; } catch { return []; }
    const words = coreWords(query, names);
    const out: number[] = [];
    for (const { id } of hits) {
      const r = pool.get(Number(id));
      if (!r) continue;
      // 全文检索是「命中任意词」，这里再确认查询的主要内容确实被覆盖，否则「量子计算机」会搜出「计算机专业」
      if (words.length ? this.coverage(r, words) >= MIN_COVERAGE : names.length > 0) out.push(r.id);
    }
    return out;
  }

  private byEntities(entities: EntityRow[], pool: Map<number, MemoryRow>) {
    if (!entities.length) return [];
    const ids = entities.map((e) => e.id);
    const edges = this.db.prepare(`SELECT src, rel FROM mem_edges WHERE dst_kind = 'e' AND dst IN (${ids.map(() => '?').join(',')})`).all(...ids) as any[];
    const rank = new Map<number, number>();
    for (const e of edges) {
      const r = pool.get(Number(e.src));
      if (r) rank.set(r.id, Math.max(rank.get(r.id) ?? 0, (e.rel === 'about' ? 1 : 0.5) * r.importance));
    }
    return [...rank].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([id]) => id);
  }

  private adjacency() {
    if (this.graph) return this.graph;
    const g = new Map<string, string[]>();
    const add = (a: string, b: string) => { g.set(a, [...(g.get(a) ?? []), b]); };
    for (const e of this.db.prepare("SELECT src, dst FROM mem_edges WHERE dst_kind = 'e' AND rel IN ('about', 'mentions', 'link')").all() as any[]) {
      add(`m${e.src}`, `e${e.dst}`); add(`e${e.dst}`, `m${e.src}`);
    }
    return this.graph = g;
  }

  /** 个性化 PageRank：从查询命中的实体和记忆出发扩散，能走到「小明→女朋友→小红→过敏」这样的第二跳。 */
  private spread(seeds: Map<string, number>, pool: Map<number, MemoryRow>) {
    if (!seeds.size) return [];
    const g = this.adjacency();
    let cur = new Map(seeds);
    const total = new Map<string, number>();
    for (let step = 0; step < GRAPH_STEPS; step++) {
      const next = new Map<string, number>();
      for (const [node, w] of cur) {
        const near = (g.get(node) ?? []).filter((n) => n[0] === 'e' || pool.has(Number(n.slice(1))));
        for (const n of near) next.set(n, (next.get(n) ?? 0) + (w * (1 - GRAPH_RESTART)) / near.length);
      }
      for (const [n, w] of next) total.set(n, (total.get(n) ?? 0) + w);
      cur = next;
    }
    return [...total].filter(([n]) => n[0] === 'm').sort((a, b) => b[1] - a[1]).slice(0, 30).map(([n]) => Number(n.slice(1)));
  }

  private vector(query: Float32Array, q: RecallQuery, pool: Map<number, MemoryRow>) {
    const scored: [number, number][] = [];
    for (const r of pool.values()) {
      if (!r.embedding || (q.embedModel && r.embed_model !== q.embedModel)) continue; // 不同模型的向量不能比较
      const sim = cosine(query, new Float32Array(r.embedding.buffer.slice(r.embedding.byteOffset, r.embedding.byteOffset + r.embedding.byteLength)));
      if (sim >= MIN_COSINE) scored.push([r.id, sim]);
    }
    return scored.sort((a, b) => b[1] - a[1]).slice(0, 30).map(([id]) => id);
  }

  recall(q: RecallQuery, now = Date.now()): MemoryView[] {
    const queries = [q.query, ...(q.queries ?? [])].map((s) => (s ?? '').trim()).filter(Boolean);
    const rows = this.rows(q, now);
    const limit = q.limit ?? 10;
    const finish = (list: MemoryView[]) => {
      if (q.reinforce !== false) for (const m of list) this.reinforce(m.id, now);
      return list;
    };
    if (!queries.length) {
      return finish(rows.map((r) => this.view(r, now)).map((v) => ({ ...v, score: v.retention * 0.5 + (v.importance / 5) * 0.5 + (v.pinned ? 0.1 : 0) }))
        .sort((a, b) => b.score! - a.score!).slice(0, limit));
    }
    const pool = new Map(rows.map((r) => [r.id, r]));
    const use = (c: Channel) => q.channels?.[c] !== false;
    const scores = new Map<number, number>();
    const why = new Map<number, Set<string>>();
    const addList = (channel: Channel, ids: number[]) => ids.forEach((id, i) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + i + 1));
      why.set(id, (why.get(id) ?? new Set()).add(CHANNEL_LABEL[channel]));
    });
    const coreSets: string[][] = [];
    for (const query of queries) {
      const { entities, names } = this.entitiesIn(query);
      coreSets.push(coreWords(query, names));
      const lexical = use('lexical') ? this.lexical(query, names, pool) : [];
      const entity = use('entity') ? this.byEntities(entities, pool) : [];
      addList('lexical', lexical);
      addList('entity', entity);
      if (use('graph')) {
        const seeds = new Map<string, number>();
        for (const e of entities) seeds.set(`e${e.id}`, 1);
        lexical.slice(0, 5).forEach((id, i) => seeds.set(`m${id}`, 1 / (i + 1)));
        addList('graph', this.spread(seeds, pool));
      }
    }
    if (use('vector')) for (const v of q.queryEmbeddings ?? []) addList('vector', this.vector(v, q, pool));
    const out: MemoryView[] = [];
    for (const [id, rrf] of scores) {
      const v = this.view(pool.get(id)!, now);
      // 只因提到某人被召回的记忆，要排在真正回答了问题的记忆后面
      const answered = 0.5 + 0.5 * Math.max(...coreSets.map((words) => this.coverage(pool.get(id)!, words)));
      out.push({ ...v, relevance: rrf, why: [...why.get(id)!], score: rrf * answered * (0.7 + 0.3 * v.retention) * (0.85 + 0.03 * v.importance) * TRUST_WEIGHT[v.trust] * (v.pinned ? 1.1 : 1) });
    }
    out.sort((a, b) => b.score! - a.score!);
    // 近似重复只留排名靠前的，把位置让给不同的信息
    const kept: MemoryView[] = [];
    const seen: Set<string>[] = [];
    for (const m of out) {
      const t = tokens(plainContent(m.content));
      if (seen.some((s) => jaccard(s, t) >= NEAR_DUPLICATE)) continue;
      kept.push(m); seen.push(t);
      if (kept.length >= limit) break;
    }
    return finish(kept);
  }

  /** 一个人的关键事实：有属性的优先（称呼、住址这类），其次看重要度。 */
  personFacts(subject: string, scopes: string[], limit: number, now = Date.now()) {
    return this.rows({ subject, scopes }, now).map((r) => this.view(r, now))
      .sort((a, b) => Number(!!b.attr) - Number(!!a.attr) || b.importance - a.importance || b.created - a.created).slice(0, limit);
  }

  /** 嵌入用的文本：带上主体名字和属性，脱离上下文也能看懂这条记忆在说谁。 */
  embedText(r: Pick<MemoryRow, 'content' | 'tags' | 'subject' | 'attr'>) { return this.searchText(r); }

  /** 需要（重新）计算向量的记忆。 */
  pendingEmbeddings(model: string, limit: number) {
    return this.db.prepare('SELECT * FROM mem_items WHERE archived = 0 AND valid_to = 0 AND (embedding IS NULL OR embed_model <> ?) LIMIT ?').all(model, limit) as unknown as MemoryRow[];
  }

  // ------------------------------------------------------------ 关联网络
  /** 关联网络：记忆和实体两类节点。只保留连了记忆的实体，按连接数取前 limit 个。 */
  graphView(o: { visible?: (scope: string) => boolean; scope?: string; includeExpired?: boolean; includeArchived?: boolean; center?: string; depth?: number; limit?: number; kinds?: string[] } = {}) {
    const rows = (this.db.prepare('SELECT * FROM mem_items').all() as unknown as MemoryRow[])
      .filter((r) => (o.includeArchived || !r.archived) && (o.includeExpired || !r.valid_to) && (!o.scope || r.scope === o.scope) && (!o.visible || o.visible(r.scope)) && (!o.kinds?.length || o.kinds.includes(r.kind)));
    const memIds = new Set(rows.map((r) => r.id));
    const entities = new Map(this.entities().map((e) => [e.id, e]));
    const edges: { source: string; target: string; rel: string }[] = [];
    for (const e of this.db.prepare('SELECT * FROM mem_edges').all() as any[]) {
      if (!memIds.has(Number(e.src))) continue;
      const target = `${e.dst_kind}${e.dst}`;
      if (e.dst_kind === 'm' ? !memIds.has(Number(e.dst)) : !entities.has(Number(e.dst))) continue;
      edges.push({ source: `m${e.src}`, target, rel: e.rel });
    }
    let keep = new Set<string>([...memIds].map((id) => `m${id}`));
    for (const e of edges) keep.add(e.target);
    if (o.center && keep.has(o.center)) {
      let frontier = new Set([o.center]);
      const near = new Set(frontier);
      for (let d = 0; d < Math.max(1, o.depth ?? 2); d++) {
        const next = new Set<string>();
        for (const e of edges) {
          if (frontier.has(e.source) && !near.has(e.target)) next.add(e.target);
          if (frontier.has(e.target) && !near.has(e.source)) next.add(e.source);
        }
        for (const n of next) near.add(n);
        frontier = next;
      }
      keep = near;
    }
    const degree = new Map<string, number>();
    for (const e of edges) if (keep.has(e.source) && keep.has(e.target)) { degree.set(e.source, (degree.get(e.source) ?? 0) + 1); degree.set(e.target, (degree.get(e.target) ?? 0) + 1); }
    const total = keep.size;
    const limit = o.limit ?? 400;
    const chosen = new Set([...keep].sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0)).slice(0, limit));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const nodes = [...chosen].map((id) => {
      if (id[0] === 'e') {
        const e = entities.get(Number(id.slice(1)))!;
        return { id, type: e.kind, label: e.name, degree: degree.get(id) ?? 0, aliases: JSON.parse(e.aliases) as string[], key: e.key };
      }
      const r = byId.get(Number(id.slice(1)))!;
      const v = this.view(r);
      return { id, type: 'memory', label: plainContent(r.content), degree: degree.get(id) ?? 0, kind: r.kind, scope: r.scope, importance: r.importance, trust: r.trust, attr: r.attr, expired: v.expired, archived: !!r.archived, retention: v.retention, pinned: !!r.pinned };
    });
    return { nodes, edges: edges.filter((e) => chosen.has(e.source) && chosen.has(e.target)), total, truncated: total > chosen.size };
  }

  /** 一条记忆的完整上下文：连着谁、替代了谁、被谁替代、和哪些记忆有共同实体（反向链接）。 */
  memoryDetail(id: number, visible?: (scope: string) => boolean) {
    const r = this.get(id);
    if (!r || (visible && !visible(r.scope))) return null;
    const ok = (x: MemoryRow | undefined) => !!x && (!visible || visible(x.scope));
    const edges = this.db.prepare("SELECT rel, dst FROM mem_edges WHERE src = ? AND dst_kind = 'e'").all(id) as any[];
    const entities = edges.map((e) => { const x = this.entities().find((n) => n.id === Number(e.dst)); return x && { id: x.id, kind: x.kind, name: x.name, rel: e.rel as string }; }).filter(Boolean);
    const replaced = (this.db.prepare("SELECT dst FROM mem_edges WHERE src = ? AND rel = 'supersedes'").all(id) as any[]).map((e) => this.get(Number(e.dst))).filter(ok);
    const ids = edges.map((e) => Number(e.dst));
    const related = ids.length ? (this.db.prepare(`SELECT DISTINCT src FROM mem_edges WHERE dst_kind = 'e' AND rel <> 'tag' AND dst IN (${ids.map(() => '?').join(',')}) AND src <> ? LIMIT 40`).all(...ids, id) as any[]).map((e) => this.get(Number(e.src))).filter(ok) : [];
    const brief = (m: MemoryRow | undefined) => m && ({ id: m.id, content: m.content, scope: m.scope, expired: m.valid_to > 0 });
    return { memory: this.view(r), entities, supersededBy: r.superseded_by ? brief(this.get(r.superseded_by)) : null, replaced: replaced.map(brief), related: related.map(brief) };
  }

  entityDetail(id: number, visible?: (scope: string) => boolean) {
    const e = this.entities().find((x) => x.id === id);
    if (!e) return null;
    const rows = (this.db.prepare(`SELECT DISTINCT m.* FROM mem_items m JOIN mem_edges g ON g.src = m.id WHERE g.dst_kind = 'e' AND g.dst = ? ORDER BY m.importance DESC, m.created DESC LIMIT 200`).all(id) as unknown as MemoryRow[]).filter((r) => !visible || visible(r.scope));
    return { id: e.id, kind: e.kind, key: e.key, name: e.name, aliases: JSON.parse(e.aliases) as string[], memories: rows.map((r) => this.view(r)) };
  }

  /** 按名字找实体，供 Agent 查看某人或某话题的关联。 */
  findEntity(name: string) {
    const n = name.trim().toLowerCase();
    return this.entities().find((e) => e.key === `qq:${n}` || this.namesOf(e).some((x) => x.toLowerCase() === n));
  }

  addAlias(id: number, alias: string) {
    const e = this.entities().find((x) => x.id === id);
    if (!e) throw new Error('实体不存在');
    const name = alias.trim();
    if (name && !this.namesOf(e).includes(name)) this.db.prepare('UPDATE mem_entities SET aliases = ? WHERE id = ?').run(JSON.stringify([...JSON.parse(e.aliases), name]), id);
    this.relinkAll();
  }

  /** 合并重复实体：drop 的名字并入 keep 的别名，边全部改连 keep。 */
  mergeEntities(keep: number, drop: number) {
    if (keep === drop) throw new Error('不能合并到自身');
    const a = this.entities().find((x) => x.id === keep), b = this.entities().find((x) => x.id === drop);
    if (!a || !b) throw new Error('实体不存在');
    if (a.kind === 'person' && b.kind === 'person') throw new Error('两个 QQ 号是不同的人，不能合并');
    const [target, gone] = b.kind === 'person' ? [b, a] : [a, b];
    this.db.prepare("UPDATE OR IGNORE mem_edges SET dst = ? WHERE dst_kind = 'e' AND dst = ?").run(target.id, gone.id);
    this.db.prepare("DELETE FROM mem_edges WHERE dst_kind = 'e' AND dst = ?").run(gone.id);
    this.db.prepare('UPDATE mem_entities SET aliases = ? WHERE id = ?').run(JSON.stringify([...new Set([...JSON.parse(target.aliases), ...this.namesOf(gone)])].filter((n) => n !== target.name)), target.id);
    this.db.prepare('DELETE FROM mem_entities WHERE id = ?').run(gone.id);
    this.relinkAll();
    return target.id;
  }

  private relinkAll() { this.entityCache = null; this.graph = null; for (const r of this.db.prepare('SELECT * FROM mem_items').all() as unknown as MemoryRow[]) this.link(r); }

  /** 管理员规则：直接查询，数量不受普通记忆影响。 */
  rules(conv: string) {
    return (this.db.prepare("SELECT * FROM mem_items WHERE kind = 'rule' AND archived = 0 AND valid_to = 0 AND scope IN (?, 'global') ORDER BY id").all(conv) as unknown as MemoryRow[]).map((r) => this.view(r));
  }

  /** 整理：把已遗忘的事件、待办、笔记归档。返回归档数量。 */
  sweep(now = Date.now()): number {
    if (!this.opts.forgetting) return 0;
    let n = 0;
    for (const r of this.db.prepare('SELECT * FROM mem_items WHERE archived = 0 AND pinned = 0 AND valid_to = 0').all() as unknown as MemoryRow[]) {
      if (this.view(r, now).forgotten) { this.archive(r.id); n++; }
    }
    return n;
  }

  rebuildIndex() {
    this.entityCache = null;
    this.db.exec('DELETE FROM mem_search');
    const rows = this.db.prepare('SELECT * FROM mem_items').all() as unknown as MemoryRow[];
    for (const r of rows) if (r.subject) this.registerPerson(r.subject);
    for (const r of rows) this.link(r);
  }

  /** 索引概览：按范围/主体/类型统计，常用标签。 */
  overview(scope?: string) {
    const where = scope ? 'WHERE archived = 0 AND valid_to = 0 AND scope = ?' : 'WHERE archived = 0 AND valid_to = 0';
    const args = scope ? [scope] : [];
    const byScope = this.db.prepare(`SELECT scope, COUNT(*) n FROM mem_items ${where} GROUP BY scope ORDER BY n DESC LIMIT 50`).all(...args) as any[];
    const bySubject = this.db.prepare(`SELECT scope, subject, COUNT(*) n FROM mem_items ${where} AND subject <> '' GROUP BY scope, subject ORDER BY n DESC LIMIT 50`).all(...args) as any[];
    const byKind = this.db.prepare(`SELECT kind, COUNT(*) n FROM mem_items ${where} GROUP BY kind`).all(...args) as any[];
    const tagCount = new Map<string, number>();
    for (const r of this.db.prepare(`SELECT tags FROM mem_items ${where}`).all(...args) as any[]) for (const t of String(r.tags).split(',').filter(Boolean)) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
    const total = Number((this.db.prepare(`SELECT COUNT(*) n FROM mem_items ${where}`).get(...args) as any).n);
    const archived = Number((this.db.prepare('SELECT COUNT(*) n FROM mem_items WHERE archived = 1').get() as any).n);
    const superseded = Number((this.db.prepare('SELECT COUNT(*) n FROM mem_items WHERE valid_to > 0').get() as any).n);
    const now = Date.now();
    let fading = 0;
    for (const r of this.db.prepare(`SELECT * FROM mem_items ${where}`).all(...args) as unknown as MemoryRow[]) {
      if (this.archivable(r) && !this.view(r, now).forgotten && this.retention(r, now) < this.opts.archiveBelow + 0.15) fading++;
    }
    return { total, archived, superseded, fading, byScope, bySubject, byKind, tags: [...tagCount].sort((a, b) => b[1] - a[1]).slice(0, 30) };
  }

  list(opts: { scope?: string; subject?: string; q?: string; archived?: boolean; limit?: number; offset?: number }) {
    const where: string[] = [opts.archived ? 'archived = 1' : 'archived = 0']; const args: any[] = [];
    if (opts.scope) { where.push('scope = ?'); args.push(opts.scope); }
    if (opts.subject) { where.push('subject = ?'); args.push(opts.subject); }
    if (opts.q) { where.push('(content LIKE ? OR tags LIKE ?)'); args.push(`%${opts.q}%`, `%${opts.q}%`); }
    const rows = this.db.prepare(`SELECT * FROM mem_items WHERE ${where.join(' AND ')} ORDER BY last_access DESC LIMIT ? OFFSET ?`).all(...args, opts.limit ?? 200, opts.offset ?? 0) as unknown as MemoryRow[];
    return rows.map((r) => this.view(r));
  }
}
