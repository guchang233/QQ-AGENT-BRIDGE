import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 原子写：先写临时文件再 rename，避免进程中断留下半截文件。 */
export function atomicWrite(file: string, data: string | Buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function sha256(buf: Buffer | string) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** 判断 target 是否位于 roots 之一内部（规范化 + 大小写不敏感，防 ../ 逃逸）。 */
export function isInsideRoots(target: string, roots: string[]) {
  const t = path.resolve(target).toLowerCase();
  return roots.some((r) => {
    const root = path.resolve(r).toLowerCase();
    return t === root || t.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  });
}

export function guessMime(buf: Buffer): string {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && buf.subarray(0, 6).toString('ascii').startsWith('GIF8')) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  if (buf.length >= 10 && buf.subarray(0, 10).toString('ascii').includes('#!SILK')) return 'audio/silk';
  if (buf.length >= 3 && buf.subarray(0, 3).toString('ascii') === 'ID3') return 'audio/mpeg';
  if (buf.length >= 4 && buf.subarray(4, 8).toString('ascii') === 'ftyp') return 'video/mp4';
  return 'application/octet-stream';
}

export const MIME_EXT: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp',
  'audio/silk': '.silk', 'audio/mpeg': '.mp3', 'video/mp4': '.mp4',
};
