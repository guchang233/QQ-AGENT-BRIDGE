import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareVersions, pickAsset, platformTag, extractZip } from '../src/update/index.ts';
// @ts-expect-error 纯 JS 模块
import { applyPendingUpdate } from '../bin/apply-update.mjs';
// @ts-expect-error 纯 JS 模块
import { zipDir } from '../scripts/zip.mjs';

const write = (f: string, s: string) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const read = (f: string) => fs.readFileSync(f, 'utf8');

describe('自动更新', () => {
  it('版本比较', () => {
    expect(compareVersions('0.2.1', '0.2.0')).toBe(1);
    expect(compareVersions('v0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0-beta.2', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.2')).toBe(1);
    expect(compareVersions('0.1.9', '0.2.0')).toBe(-1);
  });

  it('优先当前平台的免安装包', () => {
    const a = (name: string) => ({ name, browser_download_url: `https://x/${name}`, size: 1 });
    expect(pickAsset([a('qq-agent-bridge-v1.0.0.zip'), a(`qq-agent-bridge-v1.0.0-${platformTag()}.zip`)], 'v1.0.0')!.name).toBe(`qq-agent-bridge-v1.0.0-${platformTag()}.zip`);
    expect(pickAsset([a('qq-agent-bridge-v1.0.0.zip'), a('qq-agent-bridge-v1.0.0-plan9-mips.zip')], 'v1.0.0')!.name).toBe('qq-agent-bridge-v1.0.0.zip');
    expect(pickAsset([a('other.zip')], 'v1.0.0')).toBeUndefined();
  });

  it('启动时安装：替换程序文件、保留个人数据、备份旧版本', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qab-upd-'));
    // 旧版本
    write(path.join(root, 'package.json'), '{"version":"0.1.0"}');
    write(path.join(root, 'package-lock.json'), 'lock-1');
    write(path.join(root, 'bin/qab.mjs'), 'old');
    write(path.join(root, 'src/old-only.ts'), 'removed in new');
    write(path.join(root, 'config/qab.yaml'), 'my-config');
    write(path.join(root, 'config/qab.example.yaml'), 'old-example');
    write(path.join(root, 'data/qab.db'), 'my-data');
    write(path.join(root, 'roles/猫娘.md'), 'my-role');
    write(path.join(root, 'plugins/my-plugin/index.ts'), 'mine');
    write(path.join(root, 'node_modules/x/index.js'), 'deps-1');
    // 新版本（预备目录）
    const dir = path.join(root, '.update/staging/qq-agent-bridge-v0.2.0');
    write(path.join(dir, 'package.json'), '{"version":"0.2.0"}');
    write(path.join(dir, 'package-lock.json'), 'lock-1');
    write(path.join(dir, 'bin/qab.mjs'), 'new');
    write(path.join(dir, 'src/cli.ts'), 'new-src');
    write(path.join(dir, 'config/qab.example.yaml'), 'new-example');
    write(path.join(dir, 'plugins/hello/index.ts'), 'hello-new');
    write(path.join(dir, 'node_modules/x/index.js'), 'deps-new');
    write(path.join(root, '.update/pending.json'), JSON.stringify({ version: '0.2.0', from: '0.1.0', dir }));

    expect(applyPendingUpdate(root)).toBe('0.2.0');
    expect(read(path.join(root, 'bin/qab.mjs'))).toBe('new');
    expect(read(path.join(root, 'src/cli.ts'))).toBe('new-src');
    expect(fs.existsSync(path.join(root, 'src/old-only.ts'))).toBe(false);          // 整个目录替换
    expect(read(path.join(root, 'config/qab.yaml'))).toBe('my-config');             // 个人配置不动
    expect(read(path.join(root, 'config/qab.example.yaml'))).toBe('new-example');
    expect(read(path.join(root, 'data/qab.db'))).toBe('my-data');
    expect(read(path.join(root, 'roles/猫娘.md'))).toBe('my-role');
    expect(read(path.join(root, 'plugins/my-plugin/index.ts'))).toBe('mine');        // 用户插件保留
    expect(read(path.join(root, 'plugins/hello/index.ts'))).toBe('hello-new');       // 自带示例更新
    expect(read(path.join(root, 'node_modules/x/index.js'))).toBe('deps-1');         // 依赖没变不替换
    expect(read(path.join(root, '.update/backup/bin/qab.mjs'))).toBe('old');
    expect(fs.existsSync(path.join(root, '.update/pending.json'))).toBe(false);
    expect(JSON.parse(read(path.join(root, '.update/last-update.json'))).to).toBe('0.2.0');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('预备目录损坏时放弃更新、保持旧版本、只尝试一次', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qab-upd-'));
    write(path.join(root, 'bin/qab.mjs'), 'old');
    write(path.join(root, '.update/pending.json'), JSON.stringify({ version: '9.9.9', from: '0.1.0', dir: path.join(root, 'nope') }));
    expect(applyPendingUpdate(root)).toBeNull();
    expect(read(path.join(root, 'bin/qab.mjs'))).toBe('old');
    expect(JSON.parse(read(path.join(root, '.update/failed.json'))).version).toBe('9.9.9');
    expect(applyPendingUpdate(root)).toBeNull(); // 标记已移除，不会每次启动都重试
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('打包 zip（纯 Node）后可被系统工具解压，保留可执行权限', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qab-zip-'));
    write(path.join(root, 'pkg/a/b.txt'), '你好');
    write(path.join(root, 'pkg/bin/tool'), '#!/bin/sh');
    fs.chmodSync(path.join(root, 'pkg/bin/tool'), 0o755);
    write(path.join(root, 'pkg/big.txt'), 'x'.repeat(100_000));
    zipDir(path.join(root, 'pkg'), path.join(root, 'p.zip'));
    fs.mkdirSync(path.join(root, 'out'));
    extractZip(path.join(root, 'p.zip'), path.join(root, 'out'));
    expect(read(path.join(root, 'out/pkg/a/b.txt'))).toBe('你好');
    expect(read(path.join(root, 'out/pkg/big.txt'))).toHaveLength(100_000);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(root, 'out/pkg/bin/tool')).mode & 0o111).toBeTruthy();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
