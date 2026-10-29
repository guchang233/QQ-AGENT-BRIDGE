import { type Segment, text } from './segments.ts';

/**
 * Agent 友好的消息文本 DSL（发送方向）。
 *
 *   你好[at:123456] 看这个[face:微笑][image:C:\pics\a.png]
 *   [reply:98765]收到！
 *   [sticker:3] [image:#a1b2c3]（引用收到过的图片）[record:D:\v.mp3] [file:D:\a.zip|name=资料.zip]
 *   [at:all] [dice] [rps] [music:qq|12345] [share:https://x.com|title=标题]
 *
 * 用 \[ 输出字面量方括号。无法识别的标签原样保留为文本。
 */
export interface DslToken { tag: string; arg: string; opts: Record<string, string> }

const KNOWN = new Set([
  'at', 'face', 'image', 'img', 'sticker', 'record', 'voice', 'video', 'file', 'reply', 'dice', 'rps',
  'music', 'share', 'mface', 'json', 'markdown', 'contact', 'location', 'poke', 'node',
]);

export interface ParsedDsl { segments: Segment[]; pending: { index: number; token: DslToken }[] }

/**
 * 解析 DSL 为段数组。媒体类标签（image/sticker/record/video/file）先占位，
 * 由调用方异步解析（读本地文件、查表情库等）后替换。
 */
export function parseDsl(input: string, resolveFace: (s: string) => number | undefined): ParsedDsl {
  const segments: Segment[] = [];
  const pending: ParsedDsl['pending'] = [];
  let buf = '';
  const flush = () => { if (buf) { segments.push(text(buf)); buf = ''; } };
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '\\' && (input[i + 1] === '[' || input[i + 1] === ']' || input[i + 1] === '\\')) { buf += input[i + 1]; i += 2; continue; }
    if (ch === '[') {
      const end = input.indexOf(']', i + 1);
      if (end > i) {
        const body = input.slice(i + 1, end);
        const m = /^([a-zA-Z]+)(?::([\s\S]*))?$/.exec(body);
        if (m && KNOWN.has(m[1].toLowerCase())) {
          const tag = m[1].toLowerCase();
          const parts = (m[2] ?? '').split('|');
          const arg = parts.shift()!.trim();
          const opts: Record<string, string> = {};
          for (const p of parts) {
            const k = p.indexOf('=');
            if (k > 0) opts[p.slice(0, k).trim()] = p.slice(k + 1).trim();
            else if (p.trim()) opts[p.trim()] = 'true';
          }
          const seg = simpleSegment(tag, arg, opts, resolveFace);
          flush();
          if (seg) segments.push(seg);
          else { pending.push({ index: segments.length, token: { tag, arg, opts } }); segments.push({ type: '__pending', data: {} }); }
          i = end + 1;
          continue;
        }
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return { segments, pending };
}

function simpleSegment(tag: string, arg: string, opts: Record<string, string>, resolveFace: (s: string) => number | undefined): Segment | null {
  switch (tag) {
    case 'at': return { type: 'at', data: { qq: arg === '全体' || arg === 'everyone' ? 'all' : arg } };
    case 'face': {
      const id = resolveFace(arg);
      if (id === undefined) throw new Error(`未知表情「${arg}」，可用 qq_search_face 查询`);
      return { type: 'face', data: { id: String(id) } };
    }
    case 'reply': return { type: 'reply', data: { id: arg } };
    case 'dice': return { type: 'dice', data: {} };
    case 'rps': return { type: 'rps', data: {} };
    case 'poke': return { type: 'poke', data: { type: arg || '1', id: opts.id ?? '-1' } };
    case 'music': {
      const [kind, id] = arg.includes(',') ? arg.split(',') : [arg, opts.id];
      if (kind === 'custom') return { type: 'music', data: { type: 'custom', url: opts.url, audio: opts.audio, title: opts.title, image: opts.image } };
      return { type: 'music', data: { type: kind || 'qq', id: id ?? '' } };
    }
    case 'share': return { type: 'share', data: { url: arg, title: opts.title ?? arg, content: opts.content, image: opts.image } };
    case 'json': return { type: 'json', data: { data: arg } };
    case 'markdown': return { type: 'markdown', data: { content: arg } };
    case 'contact': return { type: 'contact', data: { type: opts.type ?? 'qq', id: arg } };
    case 'location': return { type: 'location', data: { lat: arg, lon: opts.lon, title: opts.title } };
    case 'mface': return { type: 'mface', data: { emoji_id: arg, emoji_package_id: opts.package, key: opts.key, summary: opts.summary } };
    default: return null; // 媒体类：交给异步解析
  }
}

/** 把一段文本按空行/分隔符 `---` 拆成多条消息（用于分条发送）。 */
export function splitBurst(input: string): string[] {
  return input.split(/\n\s*---\s*\n/).map((s) => s.trim()).filter(Boolean);
}
