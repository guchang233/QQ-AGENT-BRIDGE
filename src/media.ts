import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Store, MediaRow } from './store/db.ts';
import type { OneBotClient } from './onebot/client.ts';
import type { Segment } from './message/segments.ts';
import { guessMime, isInsideRoots, MIME_EXT, sha256, atomicWrite } from './util/fs.ts';
import { createLogger } from './util/log.ts';

const log = createLogger('media');

export interface MediaOptions { dir: string; maxDownloadBytes: number; uploadRoots: string[] }

/**
 * 媒体服务：
 * - 收到的图片/语音/视频/文件登记为短引用（#ref），按需下载缓存到 data/media
 * - 发送时把 本地路径 / URL / base64 / #ref / 表情包 解析为 OneBot 可用的 file 值
 */
export class MediaService {
  constructor(private store: Store, private bot: OneBotClient, private opts: MediaOptions) {
    fs.mkdirSync(opts.dir, { recursive: true });
  }

  /** 为收到的媒体段生成稳定短引用并入库。 */
  register(seg: Segment, conv: string, msgId: string): string {
    const d = seg.data ?? {};
    const key = d.file_unique || d.fileUnique || d.file_id || d.file || d.url || JSON.stringify(d);
    const ref = crypto.createHash('sha1').update(`${seg.type}:${key}`).digest('hex').slice(0, 8);
    this.store.putMedia({
      ref, kind: seg.type, conv, msg_id: msgId,
      url: String(d.url ?? (String(d.file ?? '').startsWith('http') ? d.file : '')),
      file: String(d.file ?? ''), file_id: String(d.file_id ?? d.fileId ?? ''), summary: String(d.summary ?? d.name ?? ''),
      size: Number(d.file_size ?? d.fileSize ?? 0) || 0,
    });
    return ref;
  }

  get(ref: string): MediaRow | undefined { return this.store.getMedia(ref); }

  /** 确保媒体已下载到本地，返回本地路径与内容。 */
  async fetch(ref: string): Promise<{ row: MediaRow; path: string; buf: Buffer; mime: string }> {
    const row = this.store.getMedia(ref);
    if (!row) throw new Error(`找不到媒体 #${ref}（可能不是本桥接收到的消息）`);
    if (row.local_path && fs.existsSync(row.local_path)) {
      const buf = fs.readFileSync(row.local_path);
      return { row, path: row.local_path, buf, mime: row.mime || guessMime(buf) };
    }
    let buf: Buffer | undefined;
    let url = row.url;
    // 1) 让 OneBot 给出可下载地址 / 本地缓存路径
    if (row.kind === 'image' || row.kind === 'record') {
      try {
        const info: any = await this.bot.call(row.kind === 'image' ? 'get_image' : 'get_record',
          row.kind === 'record' ? { file: row.file, file_id: row.file_id || undefined, out_format: 'mp3' } : { file: row.file, file_id: row.file_id || undefined });
        if (info?.base64) buf = Buffer.from(info.base64, 'base64');
        else if (info?.file && fs.existsSync(info.file)) buf = fs.readFileSync(info.file);
        if (info?.url) url = info.url;
      } catch (e: any) { log.debug(`get_${row.kind} 失败，退回 URL 下载: ${e.message}`); }
    }
    // 2) 直接下载 URL
    if (!buf && url) buf = await this.download(url);
    if (!buf) throw new Error(`媒体 #${ref} 无可用下载地址`);
    const mime = guessMime(buf);
    const sha = sha256(buf);
    const p = path.join(this.opts.dir, `${sha.slice(0, 16)}${MIME_EXT[mime] ?? ''}`);
    if (!fs.existsSync(p)) atomicWrite(p, buf);
    this.store.putMedia({ ref: row.ref, kind: row.kind, local_path: p, mime, size: buf.length, sha, url });
    return { row: { ...row, local_path: p, mime, size: buf.length, sha }, path: p, buf, mime };
  }

