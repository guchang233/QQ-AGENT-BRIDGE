import fs from 'node:fs';
import path from 'node:path';
import type { Bridge } from '../../bridge.ts';
import { ROOT } from '../../config.ts';
import { randomToken } from '../../util/fs.ts';
import { dshHome, localDshPorts, DshClient, discoverDshBaseUrl, isLoopback } from './client.ts';
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
/** stdio 代理的修订号；修改代理逻辑时递增 */
const PROXY_REV = '3';

/** DSH 仿真会话只需要聊天相关的工具（群管理/文件/底层动作等不提供，提示词更小、响应更快） */
export const DSH_TOOLS = [
  'qq_status', 'qq_get_unread', 'qq_wait_messages', 'qq_get_history', 'qq_search_messages', 'qq_get_message', 'qq_get_forward',
  'qq_send', 'qq_reply', 'qq_send_burst', 'qq_recall', 'qq_send_image', 'qq_get_image', 'qq_ocr',
  'qq_get_user', 'qq_list_members', 'qq_search_face', 'qq_react', 'qq_poke',
  'qq_list_stickers', 'qq_send_sticker', 'qq_collect_sticker', 'qq_sticker_note',
  'qq_speak', 'qq_transcribe',
  'qq_memory_remember', 'qq_memory_recall', 'qq_memory_context', 'qq_memory_update',
  'qq_set_wake', 'qq_social_state', 'qq_get_persona',
  'qq_web_search', 'qq_web_fetch',
  'qq_schedule', 'qq_schedule_list', 'qq_schedule_cancel',
  'qq_qzone_feeds', 'qq_qzone_list',
];

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

