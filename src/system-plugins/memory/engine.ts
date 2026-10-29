import type { DatabaseSync } from 'node:sqlite';

/**
 * 记忆引擎（与插件框架无关，便于单测与复用）。
 *
 * 遗忘模型（Ebbinghaus / 间隔重复）：
 *   保持率 R(t) = exp(-Δt / S)，Δt 为距上次访问的天数，S 为记忆稳定度（天）。
 *   初始 S = base × 2^(重要度-1)；每次被成功回忆，S ← S × (1 + growth × (1 - R) + 0.05)
 *   —— 越接近遗忘时复习，强化越多（间隔效应）。钉住(pinned)的记忆不衰减。
 *   R < 阈值视为"已遗忘"：默认不参与回忆，定期整理时归档（不删除，可找回）。
 *
 * 检索：FTS5(trigram) 召回 + 中文二元组/词重叠打分，可选向量语义相似度；
 *   综合分 = w相关 × 相关度 + w保持 × R + w重要 × 重要度/5
 */

export type MemoryKind = 'fact' | 'preference' | 'event' | 'relation' | 'task' | 'note' | 'rule';
export const KINDS: MemoryKind[] = ['fact', 'preference', 'event', 'relation', 'task', 'note', 'rule'];
/** Agent 可写的类型（rule 只能由管理员通过命令/控制台设定） */
export const AGENT_KINDS = KINDS.filter((k) => k !== 'rule');
export const KIND_LABEL: Record<MemoryKind, string> = { fact: '事实', preference: '偏好', event: '事件', relation: '关系', task: '待办', note: '笔记', rule: '管理员规则' };

export interface MemoryRow {
  id: number; scope: string; subject: string; kind: MemoryKind; content: string; tags: string; importance: number;
  stability: number; created: number; last_access: number; access_count: number; source: string; pinned: number; archived: number;
  embedding: Uint8Array | null;
}

export interface MemoryView extends Omit<MemoryRow, 'embedding'> { retention: number; forgotten: boolean; score?: number; relevance?: number }

export interface EngineOptions {
  forgetting: boolean;
  baseStabilityDays: number;
  growth: number;
  forgetThreshold: number;
  dedupThreshold: number;
  wRelevance: number;
  wRetention: number;
  wImportance: number;
}

const DAY = 86_400_000;

