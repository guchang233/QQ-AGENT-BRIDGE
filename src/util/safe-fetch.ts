import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/**
 * 安全抓取（防 SSRF，思路同 qq-bridge 的 safe-fetch）：
 * - 仅 http/https，禁止 URL 内嵌凭据
 * - 解析域名并检查全部解析结果，禁止环回 / 私网 / 链路本地 / CGNAT / 组播等
 * - 连接时固定到已校验的地址（防 DNS 重绑定）
 * - 手动跟随重定向，每一跳重新校验；响应按字节限量读取
 */
export function isPrivateIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isPrivateIp(mapped[1]);
    return s === '::' || s === '::1' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb') || s.startsWith('ff');
  }
  return true;
}

export async function resolveSafe(hostname: string): Promise<{ address: string; family: number }> {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) throw new Error('禁止访问内网/本机地址');
  if (net.isIP(h)) { if (isPrivateIp(h)) throw new Error('禁止访问内网/本机地址'); return { address: h, family: net.isIP(h) }; }
  const list = await dns.lookup(h, { all: true });
  if (!list.length) throw new Error('域名无法解析');
  for (const a of list) if (isPrivateIp(a.address)) throw new Error('该域名解析到内网地址，已拒绝');
  return list[0];
}

export interface SafeResponse { status: number; url: string; contentType: string; body: Buffer; truncated: boolean }

function requestOnce(url: URL, pinned: { address: string; family: number }, maxBytes: number, timeoutMs: number, headers: Record<string, string>) {
  return new Promise<SafeResponse & { location?: string }>((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method: 'GET', headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6', ...headers },
      // 固定到已校验的地址（Node 24 会以 all:true 调用 lookup，需要返回数组）
      lookup: (_h, o: any, cb: any) => (o?.all ? cb(null, [{ address: pinned.address, family: pinned.family }]) : cb(null, pinned.address, pinned.family)),
      timeout: timeoutMs,
    }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) { res.resume(); resolve({ status, url: url.toString(), contentType: '', body: Buffer.alloc(0), truncated: false, location: String(res.headers.location ?? '') }); return; }
      const chunks: Buffer[] = []; let size = 0; let truncated = false;
      res.on('data', (c: Buffer) => {
        if (size + c.length > maxBytes) { chunks.push(c.subarray(0, maxBytes - size)); size = maxBytes; truncated = true; res.destroy(); return; }
        chunks.push(c); size += c.length;
      });
      const done = () => resolve({ status, url: url.toString(), contentType: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks), truncated });
      res.on('end', done);
      res.on('close', done);
      res.on('error', (e) => (truncated ? done() : reject(e)));
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end();
  });
}

export async function safeFetch(raw: string, opts: { maxBytes?: number; timeoutMs?: number; headers?: Record<string, string>; maxRedirects?: number } = {}): Promise<SafeResponse> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('URL 无效'); }
  for (let hop = 0; hop <= (opts.maxRedirects ?? 5); hop++) {
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只允许 http/https');
    if (url.username || url.password) throw new Error('禁止在 URL 中携带凭据');
    const pinned = await resolveSafe(url.hostname);
    const r = await requestOnce(url, pinned, opts.maxBytes ?? 2 * 1024 * 1024, opts.timeoutMs ?? 20_000, opts.headers ?? {});
    if (r.location === undefined) return r;
    if (!r.location) throw new Error(`重定向缺少 Location（HTTP ${r.status}）`);
    url = new URL(r.location, url);
  }
  throw new Error('重定向次数过多');
}

/** HTML → 可读纯文本（去脚本/样式/导航，保留段落）。 */
export function htmlToText(html: string): { title: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? '';
  const body = html
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return { title: decode(title), text: decode(body).replace(/[ \t ]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim() };
}

export function decode(s: string) {
  return s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
}
