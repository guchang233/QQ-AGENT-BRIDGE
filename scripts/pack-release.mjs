#!/usr/bin/env node
/**
 * 打发布包：release/qq-agent-bridge-v<版本>.zip
 *   - 只包含 git 已跟踪的文件（不会带上 config/qab.yaml、data/、roles/*.md 等个人数据）
 *   - 附带预构建的控制台（console/dist），用户解压后无需构建
 *   - --with-deps：再打一份带生产依赖的包（-win-x64.zip 等），装好 Node 24 解压即用
 *
 * 用法：node scripts/pack-release.mjs [--with-deps] [--skip-build]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const args = new Set(process.argv.slice(2));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const name = `qq-agent-bridge-v${pkg.version}`;
const outDir = path.join(root, 'release');
const stage = path.join(outDir, name);
const isWin = process.platform === 'win32';
// Windows 自带的 bsdtar（Git Bash 里的 GNU tar 不支持 zip，且会把 D: 当成远程主机）
const TAR = isWin ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const run = (cmd, a, opts = {}) => execFileSync(cmd, a, { cwd: root, stdio: 'inherit', shell: isWin, ...opts });

const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
if (dirty) console.warn('⚠ 工作区有未提交的改动，发布包只包含已提交的内容：\n' + dirty);

if (!args.has('--skip-build')) run('npm', ['run', 'build']);
if (!fs.existsSync(path.join(root, 'console/dist/index.html'))) throw new Error('console/dist 不存在，请先 npm run build');

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

// 1. git 跟踪的文件（HEAD），去掉只对开发有用的目录
const tar = path.join(outDir, `${name}.src.tar`);
run('git', ['archive', '--format=tar', `--output=${tar}`, 'HEAD']);
execFileSync(TAR, ['-xf', tar, '-C', stage], { stdio: 'inherit' });
fs.rmSync(tar);
for (const d of ['.github', 'test', 'vitest.config.ts']) fs.rmSync(path.join(stage, d), { recursive: true, force: true });

// 2. 预构建控制台
fs.cpSync(path.join(root, 'console/dist'), path.join(stage, 'console/dist'), { recursive: true });

// 3. 打 zip（Windows 10+ 与 macOS/Linux 的 bsdtar 都支持 -a）
const zip = (dir, file) => {
  fs.rmSync(file, { force: true });
  const z = isWin ? TAR : (() => { try { execFileSync('bsdtar', ['--version']); return 'bsdtar'; } catch { return null; } })();
  if (z) execFileSync(z, ['-a', '-c', '-f', file, path.basename(dir)], { cwd: path.dirname(dir), stdio: 'inherit' });
  else execFileSync('zip', ['-qr', file, path.basename(dir)], { cwd: path.dirname(dir), stdio: 'inherit' });
  console.log(`✔ ${path.relative(root, file)}（${(fs.statSync(file).size / 1048576).toFixed(1)} MB）`);
};
zip(stage, path.join(outDir, `${name}.zip`));

// 4. 可选：带依赖的免安装包（依赖含平台相关的 esbuild，只适用于当前平台）
if (args.has('--with-deps')) {
  run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: stage });
  const plat = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
  const withDeps = path.join(outDir, `${name}-${plat}`);
  fs.rmSync(withDeps, { recursive: true, force: true });
  fs.renameSync(stage, withDeps);
  zip(withDeps, path.join(outDir, `${name}-${plat}.zip`));
  fs.rmSync(withDeps, { recursive: true, force: true });
} else {
  fs.rmSync(stage, { recursive: true, force: true });
}
