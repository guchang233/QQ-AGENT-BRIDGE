import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Segment } from '../message/segments.ts';

export interface MessageRow {
  seq: number;
  msg_id: string;
  conv: string;
  sender_id: string;
  sender_name: string;
  is_self: number;
  ts: number;
  segments: string;
  text: string;
  mentioned: number;
  recalled: number;
}

export interface StoredMessage {
  seq: number;
  msgId: string;
  conv: string;
  senderId: string;
  senderName: string;
  isSelf: boolean;
  ts: number;
  segments: Segment[];
  text: string;
  mentioned: boolean;
  recalled: boolean;
}

export interface MediaRow {
  ref: string; kind: string; conv: string; msg_id: string; url: string; file: string; file_id: string;
  summary: string; local_path: string; mime: string; size: number; sha: string; ts: number;
}

export interface StickerRow {
  id: number; sha: string; path: string; mime: string; remark: string; tags: string; uses: number; ts: number; source: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  msg_id TEXT NOT NULL, conv TEXT NOT NULL, sender_id TEXT NOT NULL, sender_name TEXT NOT NULL DEFAULT '',
  is_self INTEGER NOT NULL DEFAULT 0, ts INTEGER NOT NULL, segments TEXT NOT NULL, text TEXT NOT NULL,
  mentioned INTEGER NOT NULL DEFAULT 0, recalled INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_messages_conv_msg ON messages(conv, msg_id);
CREATE INDEX IF NOT EXISTS ix_messages_conv_seq ON messages(conv, seq);
CREATE INDEX IF NOT EXISTS ix_messages_conv_ts ON messages(conv, ts);
CREATE TABLE IF NOT EXISTS conversations (
  conv TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', last_seq INTEGER NOT NULL DEFAULT 0, last_ts INTEGER NOT NULL DEFAULT 0,
  read_seq INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS names (key TEXT PRIMARY KEY, name TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS media (
  ref TEXT PRIMARY KEY, kind TEXT NOT NULL, conv TEXT NOT NULL DEFAULT '', msg_id TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '', file TEXT NOT NULL DEFAULT '', file_id TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '',
  local_path TEXT NOT NULL DEFAULT '', mime TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0, sha TEXT NOT NULL DEFAULT '', ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS stickers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sha TEXT NOT NULL UNIQUE, path TEXT NOT NULL, mime TEXT NOT NULL DEFAULT '',
  remark TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '', uses INTEGER NOT NULL DEFAULT 0, ts INTEGER NOT NULL, source TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS memory (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (scope, key));
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, agent TEXT NOT NULL, tool TEXT NOT NULL, tier TEXT NOT NULL,
  params TEXT NOT NULL, ok INTEGER NOT NULL, result TEXT NOT NULL, ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_ts ON audit(ts);
CREATE TABLE IF NOT EXISTS kv (ns TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (ns, key));
`;

export class Store {
  db: DatabaseSync;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'qab.db'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
    this.db.exec(SCHEMA);
  }

  close() { this.db.close(); }

  // ---------- 消息 ----------
  insertMessage(m: Omit<StoredMessage, 'seq'>): StoredMessage | null {
    const r = this.db.prepare(`INSERT OR IGNORE INTO messages (msg_id, conv, sender_id, sender_name, is_self, ts, segments, text, mentioned)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(m.msgId, m.conv, m.senderId, m.senderName, m.isSelf ? 1 : 0, m.ts, JSON.stringify(m.segments), m.text, m.mentioned ? 1 : 0);
    if (!r.changes) return null;
    const seq = Number(r.lastInsertRowid);
    this.db.prepare(`INSERT INTO conversations (conv, last_seq, last_ts) VALUES (?, ?, ?)
      ON CONFLICT(conv) DO UPDATE SET
        last_seq = CASE WHEN excluded.last_ts >= conversations.last_ts THEN excluded.last_seq ELSE conversations.last_seq END,
        last_ts = MAX(conversations.last_ts, excluded.last_ts)`).run(m.conv, seq, m.ts);
    if (m.isSelf) this.markRead(m.conv, seq);
    return { ...m, seq };
  }

  markRecalled(conv: string, msgId: string) {
    this.db.prepare('UPDATE messages SET recalled = 1 WHERE conv = ? AND msg_id = ?').run(conv, msgId);
  }

  getMessage(msgId: string, conv?: string): StoredMessage | undefined {
    const row = (conv
      ? this.db.prepare('SELECT * FROM messages WHERE msg_id = ? AND conv = ?').get(msgId, conv)
      : this.db.prepare('SELECT * FROM messages WHERE msg_id = ? ORDER BY seq DESC LIMIT 1').get(msgId)) as MessageRow | undefined;
    return row ? toMsg(row) : undefined;
  }

  /** 最近 N 条（按时间正序返回）；beforeTs 用于向上翻页。 */
  recent(conv: string, limit = 30, beforeTs?: number): StoredMessage[] {
    const rows = (beforeTs
      ? this.db.prepare('SELECT * FROM messages WHERE conv = ? AND ts < ? ORDER BY ts DESC, seq DESC LIMIT ?').all(conv, beforeTs, limit)
      : this.db.prepare('SELECT * FROM messages WHERE conv = ? ORDER BY ts DESC, seq DESC LIMIT ?').all(conv, limit)) as unknown as MessageRow[];
    return rows.reverse().map(toMsg);
  }

  after(conv: string | null, afterSeq: number, limit = 100): StoredMessage[] {
    const rows = (conv
      ? this.db.prepare('SELECT * FROM messages WHERE conv = ? AND seq > ? ORDER BY seq ASC LIMIT ?').all(conv, afterSeq, limit)
      : this.db.prepare('SELECT * FROM messages WHERE seq > ? ORDER BY seq ASC LIMIT ?').all(afterSeq, limit)) as unknown as MessageRow[];
    return rows.map(toMsg);
  }

  maxSeq(): number {
    return Number((this.db.prepare('SELECT MAX(seq) AS m FROM messages').get() as any)?.m ?? 0);
  }

  search(q: string, conv?: string, limit = 50): StoredMessage[] {
    const like = `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
    const rows = (conv
      ? this.db.prepare("SELECT * FROM messages WHERE conv = ? AND text LIKE ? ESCAPE '\\' ORDER BY seq DESC LIMIT ?").all(conv, like, limit)
      : this.db.prepare("SELECT * FROM messages WHERE text LIKE ? ESCAPE '\\' ORDER BY seq DESC LIMIT ?").all(like, limit)) as unknown as MessageRow[];
    return rows.reverse().map(toMsg);
  }

  // ---------- 会话 ----------
  conversations(): { conv: string; name: string; lastSeq: number; lastTs: number; readSeq: number; unread: number; mentions: number; pinned: boolean; lastText: string; lastSender: string }[] {
    const rows = this.db.prepare(`SELECT c.*,
        (SELECT COUNT(*) FROM messages m WHERE m.conv = c.conv AND m.seq > c.read_seq AND m.is_self = 0) AS unread,
        (SELECT COUNT(*) FROM messages m WHERE m.conv = c.conv AND m.seq > c.read_seq AND m.mentioned = 1) AS mentions,
        (SELECT text FROM messages m WHERE m.seq = c.last_seq) AS last_text,
        (SELECT sender_name FROM messages m WHERE m.seq = c.last_seq) AS last_sender
      FROM conversations c ORDER BY c.pinned DESC, c.last_ts DESC`).all() as any[];
    return rows.map((r) => ({
      conv: r.conv, name: r.name, lastSeq: r.last_seq, lastTs: r.last_ts, readSeq: r.read_seq,
      unread: Number(r.unread), mentions: Number(r.mentions), pinned: !!r.pinned, lastText: r.last_text ?? '', lastSender: r.last_sender ?? '',
    }));
  }

  ensureConversation(conv: string, name?: string) {
    this.db.prepare(`INSERT INTO conversations (conv, name) VALUES (?, ?) ON CONFLICT(conv) DO UPDATE SET name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE conversations.name END`)
      .run(conv, name ?? '');
  }

  conversationName(conv: string): string {
    return (this.db.prepare('SELECT name FROM conversations WHERE conv = ?').get(conv) as any)?.name ?? '';
  }

  readSeq(conv: string): number {
    return Number((this.db.prepare('SELECT read_seq FROM conversations WHERE conv = ?').get(conv) as any)?.read_seq ?? 0);
  }

  markRead(conv: string, seq?: number) {
    if (seq === undefined) this.db.prepare('UPDATE conversations SET read_seq = last_seq WHERE conv = ?').run(conv);
    else this.db.prepare('UPDATE conversations SET read_seq = MAX(read_seq, ?) WHERE conv = ?').run(seq, conv);
  }

  markAllRead() { this.db.exec('UPDATE conversations SET read_seq = last_seq'); }

  setPinned(conv: string, pinned: boolean) { this.db.prepare('UPDATE conversations SET pinned = ? WHERE conv = ?').run(pinned ? 1 : 0, conv); }

  unread(conv: string | null, limit = 50): StoredMessage[] {
    const rows = (conv
      ? this.db.prepare(`SELECT m.* FROM messages m JOIN conversations c ON c.conv = m.conv WHERE m.conv = ? AND m.seq > c.read_seq AND m.is_self = 0 ORDER BY m.seq ASC LIMIT ?`).all(conv, limit)
      : this.db.prepare(`SELECT m.* FROM messages m JOIN conversations c ON c.conv = m.conv WHERE m.seq > c.read_seq AND m.is_self = 0 ORDER BY m.seq ASC LIMIT ?`).all(limit)) as unknown as MessageRow[];
    return rows.map(toMsg);
  }

  // ---------- 名字缓存 ----------
  setName(key: string, name: string) {
    if (!name) return;
    this.db.prepare('INSERT INTO names (key, name, ts) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET name = excluded.name, ts = excluded.ts').run(key, name, Date.now());
  }
  getName(key: string): string | undefined {
    return (this.db.prepare('SELECT name FROM names WHERE key = ?').get(key) as any)?.name;
  }

  // ---------- 媒体 ----------
  putMedia(m: Partial<MediaRow> & { ref: string; kind: string }) {
    this.db.prepare(`INSERT INTO media (ref, kind, conv, msg_id, url, file, file_id, summary, local_path, mime, size, sha, ts)
      VALUES (@ref, @kind, @conv, @msg_id, @url, @file, @file_id, @summary, @local_path, @mime, @size, @sha, @ts)
      ON CONFLICT(ref) DO UPDATE SET url = CASE WHEN excluded.url <> '' THEN excluded.url ELSE media.url END,
        local_path = CASE WHEN excluded.local_path <> '' THEN excluded.local_path ELSE media.local_path END,
        mime = CASE WHEN excluded.mime <> '' THEN excluded.mime ELSE media.mime END,
        size = CASE WHEN excluded.size > 0 THEN excluded.size ELSE media.size END,
        sha = CASE WHEN excluded.sha <> '' THEN excluded.sha ELSE media.sha END`).run({
      conv: '', msg_id: '', url: '', file: '', file_id: '', summary: '', local_path: '', mime: '', size: 0, sha: '', ts: Date.now(), ...m,
    } as any);
  }
  getMedia(ref: string): MediaRow | undefined {
    return this.db.prepare('SELECT * FROM media WHERE ref = ?').get(ref.replace(/^#/, '')) as MediaRow | undefined;
  }

  // ---------- 表情包库 ----------
  addSticker(s: Omit<StickerRow, 'id' | 'uses' | 'ts'>): StickerRow {
    const ex = this.db.prepare('SELECT * FROM stickers WHERE sha = ?').get(s.sha) as StickerRow | undefined;
    if (ex) {
      if (s.remark && !ex.remark) this.db.prepare('UPDATE stickers SET remark = ? WHERE id = ?').run(s.remark, ex.id);
      return { ...ex, remark: ex.remark || s.remark };
    }
    const r = this.db.prepare('INSERT INTO stickers (sha, path, mime, remark, tags, ts, source) VALUES (?, ?, ?, ?, ?, ?, ?)').run(s.sha, s.path, s.mime, s.remark, s.tags, Date.now(), s.source);
    return this.getSticker(Number(r.lastInsertRowid))!;
  }
  getSticker(id: number): StickerRow | undefined { return this.db.prepare('SELECT * FROM stickers WHERE id = ?').get(id) as StickerRow | undefined; }
  findStickers(q = '', limit = 50): StickerRow[] {
    if (!q.trim()) return this.db.prepare('SELECT * FROM stickers ORDER BY uses DESC, id DESC LIMIT ?').all(limit) as unknown as StickerRow[];
    const like = `%${q.trim()}%`;
    return this.db.prepare('SELECT * FROM stickers WHERE remark LIKE ? OR tags LIKE ? ORDER BY uses DESC, id DESC LIMIT ?').all(like, like, limit) as unknown as StickerRow[];
  }
  updateSticker(id: number, patch: { remark?: string; tags?: string }) {
    if (patch.remark !== undefined) this.db.prepare('UPDATE stickers SET remark = ? WHERE id = ?').run(patch.remark, id);
    if (patch.tags !== undefined) this.db.prepare('UPDATE stickers SET tags = ? WHERE id = ?').run(patch.tags, id);
  }
  bumpSticker(id: number) { this.db.prepare('UPDATE stickers SET uses = uses + 1 WHERE id = ?').run(id); }
  deleteSticker(id: number) { this.db.prepare('DELETE FROM stickers WHERE id = ?').run(id); }

  // ---------- 记忆 ----------
  memSet(scope: string, key: string, value: string) {
    this.db.prepare('INSERT INTO memory (scope, key, value, ts) VALUES (?, ?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value, ts = excluded.ts').run(scope, key, value, Date.now());
  }
  memDel(scope: string, key: string) { return this.db.prepare('DELETE FROM memory WHERE scope = ? AND key = ?').run(scope, key).changes > 0; }
  memList(scope?: string, q?: string, limit = 100): { scope: string; key: string; value: string; ts: number }[] {
    const where: string[] = []; const args: any[] = [];
    if (scope) { where.push('scope = ?'); args.push(scope); }
    if (q) { where.push('(key LIKE ? OR value LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
    return this.db.prepare(`SELECT * FROM memory ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ts DESC LIMIT ?`).all(...args, limit) as any[];
  }

  // ---------- 审计 ----------
  audit(e: { agent: string; tool: string; tier: string; params: unknown; ok: boolean; result: unknown; ms: number }) {
    const clip = (v: unknown) => { const s = typeof v === 'string' ? v : JSON.stringify(v ?? null); return s.length > 4000 ? `${s.slice(0, 4000)}…` : s; };
    const r = this.db.prepare('INSERT INTO audit (ts, agent, tool, tier, params, ok, result, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(Date.now(), e.agent, e.tool, e.tier, clip(e.params), e.ok ? 1 : 0, clip(e.result), e.ms);
    return Number(r.lastInsertRowid);
  }
  auditList(limit = 200, beforeId?: number) {
    return (beforeId
      ? this.db.prepare('SELECT * FROM audit WHERE id < ? ORDER BY id DESC LIMIT ?').all(beforeId, limit)
      : this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit)) as any[];
  }
  stats(sinceTs: number) {
    const msg = this.db.prepare('SELECT SUM(is_self = 0) AS recv, SUM(is_self = 1) AS sent FROM messages WHERE ts >= ?').get(sinceTs) as any;
    const tools = this.db.prepare('SELECT COUNT(*) AS calls, SUM(ok = 0) AS failed FROM audit WHERE ts >= ?').get(sinceTs) as any;
    return { recv: Number(msg?.recv ?? 0), sent: Number(msg?.sent ?? 0), toolCalls: Number(tools?.calls ?? 0), toolFailed: Number(tools?.failed ?? 0) };
  }

  // ---------- 插件 KV ----------
  kvGet(ns: string, key: string): unknown {
    const r = this.db.prepare('SELECT value FROM kv WHERE ns = ? AND key = ?').get(ns, key) as any;
    return r ? JSON.parse(r.value) : undefined;
  }
  kvSet(ns: string, key: string, value: unknown) {
    if (value === undefined) { this.db.prepare('DELETE FROM kv WHERE ns = ? AND key = ?').run(ns, key); return; }
    this.db.prepare('INSERT INTO kv (ns, key, value) VALUES (?, ?, ?) ON CONFLICT(ns, key) DO UPDATE SET value = excluded.value').run(ns, key, JSON.stringify(value));
  }
}

function toMsg(r: MessageRow): StoredMessage {
  return {
    seq: r.seq, msgId: r.msg_id, conv: r.conv, senderId: r.sender_id, senderName: r.sender_name, isSelf: !!r.is_self,
    ts: r.ts, segments: JSON.parse(r.segments), text: r.text, mentioned: !!r.mentioned, recalled: !!r.recalled,
  };
}
