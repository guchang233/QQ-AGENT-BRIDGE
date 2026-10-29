import type { Segment } from './segments.ts';

export interface RenderHooks {
  selfId?: string;
  nameOf?: (qq: string) => string | undefined;
  faceName?: (id: string) => string | undefined;
  /** 媒体段（image/record/video/file）登记后返回短引用，如 a1b2c3 */
  mediaRef?: (seg: Segment) => string | undefined;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 把消息段渲染为人和模型都易读的单行文本。 */
export function renderSegments(segs: Segment[], h: RenderHooks = {}): string {
  return segs.map((s) => renderOne(s, h)).join('');
}

function renderOne(s: Segment, h: RenderHooks): string {
  const d = s.data ?? {};
  switch (s.type) {
    case 'text': return d.text ?? '';
    case 'at': {
      if (d.qq === 'all') return '@全体成员 ';
      if (h.selfId && String(d.qq) === h.selfId) return '@我 ';
      const n = d.name || h.nameOf?.(String(d.qq));
      return n ? `@${n}(${d.qq}) ` : `@${d.qq} `;
    }
    case 'face': return `[表情:${h.faceName?.(String(d.id)) ?? d.raw?.faceText?.replace(/^\//, '') ?? d.id}]`;
    case 'mface': return `[大表情:${d.summary || d.emoji_id || ''}]`;
    case 'image': {
      const ref = h.mediaRef?.(s);
      const kind = d.sub_type === 1 || d.subType === 1 || /动画表情|表情/.test(d.summary ?? '') ? '图片表情' : '图片';
      const sum = d.summary && !/^\[.*\]$/.test(d.summary) ? `:${d.summary}` : '';
      return ref ? `[${kind}#${ref}${sum}]` : `[${kind}${sum}]`;
    }
    case 'record': { const ref = h.mediaRef?.(s); return ref ? `[语音#${ref}]` : '[语音]'; }
    case 'video': { const ref = h.mediaRef?.(s); return ref ? `[视频#${ref}]` : '[视频]'; }
    case 'file': { const ref = h.mediaRef?.(s); return `[文件${ref ? `#${ref}` : ''}:${d.name ?? d.file ?? ''}${d.file_size ? ` ${fmtSize(Number(d.file_size))}` : ''}]`; }
    case 'reply': return `[回复#${d.id}]`;
    case 'forward': return `[合并转发#${d.id}]`;
    case 'json': {
      let title = '';
      try { const j = typeof d.data === 'string' ? JSON.parse(d.data) : d.data; title = j?.prompt || j?.meta?.detail_1?.desc || j?.meta?.news?.title || ''; } catch { /* ignore */ }
      return `[卡片${title ? `:${clip(title, 60)}` : ''}]`;
    }
    case 'xml': return '[XML卡片]';
    case 'poke': return '[戳一戳]';
    case 'dice': return `[骰子${d.result ? `:${d.result}` : ''}]`;
    case 'rps': return `[猜拳${d.result ? `:${d.result}` : ''}]`;
    case 'markdown': return `[Markdown:${clip(String(d.content ?? ''), 200)}]`;
    case 'music': return `[音乐分享:${d.title ?? d.id ?? ''}]`;
    case 'share': return `[链接:${d.title ?? ''} ${d.url ?? ''}]`;
    case 'location': return `[位置:${d.title ?? ''}]`;
    case 'contact': return `[推荐${d.type === 'group' ? '群' : '好友'}:${d.id}]`;
    default: return `[${s.type}]`;
  }
}

export function fmtSize(n: number) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n}B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)}MB`;
  return `${(n / 1024 ** 3).toFixed(2)}GB`;
}

export function fmtTime(ts: number) {
  const d = new Date(ts);
  const now = new Date();
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (d.toDateString() === now.toDateString()) return hm;
  return `${d.getMonth() + 1}-${d.getDate()} ${hm}`;
}