export function tokens(text: string): Set<string> {
  const s = text.toLowerCase();
  const out = new Set<string>();
  for (const w of s.match(/[a-z0-9_]+/g) ?? []) if (w.length > 1) out.add(w);
  const cjk = s.match(/[㐀-鿿豈-﫿]+/g) ?? [];
  for (const run of cjk) {
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
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
}

export class MemoryEngine {
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
      CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(content, tags, content='mem_items', content_rowid='id', tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS mem_ai AFTER INSERT ON mem_items BEGIN
        INSERT INTO mem_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags); END;
      CREATE TRIGGER IF NOT EXISTS mem_ad AFTER DELETE ON mem_items BEGIN
        INSERT INTO mem_fts(mem_fts, rowid, content, tags) VALUES ('delete', old.id, old.content, old.tags); END;
      CREATE TRIGGER IF NOT EXISTS mem_au AFTER UPDATE OF content, tags ON mem_items BEGIN
        INSERT INTO mem_fts(mem_fts, rowid, content, tags) VALUES ('delete', old.id, old.content, old.tags);
        INSERT INTO mem_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags); END;
    `);
  }

  // ------------------------------------------------------------ 遗忘曲线
  initialStability(importance: number) {
    return this.opts.baseStabilityDays * 2 ** (Math.min(5, Math.max(1, importance)) - 1);
  }

  retention(r: Pick<MemoryRow, 'stability' | 'last_access' | 'pinned'>, now = Date.now()) {
    if (!this.opts.forgetting || r.pinned) return 1;
    return Math.exp(-Math.max(0, now - r.last_access) / DAY / Math.max(0.01, r.stability));
  }

  view(r: MemoryRow, now = Date.now()): MemoryView {
    const { embedding, ...rest } = r;
    const retention = this.retention(r, now);
    return { ...rest, retention, forgotten: retention < this.opts.forgetThreshold };
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

  // ------------------------------------------------------------ 增删改
  get(id: number): MemoryRow | undefined {
    return this.db.prepare('SELECT * FROM mem_items WHERE id = ?').get(id) as MemoryRow | undefined;
  }

  /** 写入；与同范围同主体的高度相似记忆合并（强化+更新内容）而不是重复插入。 */
  remember(input: { content: string; scope?: string; subject?: string; kind?: MemoryKind; tags?: string[] | string; importance?: number; pinned?: boolean; source?: string; embedding?: Float32Array | null }, now = Date.now()): { id: number; merged: boolean } {
    const content = input.content.trim();
    if (!content) throw new Error('记忆内容为空');
    const scope = input.scope || 'global';
    const subject = input.subject ?? '';
    const tags = (Array.isArray(input.tags) ? input.tags : String(input.tags ?? '').split(/[,，\s]+/)).map((t) => t.trim()).filter(Boolean).join(',');
    const importance = Math.round(Math.min(5, Math.max(1, input.importance ?? 3)));
    const tk = tokens(content);
    const cands = this.db.prepare('SELECT * FROM mem_items WHERE scope = ? AND subject = ?').all(scope, subject) as unknown as MemoryRow[];
    let best: MemoryRow | undefined; let bestSim = 0;
    for (const c of cands) { const sim = jaccard(tk, tokens(c.content)); if (sim > bestSim) { bestSim = sim; best = c; } }
    if (best && bestSim >= this.opts.dedupThreshold) {
      const mergedTags = [...new Set([...best.tags.split(','), ...tags.split(',')].filter(Boolean))].join(',');
      this.db.prepare('UPDATE mem_items SET content = ?, tags = ?, importance = MAX(importance, ?), pinned = MAX(pinned, ?), kind = ?, archived = 0 WHERE id = ?')
        .run(content.length >= best.content.length ? content : best.content, mergedTags, importance, input.pinned ? 1 : 0, input.kind ?? best.kind, best.id);
      this.reinforce(best.id, now);
      if (input.embedding) this.setEmbedding(best.id, input.embedding);
      return { id: best.id, merged: true };
    }
    const r = this.db.prepare(`INSERT INTO mem_items (scope, subject, kind, content, tags, importance, stability, created, last_access, source, pinned, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(scope, subject, input.kind ?? 'fact', content, tags, importance, this.initialStability(importance), now, now,
      input.source ?? '', input.pinned ? 1 : 0, input.embedding ? new Uint8Array(input.embedding.buffer) : null);
    return { id: Number(r.lastInsertRowid), merged: false };
  }

  update(id: number, patch: Partial<Pick<MemoryRow, 'content' | 'tags' | 'importance' | 'pinned' | 'kind' | 'scope' | 'subject'>>) {
    const r = this.get(id);
    if (!r) throw new Error(`记忆 #${id} 不存在`);
    const next = { ...r, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
    this.db.prepare('UPDATE mem_items SET content = ?, tags = ?, importance = ?, pinned = ?, kind = ?, scope = ?, subject = ? WHERE id = ?')
      .run(next.content, next.tags, next.importance, next.pinned ? 1 : 0, next.kind, next.scope, next.subject, id);
    if (patch.content !== undefined) this.db.prepare('UPDATE mem_items SET embedding = NULL WHERE id = ?').run(id);
  }

  setEmbedding(id: number, v: Float32Array) { this.db.prepare('UPDATE mem_items SET embedding = ? WHERE id = ?').run(new Uint8Array(v.buffer), id); }

  archive(id: number, archived = true) { return this.db.prepare('UPDATE mem_items SET archived = ? WHERE id = ?').run(archived ? 1 : 0, id).changes > 0; }
  purge(id: number) { return this.db.prepare('DELETE FROM mem_items WHERE id = ?').run(id).changes > 0; }

  // ------------------------------------------------------------ 检索
  recall(q: { query?: string; scope?: string; scopes?: string[]; subject?: string; kind?: string; limit?: number; includeForgotten?: boolean; includeArchived?: boolean; queryEmbedding?: Float32Array | null; reinforce?: boolean }, now = Date.now()): MemoryView[] {
    const where: string[] = []; const args: any[] = [];
    if (!q.includeArchived) where.push('archived = 0');
    const scopes = q.scopes ?? (q.scope ? [q.scope] : undefined);
    if (scopes?.length) { where.push(`scope IN (${scopes.map(() => '?').join(',')})`); args.push(...scopes); }
    if (q.subject) { where.push('subject = ?'); args.push(q.subject); }
    if (q.kind) { where.push('kind = ?'); args.push(q.kind); }
    const query = (q.query ?? '').trim();
    let rows: MemoryRow[];
    const ftsIds = new Set<number>();
    if (query) {
      // FTS（≥3 字的词）+ LIKE（短词）双路召回，再统一打分
      const longTerms = query.split(/\s+/).filter((t) => [...t].length >= 3).map((t) => `"${t.replace(/"/g, '""')}"`);
      if (longTerms.length) {
        try { for (const r of this.db.prepare(`SELECT rowid FROM mem_fts WHERE mem_fts MATCH ? LIMIT 500`).all(longTerms.join(' OR ')) as any[]) ftsIds.add(Number(r.rowid)); } catch { /* 语法问题忽略 */ }
      }
    }
    rows = this.db.prepare(`SELECT * FROM mem_items ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`).all(...args) as unknown as MemoryRow[];
    const qt = tokens(query);
    const out: MemoryView[] = [];
    const w = this.opts;
    for (const r of rows) {
      const v = this.view(r, now);
      if (v.forgotten && !q.includeForgotten) continue;
      let rel = 1;
      if (query) {
        rel = overlap(qt, tokens(`${r.content} ${r.tags}`));
        if (ftsIds.has(r.id)) rel = Math.max(rel, 0.6) + 0.2;
        if (r.content.includes(query)) rel = Math.max(rel, 1);
        if (q.queryEmbedding && r.embedding) {
          const sim = cosine(q.queryEmbedding, new Float32Array(r.embedding.buffer.slice(r.embedding.byteOffset, r.embedding.byteOffset + r.embedding.byteLength)));
          rel = Math.max(rel, (sim - 0.2) / 0.6);
        }
        rel = Math.min(1, rel);
        if (rel < 0.25) continue;
      }
      v.relevance = rel;
      v.score = w.wRelevance * rel + w.wRetention * v.retention + w.wImportance * (r.importance / 5) + (r.pinned ? 0.1 : 0);
      out.push(v);
    }
    out.sort((a, b) => b.score! - a.score!);
    const top = out.slice(0, q.limit ?? 10);
    if (q.reinforce !== false) for (const m of top) this.reinforce(m.id, now);
    return top;
  }

  /** 整理：把已遗忘的记忆归档。返回归档数量。 */
  sweep(now = Date.now()): number {
    if (!this.opts.forgetting) return 0;
    let n = 0;
    for (const r of this.db.prepare('SELECT * FROM mem_items WHERE archived = 0 AND pinned = 0').all() as unknown as MemoryRow[]) {
      if (this.retention(r, now) < this.opts.forgetThreshold) { this.archive(r.id); n++; }
    }
    return n;
  }

  rebuildIndex() { this.db.exec(`INSERT INTO mem_fts(mem_fts) VALUES ('rebuild')`); }

  /** 索引概览：按范围/主体/类型统计，常用标签。 */
  overview(scope?: string) {
    const where = scope ? 'WHERE archived = 0 AND scope = ?' : 'WHERE archived = 0';
    const args = scope ? [scope] : [];
    const byScope = this.db.prepare(`SELECT scope, COUNT(*) n FROM mem_items ${where} GROUP BY scope ORDER BY n DESC LIMIT 50`).all(...args) as any[];
    const bySubject = this.db.prepare(`SELECT scope, subject, COUNT(*) n FROM mem_items ${where} AND subject <> '' GROUP BY scope, subject ORDER BY n DESC LIMIT 50`).all(...args) as any[];
    const byKind = this.db.prepare(`SELECT kind, COUNT(*) n FROM mem_items ${where} GROUP BY kind`).all(...args) as any[];
    const tagCount = new Map<string, number>();
    for (const r of this.db.prepare(`SELECT tags FROM mem_items ${where}`).all(...args) as any[]) for (const t of String(r.tags).split(',').filter(Boolean)) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
    const total = Number((this.db.prepare(`SELECT COUNT(*) n FROM mem_items ${where}`).get(...args) as any).n);
    const archived = Number((this.db.prepare('SELECT COUNT(*) n FROM mem_items WHERE archived = 1').get() as any).n);
    const now = Date.now();
    let fading = 0;
    for (const r of this.db.prepare(`SELECT * FROM mem_items ${where}`).all(...args) as unknown as MemoryRow[]) { const R = this.retention(r, now); if (R < 0.3 && R >= this.opts.forgetThreshold) fading++; }
    return { total, archived, fading, byScope, bySubject, byKind, tags: [...tagCount].sort((a, b) => b[1] - a[1]).slice(0, 30) };
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
