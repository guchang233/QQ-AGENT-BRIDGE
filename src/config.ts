import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';
import { z } from 'zod';
import { atomicWrite, randomToken } from './util/fs.ts';

export const TIERS = ['read', 'send', 'manage', 'danger'] as const;
export type Tier = (typeof TIERS)[number];

const idList = z.array(z.union([z.string(), z.number()]).transform(String)).default([]);

const AgentTokenSchema = z.object({
  name: z.string(),
  token: z.string(),
  /** 允许的权限等级 */
  tiers: z.array(z.enum(TIERS)).default(['read', 'send']),
  /** 允许操作的会话；空 = 跟随全局 access 设置 */
  groups: idList,
  private: idList,
  enabled: z.boolean().default(true),
  /** 会话绑定：每次工具调用都必须带 convToken（由驱动在唤醒提示词里下发），权限收窄到该会话 */
  sessionBound: z.boolean().default(false),
  /** 工具白名单：非空时只提供这些工具（减少提示词体积，加快响应、降低费用） */
  toolAllow: z.array(z.string()).default([]),
});
export type AgentToken = z.infer<typeof AgentTokenSchema>;

export const ConfigSchema = z.object({
  onebot: z.object({
    wsUrl: z.string().default('ws://127.0.0.1:3001'),
    httpUrl: z.string().default('http://127.0.0.1:3000'),
    /** WS token（SnowLuma 中 WS 与 HTTP token 可能不同） */
    accessToken: z.string().default(''),
    httpToken: z.string().default(''),
    /** SnowLuma 安装目录：用于自动读取 config/onebot_<uin>.json 的端口与 token */
    snowlumaHome: z.string().default(''),
    autoDiscover: z.boolean().default(true),
    actionTimeoutMs: z.number().default(30000),
    reconnectMaxMs: z.number().default(30000),
  }).prefault({}),
  server: z.object({
    host: z.string().default('127.0.0.1'),
    port: z.number().default(3210),
    /** 控制台登录密码；为空时首次访问进入设置向导 */
    consolePassword: z.string().default(''),
    sessionSecret: z.string().default(''),
  }).prefault({}),
  /** 管理员 QQ（可多个）：只有他们的指令会被执行；按 QQ 号辨认，不看昵称 */
  owners: idList,
  /** 对管理员的称呼（提示词里使用，例如 管理员 / 管理员 / 老板） */
  ownerTitle: z.string().default('管理员'),
  access: z.object({
    /**
     * 会话启用模式（在控制台「回复与人格设置」里改，那里每个会话一个开关）：
     * all = 全部启用，关掉的会话记在 deny*；allowlist = 只启用勾选的，勾上的记在 groups/private。
     * 没启用的会话：AI 不回复，MCP 客户端和插件也看不到、发不了（管理员私聊始终启用）。
     */
    mode: z.enum(['allowlist', 'all']).default('all'),
    groups: idList,
    private: idList,
    denyGroups: idList,
    denyPrivate: idList,
    /** 全局只读：禁止一切非 read 级动作 */
    readOnly: z.boolean().default(false),
  }).prefault({}),
  limits: z.object({
    sendPerMinute: z.number().default(20),
    sendPerHour: z.number().default(300),
    convPerMinute: z.number().default(8),
    maxMessageChars: z.number().default(3000),
    /** 分条发送时的条间节奏：base + perChar*字数，封顶 max */
    gapBaseMs: z.number().default(800),
    gapPerCharMs: z.number().default(25),
    gapMaxMs: z.number().default(6000),
    /** Agent 一条消息里写了多行时，自动按行拆成多条逐条发送（更像真人） */
    autoSplit: z.boolean().default(true),
    /** 自动拆分最多几条（超过则不拆，按原样发一条） */
    autoSplitMax: z.number().default(6),
  }).prefault({}),
  agents: z.object({
    tokens: z.array(AgentTokenSchema).default([]),
    /** 各等级默认处理：allow 放行 / approve 需控制台审批 / deny 拒绝 */
    policy: z.object({
      read: z.enum(['allow', 'approve', 'deny']).default('allow'),
      send: z.enum(['allow', 'approve', 'deny']).default('allow'),
      manage: z.enum(['allow', 'approve', 'deny']).default('allow'),
      danger: z.enum(['allow', 'approve', 'deny']).default('approve'),
    }).prefault({}),
    approvalTimeoutMs: z.number().default(10 * 60 * 1000),
    /** 不注册到 MCP 的工具名 */
    disabledTools: z.array(z.string()).default([]),
  }).prefault({}),
  media: z.object({
    maxDownloadBytes: z.number().default(30 * 1024 * 1024),
    /** 返回给模型的图片最大字节数，超过则只给链接/路径 */
    maxInlineImageBytes: z.number().default(3 * 1024 * 1024),
    /** agent 发送本地文件时允许读取的目录（空 = 不限制） */
    uploadRoots: z.array(z.string()).default([]),
  }).prefault({}),
  /**
   * 内置功能（仿真、记忆、表情包等）的设置，每个功能一节；enabled: false 表示关闭该功能。
   * 只通过功能页面修改（PUT /api/features/:name/config），/api/config 不读写这一节。
   */
  features: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  plugins: z.object({
    dir: z.string().default('plugins'),
    /** 显式开关（覆盖插件的 defaultEnabled） */
    overrides: z.record(z.string(), z.boolean()).default({}),
    /** 旧版停用列表（兼容） */
    disabled: z.array(z.string()).default([]),
    /** 用户插件文件变化时自动重载 */
    hotReload: z.boolean().default(true),
    /** 命令前缀 */
    commandPrefixes: z.array(z.string()).default(['/', '#']),
    astrbot: z.object({
      enabled: z.boolean().default(false),
      python: z.string().default('python'),
      dir: z.string().default('astrbot_plugins'),
    }).prefault({}),
  }).prefault({}),
  drivers: z.object({
    dsh: z.object({
      enabled: z.boolean().default(false),
      baseUrl: z.string().default('http://127.0.0.1:3080'),
      /** 本机 DSH 桌面版端口随机：连不上时自动探测本机 DSH 进程的端口 */
      autoDiscover: z.boolean().default(true),
      /** 可选：DSH 进程启动 token；留空则用 ~/.dsh 中的会话密钥离线签发（推荐） */
      authToken: z.string().default(''),
      allowRemote: z.boolean().default(false),
      dshHome: z.string().default(''),
      /** DSH profile：auto = 桌面版运行中用 desktop，否则 web */
      profile: z.string().default('auto'),
      /** 使用的 Agent 预设（一键接入会安装 qab-qq） */
      preset: z.string().default('qab-qq'),
      provider: z.string().default('deepseek-official'),
      model: z.string().default('deepseek-flash'),
      reasoningEffort: z.enum(['off', 'low', 'high', 'max']).default('high'),
      workspacePath: z.string().default(''),
      /** 与 qq-bridge 一致：所有 QQ 会话挂在同一个工作区，首次创建时命名 */
      workspaceTitle: z.string().default('QQ 聊天'),
      /** DSH 工具审批：console 交给控制台审批 / reject 一律拒绝 */
      approvals: z.enum(['console', 'reject']).default('reject'),
      /** 一轮运行多少分钟没有任何进展（工具调用、输出）就判定卡住并自动结束 */
      stallMinutes: z.number().int().min(1).max(120).default(5),
    }).prefault({}),
  }).prefault({}),
  usage: z.object({
    /** 覆盖默认价目：{ models: { 'model-id': { cacheHit, cacheMiss, output } }, peakMultiplier, ... } */
    prices: z.record(z.string(), z.any()).default({}),
  }).prefault({}),
  bot: z.object({
    /** 守护进程启动时自动连接 QQ（默认否：只在控制台点「启动机器人」时连接） */
    autoConnect: z.boolean().default(false),
    /** 连接断开后自动重连（默认否：断开即停止） */
    autoReconnect: z.boolean().default(false),
  }).prefault({}),
  update: z.object({
    /** 定时检查 GitHub Release 新版本 */
    check: z.boolean().default(true),
    checkIntervalHours: z.number().min(1).default(6),
    /** 发现新版本后自动下载并在重启时安装（仅发布包安装方式；由 start.bat/start.sh 启动时会立即重启） */
    autoInstall: z.boolean().default(false),
    /** 包含预发布版本 */
    prerelease: z.boolean().default(false),
    repo: z.string().default('guchang233/QQ-AGENT-BRIDGE'),
    /** 访问 GitHub 用的 HTTP 代理（留空 = 读取 HTTPS_PROXY 环境变量） */
    proxy: z.string().default(''),
    /** 下载加速前缀（如 https://ghfast.top/ ），只作用于安装包下载 */
    mirror: z.string().default(''),
    /** 发现新版本时私聊通知管理员 */
    notifyOwner: z.boolean().default(false),
  }).prefault({}),
  dataDir: z.string().default('data'),
});
export type Config = z.infer<typeof ConfigSchema>;

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/**
 * 用户数据目录（配置、数据库、人格卡、用户插件）：
 *   QAB_HOME 环境变量 > 通过 npm 安装（位于 node_modules 内）时用 ~/.qq-agent-bridge > 程序目录（源码 / 发布包）
 * 程序自带的文件（控制台、系统插件、AstrBot 兼容层）始终从 ROOT 读取。
 */