const NL = String.fromCharCode(10);
const slash = (p: string) => p.split(path.sep).join('/');
/** 去掉本项目在 cordis.patch.yml 中的标记区块（只动自己的区块）。 */
function withoutBlock(text: string): string {
  const a = text.indexOf(BEGIN);
  if (a < 0) return text;
  const b = text.indexOf(END, a);
  if (b < 0) return text;
  return text.slice(0, a) + text.slice(b + END.length).replace(/^\r?\n/, '');
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

/** 找到可用的 DSH（运行中才返回客户端）。 */
async function liveDsh(bridge: Bridge): Promise<DshClient | null> {
  const c = bridge.config.drivers.dsh;
  const opts = { authToken: c.authToken || undefined, allowRemote: c.allowRemote, dshHome: c.dshHome || undefined };
  const url = (await new DshClient({ ...opts, baseUrl: c.baseUrl, timeoutMs: 4000 }).ping()) ? c.baseUrl
    : c.autoDiscover && isLoopback(c.baseUrl) ? await discoverDshBaseUrl(opts, c.baseUrl) : '';
  if (!url) return null;
  if (url !== c.baseUrl) { const cfg = structuredClone(bridge.config); cfg.drivers.dsh.baseUrl = url; bridge.updateConfig(cfg); }
  return new DshClient({ ...opts, baseUrl: url, timeoutMs: 300_000 });
}

/** 手动注册 bundle（DSH 未运行时的退路）：两层目录链接 + profile package.json。 */
function manualRegister(p: ReturnType<typeof paths>) {
  link(p.bundleSrc, p.pluginLink);
  link(p.pluginLink, p.nmLink);
  backup(p.pkgFile);
  const pkg = JSON.parse(fs.readFileSync(p.pkgFile, 'utf8'));
  pkg.dependencies ??= {};
  pkg.dependencies[BUNDLE_NAME] = `link:${slash(p.pluginLink)}`;
  pkg.dsh ??= {}; pkg.dsh.profile ??= {}; pkg.dsh.profile.bundles ??= [];
  if (!pkg.dsh.profile.bundles.includes(BUNDLE_NAME)) pkg.dsh.profile.bundles.push(BUNDLE_NAME);
  fs.writeFileSync(p.pkgFile, JSON.stringify(pkg, null, 2) + NL);
}

export async function installDsh(bridge: Bridge): Promise<{ steps: string[]; restartRequired: boolean; warnings: string[] }> {
  const p = paths(bridge);
  const steps: string[] = [];
  const warnings: string[] = [];
  if (!fs.existsSync(p.profileDir)) throw new Error(`找不到 DSH profile 目录：${p.profileDir}（请确认已安装并运行过一次 DSH，或在设置中修改 DSH 目录 / profile）`);

  // 1. 专用 agent token：会话绑定 + 读/发权限
  const cfg = structuredClone(bridge.config);
  let tok = cfg.agents.tokens.find((t) => t.name === DSH_TOKEN_NAME);
  if (!tok) {
    tok = { name: DSH_TOKEN_NAME, token: `qab_${randomToken(24)}`, tiers: ['read', 'send'], groups: [], private: [], enabled: true, sessionBound: true, toolAllow: [...DSH_TOOLS] };
    cfg.agents.tokens.push(tok);
    steps.push('创建 Agent token「dsh」（会话绑定，权限：读取+发送）');
  } else if (!tok.sessionBound || !tok.enabled) {
    tok.sessionBound = true; tok.enabled = true;
    steps.push('已将 token「dsh」设为会话绑定');
  }
  if (!tok.toolAllow?.length) { tok.toolAllow = [...DSH_TOOLS]; steps.push(`DSH 只提供 ${DSH_TOOLS.length} 个聊天相关工具（可在 config 的 agents.tokens 中调整）`); }
  cfg.drivers.dsh.enabled = true;
  cfg.drivers.dsh.preset = PRESET_ID;
  bridge.updateConfig(cfg);

  // 2. 生成 bundle 文件
  writeBundle(p.bundleSrc);
  steps.push(`生成预设 bundle ${BUNDLE_NAME}（预设 ${PRESET_ID}）`);

  // 3. cordis.patch.yml：MCP 服务（stdio 代理到本守护进程）
  backup(p.patchFile);
  const old = fs.existsSync(p.patchFile) ? fs.readFileSync(p.patchFile, 'utf8') : '';
  const q = (x: string) => `'${x.replace(/'/g, "''")}'`;
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
    // 代理版本号：升级代理后改变它，DSH（热重载）会重新拉起 MCP 进程以加载新代码
    '          - --proxy-rev',
    `          - '${PROXY_REV}'`,
    '        toolCallTimeoutMs: 1900000',
    END,
  ].join(NL);
  fs.writeFileSync(p.patchFile, withoutBlock(old).trimEnd() + (old.trim() ? NL : '') + block + NL);
  steps.push(`在 cordis.patch.yml 注册 MCP 服务「${MCP_SERVER_NAME}」`);

  // 4. 安装并启用 bundle：DSH 运行中 → 走 DSH 自己的插件管理器（自带 pnpm，与设置页「插件管理」同一路径）
  let restartRequired = true;
  const dsh = await liveDsh(bridge);
  if (dsh) {
    const bundles: any[] = await dsh.call('pluginManager/listBundles', {}).catch(() => []);
    const ex = bundles.find((b) => b?.name === BUNDLE_NAME);
    let r: any;
    if (ex?.installed) {
      // 已安装：bundle 是链接，文件已更新；先停用再启用，让 DSH 重新加载预设
      await dsh.call('pluginManager/setBundleEnabled', { name: BUNDLE_NAME, enabled: false }).catch(() => {});
      r = await dsh.call('pluginManager/setBundleEnabled', { name: BUNDLE_NAME, enabled: true });
      steps.push('预设 bundle 已更新，并通过 DSH 插件管理器重新加载');
    } else {
      const spec = `link:${slash(p.bundleSrc)}`;
      r = await dsh.call('pluginManager/installBundle', { spec, options: { enabled: true, requestId: `qab-${Date.now()}` } });
      if (r?.status === 'refused') throw new Error(`DSH 拒绝安装预设：${r.problem ?? ''} ${r.reason ?? ''}`.trim());
      steps.push('已通过 DSH 插件管理器安装并启用预设 bundle（使用 DSH 自带的 pnpm）');
    }
    const outcome = JSON.stringify(r ?? {});
    restartRequired = /restart/i.test(outcome) && !/"restartRequired":false/.test(outcome);
    // 确认预设已出现（DSH 热加载需要一点时间，最多等 10 秒）
    let seen = false;
    for (let i = 0; i < 20 && !seen; i++) {
      const presets: any = await dsh.call('agentPresets/list', {}).catch(() => null);
      seen = !!presets?.presets?.some((x: any) => x.id === PRESET_ID);
      if (!seen) await new Promise((res) => setTimeout(res, 500));
    }
    if (seen) { steps.push(`DSH 已加载预设「${PRESET_ID}」，无需重启`); restartRequired = false; }
    else warnings.push(`等待 10 秒仍未看到预设「${PRESET_ID}」：可以稍后点「测试连接」确认，仍没有再重启 DSH`);
  } else {
    manualRegister(p);
    steps.push('DSH 未运行：已手动链接 bundle 并写入 profile package.json');
    warnings.push('请启动（或重启）DSH 使配置生效；若 DSH 提示 bundle 解析失败，打开 DSH 后在这里再点一次「一键接入」即可由 DSH 自己完成安装。');
  }

  if (dshSetupStatus(bridge).qqBridgeDetected) warnings.push('检测到 qq-bridge 的 DSH 配置：已保留不动，两者可以共存（qq-bridge 用 qq-chat-v2 预设，本项目用 qab-qq 预设）。');
  return { steps, restartRequired, warnings };
}

export async function uninstallDsh(bridge: Bridge): Promise<string[]> {
  const p = paths(bridge);
  const steps: string[] = [];
  const dsh = await liveDsh(bridge).catch(() => null);
  if (dsh) {
    try { await dsh.call('pluginManager/removeBundle', { name: BUNDLE_NAME }); steps.push('已通过 DSH 插件管理器移除预设 bundle'); } catch (e: any) { steps.push(`DSH 移除 bundle 失败（${e.message}），改为手动移除`); }
  }
  if (fs.existsSync(p.patchFile)) {
    const old = fs.readFileSync(p.patchFile, 'utf8');
    if (old.includes(BEGIN)) {
      backup(p.patchFile);
      fs.writeFileSync(p.patchFile, withoutBlock(old).trimEnd() + NL);
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