  async download(url: string): Promise<Buffer> {
    if (!/^https?:\/\//i.test(url)) throw new Error(`不支持的 URL：${url.slice(0, 80)}`);
    const res = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { 'user-agent': 'Mozilla/5.0 QQ-Agent-Bridge' } });
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > this.opts.maxDownloadBytes) throw new Error(`文件过大（${len} 字节）`);
    const ab = await res.arrayBuffer();
    if (ab.byteLength > this.opts.maxDownloadBytes) throw new Error(`文件过大（${ab.byteLength} 字节）`);
    return Buffer.from(ab);
  }

  /**
   * 把 agent 给出的媒体来源解析成 OneBot file 值：
   *   http(s)://… → 原样；base64://… → 原样；data:…;base64,… → base64://；#ref → 已缓存的收到媒体；
   *   本地路径 → 读取后 base64://（受 uploadRoots 限制）
   */
  async toOneBotFile(src: string): Promise<string> {
    const s = src.trim().replace(/^["']|["']$/g, '');
    if (/^https?:\/\//i.test(s) || s.startsWith('base64://')) return s;
    const dataUrl = /^data:[^;]+;base64,(.*)$/s.exec(s);
    if (dataUrl) return `base64://${dataUrl[1]}`;
    if (/^#?[0-9a-f]{8}$/i.test(s) && this.store.getMedia(s)) {
      const r = await this.fetch(s);
      return `base64://${r.buf.toString('base64')}`;
    }
    const p = s.startsWith('file://') ? decodeURIComponent(s.replace(/^file:\/\/\/?/, '')) : s;
    const abs = path.resolve(p);
    if (this.opts.uploadRoots.length && !isInsideRoots(abs, this.opts.uploadRoots)) {
      throw new Error(`不允许读取该路径（仅限 uploadRoots：${this.opts.uploadRoots.join('; ')}）`);
    }
    if (!fs.existsSync(abs)) throw new Error(`文件不存在：${abs}`);
    const st = fs.statSync(abs);
    if (!st.isFile()) throw new Error(`不是文件：${abs}`);
    // 大文件直接给 file:// 路径（SnowLuma 与本桥接同机），小文件走 base64 更稳
    if (st.size > 10 * 1024 * 1024) return `file:///${abs.replace(/\\/g, '/')}`;
    return `base64://${fs.readFileSync(abs).toString('base64')}`;
  }

  /** 读取任意来源为 Buffer（用于收藏表情包等）。 */
  async readSource(src: string): Promise<Buffer> {
    const v = await this.toOneBotFile(src);
    if (v.startsWith('base64://')) return Buffer.from(v.slice(9), 'base64');
    if (v.startsWith('file:///')) return fs.readFileSync(decodeURIComponent(v.slice(8)));
    return this.download(v);
  }

  /** 把自己发出的 base64 图片落盘并登记，便于控制台显示与再次引用。 */
  rememberSent(seg: Segment, conv: string, msgId: string): Segment {
    const file = String(seg.data.file ?? '');
    if (!file.startsWith('base64://')) return seg;
    const buf = Buffer.from(file.slice(9), 'base64');
    const mime = guessMime(buf);
    const sha = sha256(buf);
    const p = path.join(this.opts.dir, `${sha.slice(0, 16)}${MIME_EXT[mime] ?? ''}`);
    if (!fs.existsSync(p)) atomicWrite(p, buf);
    const stored: Segment = { type: seg.type, data: { ...seg.data, file: `sent-${sha.slice(0, 16)}` } };
    const ref = this.register(stored, conv, msgId);
    this.store.putMedia({ ref, kind: seg.type, local_path: p, mime, size: buf.length, sha });
    return stored;
  }

  stickerDir() { const d = path.join(path.dirname(this.opts.dir), 'stickers'); fs.mkdirSync(d, { recursive: true }); return d; }
}
