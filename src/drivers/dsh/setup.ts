import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Bridge } from '../../bridge.ts';
import { ROOT } from '../../config.ts';
import { randomToken } from '../../util/fs.ts';
import { dshHome, localDshPorts } from './client.ts';
import { BUNDLE_NAME, MCP_SERVER_NAME, PRESET_ID, TOOL_RESTRICT_SOURCE, presetPatchYaml } from './preset.ts';

/**
 * 「一键接入 DSH」：在 DSH profile 中注册本项目的 MCP 服务与 qab-qq 预设。
 *
 * 与 qq-bridge 共存：只增删自己带标记的区块 / 自己的 bundle（qab-presets），
 * 绝不改动 qq-bridge 的 qq-chat / qq-chat-v2 预设与 snowluma MCP 条目。
 * 所有被修改的文件先备份为 *.bak-qab-<时间>。
 */
const BEGIN = '# === qq-agent-bridge MCP BEGIN ===';
const END = '# === qq-agent-bridge MCP END ===';
const DSH_TOKEN_NAME = 'dsh';

export interface SetupStatus {
  dshHome: string; profile: string; profileDir: string; profileExists: boolean;
  mcpRegistered: boolean; bundleRegistered: boolean; bundleLinked: boolean;
  qqBridgeDetected: boolean; tokenReady: boolean;
}

/** auto：DSH 桌面版（随机端口进程）在运行 → desktop，否则 web。 */
export function resolveProfile(bridge: Bridge): string {
  const p = bridge.config.drivers.dsh.profile;
  if (p && p !== 'auto') return p;
  return localDshPorts().length ? 'desktop' : 'web';
}

function paths(bridge: Bridge) {
  const home = dshHome(bridge.config.drivers.dsh.dshHome || undefined);
  const profileDir = path.join(home, 'profiles', resolveProfile(bridge));
  return {
    home, profileDir,
    patchFile: path.join(profileDir, 'cordis.patch.yml'),
    pkgFile: path.join(profileDir, 'package.json'),
    bundleSrc: path.join(ROOT, 'dsh', BUNDLE_NAME),
    pluginLink: path.join(home, 'plugins', BUNDLE_NAME),
    nmLink: path.join(profileDir, 'node_modules', BUNDLE_NAME),
  };
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
function backup(file: string) { if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-qab-${stamp()}`); }

function link(target: string, at: string) {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  try {
    const st = fs.lstatSync(at);
    if (!st.isSymbolicLink()) throw new Error(`${at} 已存在且不是链接，请手动处理后重试`);
    fs.unlinkSync(at);
  } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
}

export function dshSetupStatus(bridge: Bridge): SetupStatus {
  const p = paths(bridge);
  const patch = fs.existsSync(p.patchFile) ? fs.readFileSync(p.patchFile, 'utf8') : '';
  let pkg: any = {};
  try { pkg = JSON.parse(fs.readFileSync(p.pkgFile, 'utf8')); } catch { /* ignore */ }
  return {
    dshHome: p.home, profile: path.basename(p.profileDir), profileDir: p.profileDir, profileExists: fs.existsSync(p.profileDir),
    mcpRegistered: patch.includes(BEGIN),
    bundleRegistered: (pkg?.dsh?.profile?.bundles ?? []).includes(BUNDLE_NAME),
    bundleLinked: fs.existsSync(path.join(p.nmLink, 'package.json')),
    qqBridgeDetected: patch.includes('mcp-snowluma') || (pkg?.dsh?.profile?.bundles ?? []).includes('qq-agent-presets'),
    tokenReady: bridge.config.agents.tokens.some((t) => t.name === DSH_TOKEN_NAME && t.enabled && t.sessionBound),
  };
}

/** 生成 bundle 文件（每次接入都重写，保证与当前版本一致）。 */
function writeBundle(dir: string) {
  fs.mkdirSync(path.join(dir, 'presets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: BUNDLE_NAME, version: '1.0.0', private: true, type: 'module',
    description: 'QQ-Agent Bridge 的 DSH Agent 预设（qab-qq）与工具守卫',
    dsh: { bundle: { patch: [`./presets/${PRESET_ID}.patch.yml`] } },
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'qab-tool-restrict.mjs'), TOOL_RESTRICT_SOURCE);
  fs.writeFileSync(path.join(dir, 'presets', `${PRESET_ID}.patch.yml`), presetPatchYaml());
}

export function installDsh(bridge: Bridge): { steps: string[]; restartRequired: boolean; warnings: string[] } {
  const p = paths(bridge);
  const steps: string[] = [];
  const warnings: string[] = [];
  if (!fs.existsSync(p.profileDir)) throw new Error(`找不到 DSH profile 目录：${p.profileDir}（请确认已安装并运行过一次 DSH，或在设置中修改 DSH 目录 / profile）`);

  // 1. 专用 agent token：会话绑定 + 读/发权限
  const cfg = structuredClone(bridge.config);
  let tok = cfg.agents.tokens.find((t) => t.name === DSH_TOKEN_NAME);
  if (!tok) {
    tok = { name: DSH_TOKEN_NAME, token: `qab_${randomToken(24)}`, tiers: ['read', 'send'], groups: [], private: [], enabled: true, sessionBound: true };
    cfg.agents.tokens.push(tok);
    steps.push('创建 Agent token「dsh」（会话绑定，权限：读取+发送）');
  } else if (!tok.sessionBound || !tok.enabled) {
    tok.sessionBound = true; tok.enabled = true;
    steps.push('已将 token「dsh」设为会话绑定');
  }
  cfg.drivers.dsh.enabled = true;
  if (cfg.drivers.dsh.preset !== PRESET_ID) cfg.drivers.dsh.preset = PRESET_ID;
  bridge.updateConfig(cfg);

  // 2. bundle 文件 + 两层目录链接（与 dsh plugin install 物化出的形态一致）
  writeBundle(p.bundleSrc);
  link(p.bundleSrc, p.pluginLink);
  link(p.pluginLink, p.nmLink);
  steps.push(`生成预设 bundle ${BUNDLE_NAME}（预设 ${PRESET_ID}）并链接到 DSH`);

  // 3. profile package.json：link 依赖 + bundles
  backup(p.pkgFile);
  const pkg = JSON.parse(fs.readFileSync(p.pkgFile, 'utf8'));
  pkg.dependencies ??= {};
  pkg.dependencies[BUNDLE_NAME] = `link:${p.pluginLink.replace(/\\/g, '/')}`;
  pkg.dsh ??= {}; pkg.dsh.profile ??= {}; pkg.dsh.profile.bundles ??= [];
  if (!pkg.dsh.profile.bundles.includes(BUNDLE_NAME)) pkg.dsh.profile.bundles.push(BUNDLE_NAME);
  fs.writeFileSync(p.pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
  steps.push('在 profile package.json 中注册 bundle');

  // 4. cordis.patch.yml：MCP 服务（stdio 代理到本守护进程，自动跟随 token）
  backup(p.patchFile);
  const old = fs.existsSync(p.patchFile) ? fs.readFileSync(p.patchFile, 'utf8') : '';
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const block = [
    BEGIN,
    '# 由 QQ-Agent Bridge 维护；整段会被替换，请勿手工编辑内部条目。',
    '- insert:',
    '    - id: mcp-qab',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    `        serverName: ${MCP_SERVER_NAME}`,
    '        transport: stdio',
    `        command: ${q(process.execPath)}`,
    '        args:',
    `          - ${q(path.join(ROOT, 'bin', 'qab.mjs'))}`,
    '          - mcp',
    '          - --token',
    `          - ${q(tok.token)}`,
    '        toolCallTimeoutMs: 1900000',
    END,
  ].join('\n');
  const stripped = old.includes(BEGIN) ? old.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}\\n?`), '') : old;
  fs.writeFileSync(p.patchFile, `${stripped.replace(/\s*$/, '')}${stripped.trim() ? '\n' : ''}${block}\n`);
  steps.push(`在 cordis.patch.yml 注册 MCP 服务「${MCP_SERVER_NAME}」`);

  // 5. 尽量执行 dsh plugin install（不在 PATH 上就提示手动执行）
  const r = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `dsh.cmd plugin --profile "${resolveProfile(bridge)}" install`], { encoding: 'utf8', timeout: 180_000 })
    : spawnSync('dsh', ['plugin', '--profile', resolveProfile(bridge), 'install'], { encoding: 'utf8', timeout: 180_000 });
  if (r.status === 0) steps.push('dsh plugin install 完成');
  else warnings.push(`未能自动执行「dsh plugin --profile ${resolveProfile(bridge)} install」（dsh 命令不在 PATH 上？）。目录链接已建好，多数情况下重启 DSH 即可；若 DSH 报 bundle 解析失败请手动执行该命令。`);

  if (dshSetupStatus(bridge).qqBridgeDetected) warnings.push('检测到 qq-bridge 的 DSH 配置：已保留不动，两者可以共存（qq-bridge 用 qq-chat-v2 预设，本项目用 qab-qq 预设）。');
  return { steps, restartRequired: true, warnings };
}

