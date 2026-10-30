// 纯 Node 实现的 zip 打包（deflate），不依赖系统 tar/zip。
// Windows 自带的 tar.exe 在打包大量小文件（node_modules）时会崩溃（0xC0000005），所以自己写。
// 保留 Unix 文件权限（可执行位），解压后 Linux/macOS 上的 esbuild 等二进制仍可执行。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

function walk(dir, base, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isSymbolicLink()) {
      const real = fs.statSync(full, { throwIfNoEntry: false });
      if (real?.isDirectory()) walk(full, rel, out); else if (real) out.push({ full, rel });
    } else if (e.isDirectory()) { out.push({ full, rel: rel + '/', dir: true }); walk(full, rel, out); }
    else if (e.isFile()) out.push({ full, rel });
  }
}

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** 把 srcDir 打包成 zipFile，压缩包内以 srcDir 的目录名为顶层目录 */
export function zipDir(srcDir, zipFile) {
  const entries = [];
  const top = path.basename(srcDir);
  entries.push({ full: srcDir, rel: top + '/', dir: true });
  walk(srcDir, top, entries);
  if (entries.length >= 0xffff) throw new Error(`文件太多（${entries.length}），超出 zip 格式上限`);

  const fd = fs.openSync(zipFile, 'w');
  const central = [];
  let offset = 0;
  const write = (buf) => { fs.writeSync(fd, buf); offset += buf.length; };
  try {
    for (const e of entries) {
      const st = fs.statSync(e.full);
      const name = Buffer.from(e.rel, 'utf8');
      const raw = e.dir ? Buffer.alloc(0) : fs.readFileSync(e.full);
      const crc = e.dir ? 0 : zlib.crc32(raw);
      const deflated = e.dir ? raw : zlib.deflateRawSync(raw, { level: 9 });
      const stored = !e.dir && deflated.length >= raw.length; // 已压缩的文件直接存储
      const data = stored ? raw : deflated;
      const method = e.dir || stored ? 0 : 8;
      const { time, date } = dosTime(st.mtime);
      const mode = e.dir ? 0o40755 : (st.mode & 0o111 ? 0o100755 : 0o100644);

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
      local.writeUInt16LE(method, 8); local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22);
      local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
      const at = offset;
      write(local); write(name); write(data);

      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE((3 << 8) | 20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8);
      c.writeUInt16LE(method, 10); c.writeUInt16LE(time, 12); c.writeUInt16LE(date, 14);
      c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24);
      c.writeUInt16LE(name.length, 28); c.writeUInt16LE(0, 30); c.writeUInt16LE(0, 32); c.writeUInt16LE(0, 34); c.writeUInt16LE(0, 36);
      c.writeUInt32LE(((mode << 16) | (e.dir ? 0x10 : 0)) >>> 0, 38); c.writeUInt32LE(at, 42);
      central.push(Buffer.concat([c, name]));
      if (offset > 0xffffffff) throw new Error('压缩包超过 4GB');
    }
    const cdStart = offset;
    for (const c of central) write(c);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(offset - cdStart, 12); end.writeUInt32LE(cdStart, 16);
    write(end);
  } finally { fs.closeSync(fd); }
}
