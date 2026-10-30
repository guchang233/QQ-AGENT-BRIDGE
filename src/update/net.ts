import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

/**
 * 访问 GitHub 用的最小 HTTP 客户端：支持 HTTP 代理（CONNECT 隧道）、跟随重定向、流式下载。
 * Node 自带的 fetch 不读 HTTPS_PROXY，而国内访问 GitHub 往往需要代理，所以单独实现。
 */
export interface GetOptions { proxy?: string; headers?: Record<string, string>; timeoutMs?: number; onProgress?: (got: number, total: number) => void }

export const envProxy = () => process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';

function tunnel(proxy: string, host: string, port: number, timeoutMs: number): Promise<tls.TLSSocket> {
  const p = new URL(proxy);
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: `${host}:${port}` };
    if (p.username) headers['proxy-authorization'] = `Basic ${Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64')}`;
    const req = http.request({ host: p.hostname, port: Number(p.port) || 80, method: 'CONNECT', path: `${host}:${port}`, headers, timeout: timeoutMs });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return reject(new Error(`代理 CONNECT 失败：HTTP ${res.statusCode}`)); }
      const s = tls.connect({ socket, servername: host }, () => resolve(s));
      s.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('连接代理超时')));
    req.on('error', (e) => reject(new Error(`连接代理 ${p.host} 失败：${e.message}`)));
    req.end();
  });
}

async function open(url: string, o: GetOptions, hops = 0): Promise<http.IncomingMessage> {
  if (hops > 8) throw new Error('重定向次数过多');
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error(`只允许 https：${url}`);
  const timeoutMs = o.timeoutMs ?? 30_000;
  const headers = { 'user-agent': 'qq-agent-bridge-updater', ...o.headers };
  const proxy = o.proxy ?? '';
  const base: https.RequestOptions = { host: u.hostname, port: Number(u.port) || 443, path: u.pathname + u.search, headers, timeout: timeoutMs };
  // 走代理：先建 CONNECT 隧道（已完成 TLS 握手），请求直接跑在隧道上
  const sock = proxy ? await tunnel(proxy, u.hostname, Number(u.port) || 443, timeoutMs) : null;
  const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = https.request(sock ? { ...base, agent: false, createConnection: () => sock } : base, resolve);
    req.on('timeout', () => req.destroy(new Error(`请求超时：${u.host}`)));
    req.on('error', reject);
    req.end();
  });
  if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
    res.resume();
    return open(new URL(res.headers.location, url).toString(), o, hops + 1);
  }
  if (res.statusCode !== 200) {
    const body = await readAll(res).catch(() => '');
    const hint = res.statusCode === 403 && /rate limit/i.test(body) ? '（GitHub API 访问频率超限，稍后再试）' : '';
    throw new Error(`HTTP ${res.statusCode}${hint}：${url}`);
  }
  return res;
}

const readAll = (res: http.IncomingMessage) => new Promise<string>((resolve, reject) => {
  const chunks: Buffer[] = [];
  res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); res.on('error', reject);
});

export async function getJson<T = any>(url: string, o: GetOptions = {}): Promise<T> {
  return JSON.parse(await readAll(await open(url, { ...o, headers: { accept: 'application/vnd.github+json', ...o.headers } })));
}

/** 下载到文件，返回 sha256（hex） */
export async function download(url: string, file: string, o: GetOptions = {}): Promise<string> {
  const res = await open(url, { timeoutMs: 120_000, ...o });
  const total = Number(res.headers['content-length'] ?? 0);
  const hash = createHash('sha256');
  const out = fs.createWriteStream(file + '.part');
  let got = 0;
  await new Promise<void>((resolve, reject) => {
    res.on('data', (c: Buffer) => { got += c.length; hash.update(c); o.onProgress?.(got, total); });
    res.on('error', reject); out.on('error', reject); out.on('finish', resolve);
    res.pipe(out);
  });
  if (total && got !== total) throw new Error(`下载不完整：${got}/${total} 字节`);
  fs.renameSync(file + '.part', file);
  return hash.digest('hex');
}