export function uninstallDsh(bridge: Bridge): string[] {
  const p = paths(bridge);
  const steps: string[] = [];
  if (fs.existsSync(p.patchFile)) {
    const old = fs.readFileSync(p.patchFile, 'utf8');
    if (old.includes(BEGIN)) {
      backup(p.patchFile);
      fs.writeFileSync(p.patchFile, old.replace(new RegExp(`\\n?${BEGIN}[\\s\\S]*?${END}\\n?`), '\n'));
      steps.push('已从 cordis.patch.yml 移除 MCP 区块');
    }
  }
  if (fs.existsSync(p.pkgFile)) {
    const pkg = JSON.parse(fs.readFileSync(p.pkgFile, 'utf8'));
    if (pkg.dependencies?.[BUNDLE_NAME] || pkg.dsh?.profile?.bundles?.includes(BUNDLE_NAME)) {
      backup(p.pkgFile);
      delete pkg.dependencies?.[BUNDLE_NAME];
      if (pkg.dsh?.profile?.bundles) pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b: string) => b !== BUNDLE_NAME);
      fs.writeFileSync(p.pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
      steps.push('已从 profile 移除 bundle');
    }
  }
  for (const l of [p.nmLink, p.pluginLink]) { try { if (fs.lstatSync(l).isSymbolicLink()) { fs.unlinkSync(l); steps.push(`已删除链接 ${l}`); } } catch { /* none */ } }
  const cfg = structuredClone(bridge.config);
  cfg.drivers.dsh.enabled = false;
  bridge.updateConfig(cfg);
  steps.push('已停用 DSH 驱动（重启 DSH 后生效）');
  return steps;
}
