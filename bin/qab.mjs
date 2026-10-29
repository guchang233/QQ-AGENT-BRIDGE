#!/usr/bin/env node
// 入口：通过 tsx 直接运行 TypeScript 源码（无需构建）
import { register } from 'tsx/esm/api';
register();
await import('../src/cli.ts');
