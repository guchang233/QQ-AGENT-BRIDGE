#!/usr/bin/env node
/**
 * 打发布包：release/qq-agent-bridge-v<版本>.zip
 *   - 只包含 git 已跟踪的文件（不会带上 config/qab.yaml、data/、roles/*.md 等个人数据）
 *   - 附带预构建的控制台（console/dist），用户解压后无需构建
 *   - --with-deps：再打一份带生产依赖的包（-win-x64.zip 等），装好 Node 24 解压即用
 *
 * 用法：node scripts/pack-release.mjs [--with-deps [--no-generic]] [--skip-build]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { zipDir } from './zip.mjs';

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

// 3. 打 zip（纯 Node 实现，见 scripts/zip.mjs）
const zip = (dir, file) => {
  fs.rmSync(file, { force: true });
  zipDir(dir, file);
  console.log(`✔ ${path.relative(root, file)}（${(fs.statSync(file).size / 1048576).toFixed(1)} MB）`);
};
zip(stage, path.join(outDir, `${name}.zip`));

// 4. 可选：带依赖的免安装包（依赖含平台相关的 esbuild，只适用于当前平台）
if (args.has('--with-deps')) {
  const plat = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
  const withDeps = path.join(outDir, `${name}-${plat}`);
  fs.rmSync(withDeps, { recursive: true, force: true });
  // 先改名再装依赖：Windows 上刚装完的 node_modules 常被杀毒扫描占用，改名会 EPERM
  fs.renameSync(stage, withDeps);
  run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: withDeps });
  zip(withDeps, path.join(outDir, `${name}-${plat}.zip`));
  try { fs.rmSync(withDeps, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* 清理失败不影响结果 */ }
  // CI 多平台并行打包时，通用包只需要一个平台上传
  if (args.has('--no-generic')) fs.rmSync(path.join(outDir, `${name}.zip`), { force: true });
} else {
  fs.rmSync(stage, { recursive: true, force: true });
}
