import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
    /** allowlist：只处理白名单会话；all：处理全部（黑名单除外） */
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
    }).prefault({}),
  }).prefault({}),
  usage: z.object({
    /** 覆盖默认价目：{ models: { 'model-id': { cacheHit, cacheMiss, output } }, peakMultiplier, ... } */
    prices: z.record(z.string(), z.any()).default({}),
  }).prefault({}),
  dataDir: z.string().default('data'),
});
export type Config = z.infer<typeof ConfigSchema>;

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_PATH = process.env.QAB_CONFIG || path.join(ROOT, 'config', 'qab.yaml');

export function resolveFromRoot(p: string) {
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
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
    config.agents.tokens.push({ name: 'default', token: `qab_${randomToken(24)}`, tiers: ['read', 'send', 'manage', 'danger'], groups: [], private: [], enabled: true, sessionBound: false });
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

/** 在常见位置寻找 SnowLuma 安装目录（含 config/onebot_*.json）。 */
export function guessSnowLumaHome(): string {
  const candidates = [process.env.SNOWLUMA_HOME, path.resolve(ROOT, '..')].filter(Boolean) as string[];
  for (const base of candidates) {
    if (hasOneBotConfig(base)) return base;
    try {
      for (const e of fs.readdirSync(base, { withFileTypes: true })) {
        if (e.isDirectory() && /snowluma/i.test(e.name) && hasOneBotConfig(path.join(base, e.name))) return path.join(base, e.name);
      }
    } catch { /* ignore */ }
  }
  return '';
}

function hasOneBotConfig(dir: string) {
  try { return fs.readdirSync(path.join(dir, 'config')).some((f) => /^onebot_\d+\.json$/i.test(f)); } catch { return false; }
}