export const HOME = process.env.QAB_HOME ? path.resolve(process.env.QAB_HOME)
  : ROOT.split(path.sep).includes('node_modules') ? path.join(os.homedir(), '.qq-agent-bridge') : ROOT;
export const CONFIG_PATH = process.env.QAB_CONFIG || path.join(HOME, 'config', 'qab.yaml');

export function resolveFromRoot(p: string) {
  return path.isAbsolute(p) ? p : path.join(HOME, p);
}

export function loadConfig(file = CONFIG_PATH): { config: Config; created: boolean } {
  let raw: unknown = {};
  let created = false;
  if (fs.existsSync(file)) {
    raw = YAML.parse(fs.readFileSync(file, 'utf8')) ?? {};
  } else {
    created = true;
  }
  const config = ConfigSchema.parse(raw);
  let dirty = created;
  if (!config.server.sessionSecret) { config.server.sessionSecret = randomToken(32); dirty = true; }
  if (config.agents.tokens.length === 0) {
    config.agents.tokens.push({ name: 'default', token: `qab_${randomToken(24)}`, tiers: ['read', 'send', 'manage', 'danger'], groups: [], private: [], enabled: true, sessionBound: false, toolAllow: [] });
    dirty = true;
  }
  // 旧版默认工作区名 → 与 qq-bridge 一致的「QQ 聊天」
  if (config.drivers.dsh.workspaceTitle === 'QQ-Agent Bridge') { config.drivers.dsh.workspaceTitle = 'QQ 聊天'; dirty = true; }
  if (!config.onebot.snowlumaHome) {
    const guess = guessSnowLumaHome();
    if (guess) { config.onebot.snowlumaHome = guess; dirty = true; }
  }
  if (dirty) saveConfig(config, file);
  return { config, created };
}

