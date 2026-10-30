#!/usr/bin/env node
// 入口：通过 tsx 直接运行 TypeScript 源码（无需构建）
import path from 'node:path';
import { applyPendingUpdate } from './apply-update.mjs';

// 启动守护进程前先安装已下载好的更新（此时程序文件都未被占用）
if ((process.argv[2] ?? 'start') === 'start') {
  try { applyPendingUpdate(path.resolve(import.meta.dirname, '..')); } catch (e) { console.error('安装更新出错：', e.message); }
}

const { register } = await import('tsx/esm/api');
register();
await import('../src/cli.ts');
