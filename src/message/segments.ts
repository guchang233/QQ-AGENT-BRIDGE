/** OneBot v11 消息段（array 格式）。 */
export interface Segment { type: string; data: Record<string, any> }

export type ConvType = 'group' | 'private';
export interface ConvRef { type: ConvType; id: string }

/** 统一会话 ID：group:123 / private:456。也接受 g123 / p456 / 纯数字（默认群）。 */
export function parseConv(s: string | number): ConvRef {
  const str = String(s).trim();
  let m = /^(group|private|g|p|friend|user):?(\d+)$/i.exec(str);
  if (m) {
    const t = m[1].toLowerCase();
    return { type: t === 'group' || t === 'g' ? 'group' : 'private', id: m[2] };
  }
  m = /^(\d+)$/.exec(str);
  if (m) return { type: 'group', id: m[1] };
  throw new Error(`无法识别的会话 ID：${str}（应为 group:<群号> 或 private:<QQ号>）`);
}

export function convKey(c: ConvRef) { return `${c.type}:${c.id}`; }

export const text = (t: string): Segment => ({ type: 'text', data: { text: t } });

export function plainText(segs: Segment[]): string {
  return segs.filter((s) => s.type === 'text').map((s) => s.data.text).join('');
}

/** 把 CQ 码字符串转为段数组（收到 string 格式消息时兼容）。 */
export function parseCQ(str: string): Segment[] {
  const out: Segment[] = [];
  const re = /\[CQ:([a-zA-Z_.-]+)((?:,[^,\]]*)*)\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const unesc = (s: string) => s.replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&#44;/g, ',').replace(/&amp;/g, '&');
  while ((m = re.exec(str))) {
    if (m.index > last) out.push(text(unesc(str.slice(last, m.index))));
    const data: Record<string, string> = {};
    for (const kv of m[2].split(',').slice(1)) {
      const i = kv.indexOf('=');
      if (i > 0) data[kv.slice(0, i)] = unesc(kv.slice(i + 1));
    }
    out.push({ type: m[1], data });
    last = re.lastIndex;
  }
  if (last < str.length) out.push(text(unesc(str.slice(last))));
  return out;
}

export function normalizeMessage(msg: unknown): Segment[] {
  if (Array.isArray(msg)) return msg.filter((s) => s && typeof s.type === 'string').map((s) => ({ type: s.type, data: s.data ?? {} }));
  if (typeof msg === 'string') return parseCQ(msg);
  return [];
}