export function saveConfig(config: Config, file = CONFIG_PATH) {
  const doc = new YAML.Document(config);
  doc.commentBefore = ' QQ-Agent Bridge 配置。可在 Web 控制台「设置」页修改，保存后多数项即时生效。';
  atomicWrite(file, doc.toString({ lineWidth: 0 }));
}

/**
 * 寻找 SnowLuma 安装目录（含 config/onebot_*.json）：
 *   1. 环境变量、程序所在目录的上级
 *   2. 正在运行的 SnowLuma 进程（装在哪都能找到，前提是它已启动）
 *   3. 各磁盘根目录下两层内名字含 snowluma 的目录（如 D:\QQBot\SnowLuma）
 */
export function guessSnowLumaHome(): string {
  const near = [process.env.SNOWLUMA_HOME, path.resolve(HOME, '..'), path.resolve(ROOT, '..'), process.cwd()].filter(Boolean) as string[];
  const found = searchUnder(near, 1);
  if (found) return found;
  for (const p of runningProcessPaths()) {
    for (let d = path.dirname(p), i = 0; i < 4 && d !== path.dirname(d); d = path.dirname(d), i++) if (hasOneBotConfig(d)) return d;
  }
  return searchUnder(driveRoots(), 2);
}

/** 在 bases 本身及其下 depth 层内找名字含 snowluma 的安装目录 */
function searchUnder(bases: string[], depth: number): string {
  for (const base of [...new Set(bases)]) {
    if (hasOneBotConfig(base)) return base;
    if (depth <= 0) continue;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || /^(\$|windows$|program ?data$|system volume)/i.test(e.name)) continue;
      const sub = path.join(base, e.name);
      if (/snowluma/i.test(e.name) && hasOneBotConfig(sub)) return sub;
      if (depth > 1) {
        try {
          for (const e2 of fs.readdirSync(sub, { withFileTypes: true })) {
            if (e2.isDirectory() && /snowluma/i.test(e2.name) && hasOneBotConfig(path.join(sub, e2.name))) return path.join(sub, e2.name);
          }
        } catch { /* 无权限的目录跳过 */ }
      }
    }
  }
  return '';
}

function driveRoots(): string[] {
  if (process.platform !== 'win32') return [os.homedir(), '/opt', '/srv'];
  return 'CDEFGHIJ'.split('').map((d) => d + ':' + path.sep).filter((d) => { try { fs.accessSync(d); return true; } catch { return false; } });
}

/** 命令行或可执行文件路径里带 snowluma 的进程，返回其中出现的路径 */
export function runningProcessPaths(): string[] {
  const LF = String.fromCharCode(10), NUL = String.fromCharCode(0);
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command',
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'snowluma' -or $_.ExecutablePath -match 'snowluma' } | ForEach-Object { $_.ExecutablePath; $_.CommandLine }"],
      { encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      // 引号里的整段路径，或不带引号时按空格切开的片段
      return out.split(LF).flatMap((l) => l.split('"')).flatMap((x) => [x, ...x.split(' ')]).map((x) => x.trim()).filter((x) => /^[A-Za-z]:/.test(x));
    }
    const out: string[] = [];
    for (const pid of fs.readdirSync('/proc').filter((x) => /^[0-9]+$/.test(x))) {
      try {
        const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split(NUL);
        if (cmd.some((c) => /snowluma/i.test(c))) out.push(...cmd.filter((c) => c.startsWith('/')), path.join(fs.readlinkSync(`/proc/${pid}/cwd`), 'x'));
      } catch { /* 进程已退出 */ }
    }
    return out;
  } catch { return []; }
}

export function hasOneBotConfig(dir: string) {
  try { return fs.readdirSync(path.join(dir, 'config')).some((f) => /^onebot_\d+\.json$/i.test(f)); } catch { return false; }
}
