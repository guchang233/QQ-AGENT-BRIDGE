// 启动前安装已预备好的更新（.update/pending.json）。
// 必须在加载 tsx 和程序代码之前运行：此时旧版本的文件都没有被占用。
// 程序目录下的个人数据（config/qab.yaml、data/、roles/、用户插件等）不会被改动；旧文件备份到 .update/backup，失败自动回滚。
import fs from 'node:fs';
import path from 'node:path';

/** 只替换这些程序文件/目录；其余（config、data、roles、plugins、dsh、.git 等）保持不动 */
const KEEP = new Set(['config', 'data', 'roles', 'plugins', 'dsh', '.update', '.git', 'release']);

export function applyPendingUpdate(root) {
  const upd = path.join(root, '.update');
  const pendingFile = path.join(upd, 'pending.json');
  if (!fs.existsSync(pendingFile)) return null;
  let p;
  try { p = JSON.parse(fs.readFileSync(pendingFile, 'utf8')); } catch { fs.rmSync(pendingFile, { force: true }); return null; }
  // 先移走标记，避免安装出错时每次启动都卡在这里
  fs.rmSync(pendingFile, { force: true });
  const src = p.dir;
  if (!src || !fs.existsSync(path.join(src, 'bin', 'qab.mjs'))) return fail(upd, p, '预备目录不存在或不完整');

  const backup = path.join(upd, 'backup');
  fs.rmSync(backup, { recursive: true, force: true });
  fs.mkdirSync(backup, { recursive: true });
  const moved = []; // [名称, 'backup' | 'new']
  const sameLock = (() => { try { return fs.readFileSync(path.join(src, 'package-lock.json')).equals(fs.readFileSync(path.join(root, 'package-lock.json'))); } catch { return false; } })();
  try {
    for (const name of fs.readdirSync(src)) {
      const from = path.join(src, name);
      const to = path.join(root, name);
      if (name === 'config') { // 只更新示例配置
        for (const f of fs.readdirSync(from)) if (f !== 'qab.yaml') fs.copyFileSync(path.join(from, f), path.join(to, f));
        continue;
      }
      if (name === 'plugins') { // 自带的示例插件覆盖更新，用户自己的插件不动
        for (const d of fs.readdirSync(from)) fs.cpSync(path.join(from, d), path.join(to, d), { recursive: true, force: true });
        continue;
      }
      if (KEEP.has(name)) continue;
      if (name === 'node_modules' && sameLock && fs.existsSync(to)) continue; // 依赖没变就不动（也避开被其他进程占用的文件）
      if (fs.existsSync(to)) { fs.renameSync(to, path.join(backup, name)); moved.push([name, 'backup']); }
      fs.renameSync(from, to); moved.push([name, 'new']);
    }
  } catch (e) {
    for (const [name, kind] of moved.reverse()) {
      try {
        if (kind === 'new') fs.renameSync(path.join(root, name), path.join(src, name));
        else fs.renameSync(path.join(backup, name), path.join(root, name));
      } catch { /* 尽力回滚 */ }
    }
    const hint = /EPERM|EBUSY|EACCES/.test(e.code ?? '') ? '（文件被占用：请关闭 DeepSeek Harness 等正在使用本程序的进程后再试）' : '';
    return fail(upd, p, `${e.message}${hint}`);
  }
  fs.rmSync(path.join(upd, 'staging'), { recursive: true, force: true });
  fs.writeFileSync(path.join(upd, 'last-update.json'), JSON.stringify({ from: p.from, to: p.version, at: Date.now() }));
  fs.rmSync(path.join(upd, 'failed.json'), { force: true });
  console.log(`✔ 已更新到 v${p.version}（旧版本备份在 .update/backup）`);
  return p.version;
}

function fail(upd, p, error) {
  fs.writeFileSync(path.join(upd, 'failed.json'), JSON.stringify({ version: p.version, error, at: Date.now() }));
  console.error(`✗ 更新到 v${p.version} 失败，继续使用当前版本：${error}`);
  return null;
}
