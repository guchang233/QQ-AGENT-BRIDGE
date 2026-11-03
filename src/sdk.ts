/**
 * QAB 插件 SDK（公开接口）。插件中：
 *
 *   import { definePlugin, z } from 'qq-agent-bridge';
 *   export default definePlugin({ name: 'my-plugin', apiVersion: 1, permissions: ['send'], setup(ctx) { … } });
 *
 * 兼容承诺：
 * - 这里导出的类型和函数就是插件能用的全部能力。API_VERSION 不变，插件就不需要改。
 * - 旧接口先标 @deprecated，至少保留一个大版本再删除。
 * - 本文件不引用 QAB 内部模块的类型，内部怎么重构都不会影响插件。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { z as Z } from 'zod';
import { parseConv as _parseConv, convKey as _convKey, plainText as _plainText } from './message/segments.ts';

/** 插件 API 主版本号。插件在 apiVersion 里声明自己按哪个版本写的。 */
export const API_VERSION = 1;

// ============================================================================
// 基础类型
// ============================================================================
/** 消息段（OneBot v11 格式），如 { type: 'text', data: { text: '你好' } }、{ type: 'at', data: { qq: '123' } } */
export interface Segment { type: string; data: Record<string, any> }
export interface ConvRef { type: 'group' | 'private'; id: string }
/** 发消息的内容：字符串（支持 [face:微笑]、[at:123] 等内联标记，见 docs/tools.md）或消息段数组 */
export type Content = string | Segment[];

/** 会话 ID 解析：group:123 / private:456，也接受 g123 / p456 / 纯数字（默认群） */
export const parseConv = (s: string | number): ConvRef => _parseConv(s) as ConvRef;
/** 会话 ID 规范化成 group:123 / private:456 */
export const convKey = (c: ConvRef | string): string => _convKey(typeof c === 'string' ? _parseConv(c) : c as any);
/** 消息段转纯文本 */
export const plainText = (segs: Segment[]): string => _plainText(segs as any);
/** 压成一行并截断 */
export function oneLine(s: unknown, max = 200): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * 权限声明。在 plugin.json 或 definePlugin 里写 permissions；安装时展示给用户。
 * 声明了 permissions 的插件，调用未声明的能力会直接报错；没声明的插件视为需要全部权限。
 */
export type Permission =
  | 'send'        // 发消息、回复、贴表情
  | 'onebot'      // 直接调用 OneBot 动作（ctx.qq.call）
  | 'history'     // 读取聊天记录、联系人之外的记录（ctx.qq.recent、ctx.memory.recall）
  | 'memory'      // 写入记忆（ctx.memory.remember）
  | 'agent-tools' // 给 AI 注册工具（ctx.tool）
  | 'http';       // 注册控制台接口（ctx.route）

// ============================================================================
// 配置声明（同时驱动类型推断、默认值和控制台表单）
// ============================================================================
export type FieldType = 'string' | 'text' | 'secret' | 'int' | 'float' | 'bool' | 'list' | 'select' | 'json';
export interface ConfigField<T extends FieldType = FieldType> {
  type: T;
  default?: unknown;
  description?: string;
  hint?: string;
  options?: (string | number)[];
  min?: number;
  max?: number;
  /** 控制台中的分组标题 */
  group?: string;
  /** 高级设置：控制台里默认折叠 */
  advanced?: boolean;
}
export type ConfigSchema = Record<string, ConfigField>;
type ValueOf<F extends ConfigField> =
  F['type'] extends 'int' | 'float' ? number :
  F['type'] extends 'bool' ? boolean :
  F['type'] extends 'list' ? string[] :
  F['type'] extends 'json' ? any :
  F['options'] extends readonly (infer O)[] ? O : string;
export type ConfigOf<S extends ConfigSchema> = { [K in keyof S]: ValueOf<S[K]> };

// ============================================================================
// 插件定义
// ============================================================================
export interface PluginMeta {
  /** 唯一名称（英文、短横线） */
  name?: string;
  displayName?: string;
  version?: string;
  description?: string;
  author?: string;
  /** 按哪个 API 版本写的（目前是 1）。写了才会启用新版上下文（插件自己的数据库等） */
  apiVersion?: number;
  /** 需要的权限，见 Permission */
  permissions?: Permission[];
  /** 依赖的其他插件：先于本插件加载，可用 ctx.use(名称) 取得其服务 */
  depends?: string[];
  softDepends?: string[];
  /** 没在控制台开关过时是否启用（默认 true） */
  defaultEnabled?: boolean;
  config?: ConfigSchema;
}
export interface PluginDefinition<S extends ConfigSchema = ConfigSchema> extends PluginMeta {
  config?: S;
  setup(ctx: PluginContext<ConfigOf<S>>): void | Promise<void>;
}
/** 定义插件。配置类型由 config 声明自动推断。 */
export function definePlugin<S extends ConfigSchema = {}>(def: PluginDefinition<S>): PluginDefinition<S> { return def; }

// ============================================================================
// 事件
// ============================================================================
export interface MessageEvent {
  /** 会话 ID：group:123 / private:456 */
  conv: string;
  convRef: ConvRef;
  msgId: string;
  senderId: string;
  senderName: string;
  isGroup: boolean;
  groupId?: string;
  /** 纯文本（去掉开头的 @我 和回复段） */
  text: string;
  /** 可读渲染（含 [图片] 等占位） */
  rendered: string;
  segments: Segment[];
  /** 是否 @ 了机器人或回复了机器人 */
  mentioned: boolean;
  /** 发送者是否是管理员 */
  isOwner: boolean;
  ts: number;
  /** 命令处理器：命令后面的参数 */
  args: string[];
  argText: string;
  /** 正则处理器：匹配结果 */
  match?: RegExpMatchArray;
  /** OneBot 原始事件 */
  raw: unknown;
  reply(content: Content, opts?: { at?: boolean }): Promise<void>;
  send(content: Content): Promise<void>;
  react(emoji: string): Promise<void>;
  /** 阻止后续插件处理这条消息 */
  stop(): void;
  /** 标记为已处理：阻止后续插件，也不再唤醒 AI（命令处理器会自动调用） */
  consume(): void;
  readonly stopped: boolean;
}
export type Handler = (e: MessageEvent) => unknown | Promise<unknown>;
export interface HandlerOptions {
  /** 越大越先执行（默认 0） */
  priority?: number;
  scope?: 'group' | 'private' | 'all';
  ownerOnly?: boolean;
  /** 群聊中只在被 @ 时触发 */
  requireMention?: boolean;
  desc?: string;
}
export interface CommandOptions extends HandlerOptions {
  aliases?: string[];
  /** 用法提示，如 "<关键词> [数量]" */
  usage?: string;
}

/** 一条聊天记录（只读快照） */
export interface ChatMessage {
  conv: string;
  msgId: string;
  senderId: string;
  senderName: string;
  isSelf: boolean;
  text: string;
  segments: Segment[];
  mentioned: boolean;
  ts: number;
}

/** 调用工具的 AI 身份。代表它发消息时传给 ctx.qq.send 的 as，限流与审计记在它名下。 */
export interface AgentCaller { readonly name: string; readonly __caller: unknown }
export type Tier = 'read' | 'send' | 'manage' | 'danger';
export interface ToolResult { content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; isError?: boolean }
export interface ToolDef<S extends Z.ZodRawShape = Z.ZodRawShape> {
  /** 以 qq_ 开头则原样使用，否则自动加 "<插件名>_" 前缀 */
  name: string;
  title?: string;
  description: string;
  /** 权限等级（默认 send） */
  tier?: Tier;
  readOnly?: boolean;
  /** 处理器内部用 ctx.qq.send(…, { as: caller }) 发消息时设为 true，避免重复审批 */
  selfAudited?: boolean;
  input: S;
  handler: (args: Z.infer<Z.ZodObject<S>>, caller: AgentCaller) => Promise<string | ToolResult | object> | string | ToolResult | object;
}
export interface RouteRequest { query: Record<string, string>; body: any; params: Record<string, string> }

export interface MemoryItem { id: number; content: string; kind: string; scope: string; subject?: string; importance: number }

// ============================================================================
// 插件上下文
// ============================================================================
export interface PluginContext<C = Record<string, any>> {
  readonly name: string;
  readonly logger: { debug(...a: unknown[]): void; info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
  /** 插件专属数据目录 data/plugins/<名称>（卸载时可选择保留） */
  readonly dataDir: string;
  /** 合并默认值后的配置（控制台保存后插件会自动重载） */
  readonly config: C;
  saveConfig(patch: Partial<C>): void;

  /** 简单的键值存储 */
  kv: { get<T = unknown>(key: string, fallback?: T): T; set(key: string, value: unknown): void; delete(key: string): void };
  /**
   * 插件自己的 SQLite 数据库（data/plugins/<名称>/plugin.db），node:sqlite 同步 API。
   * 声明了 apiVersion 才是插件自己的库；没声明的旧插件这里仍是主库（已弃用）。
   */
  readonly db: DatabaseSync;
  /** 执行建表/迁移 SQL（请写成可重复执行的） */
  migrate(sql: string): void;

  qq: {
    /** 发消息（需要 send 权限）。as：代表某个 AI 发（在工具处理器里用） */
    send(conv: string, content: Content, opts?: { replyTo?: string; atSender?: string; as?: AgentCaller }): Promise<string[]>;
    /** 直接调用 OneBot 动作（需要 onebot 权限），如 call('get_stranger_info', { user_id: 123 }) */
    call<T = any>(action: string, params?: Record<string, unknown>): Promise<T>;
    readonly selfId: string | undefined;
    /** 群名片/备注/昵称 */
    nameOf(conv: string, userId: string): string | undefined;
    /** 群名或好友名 */
    convName(conv: string): string;
    isOwner(userId: string): boolean;
    groups(): { id: string; name: string; memberCount?: number }[];
    friends(): { id: string; nickname: string; remark: string }[];
    /** 最近的聊天记录（需要 history 权限），从旧到新 */
    recent(conv: string, limit?: number): ChatMessage[];
    /** @deprecated 内部格式，跨版本不稳定 */
    format(m: any): string;
  };
  /** 记忆功能（关闭时为 undefined） */
  readonly memory: undefined | {
    /** 需要 memory 权限 */
    remember(input: { content: string; scope?: string; subject?: string; kind?: 'fact' | 'preference' | 'event' | 'relation' | 'note'; importance?: number }): Promise<{ id: number }>;
    /** 需要 history 权限 */
    recall(input: { query: string; scope?: string; limit?: number }): Promise<MemoryItem[]>;
  };

  // ---- 消息处理
  command(name: string | string[], handler: Handler, opts?: CommandOptions): void;
  onRegex(re: RegExp, handler: Handler, opts?: HandlerOptions): void;
  onMessage(handler: Handler, opts?: HandlerOptions): void;
  /** OneBot 通知，如 'poke'、'group_increase'、'*' */
  onNotice(type: string, handler: (ev: any) => unknown): void;
  /** 好友/入群申请 */
  onRequest(handler: (req: any) => unknown): void;
  /** 连上 QQ 时 */
  onConnected(fn: () => unknown): void;
  /** 机器人自己发出消息后 */
  onMessageSent(fn: (m: ChatMessage) => unknown): void;

  // ---- 对外能力
  /** 给 AI 注册工具（需要 agent-tools 权限） */
  tool<S extends Z.ZodRawShape>(def: ToolDef<S>): void;
  /** 向其他插件提供服务 */
  provide<T extends object>(service: T): void;
  use<T = any>(plugin: string): T;
  useOptional<T = any>(plugin: string): T | undefined;
  /** 控制台接口 /api/p/<插件名>/<path>（需要登录、需要 http 权限），path 支持 :param */
  route(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, handler: (req: RouteRequest) => unknown | Promise<unknown>): void;
  /** 在控制台「动态」里记一条 */
  activity(title: string, detail?: string, level?: 'info' | 'warn' | 'error' | 'success'): void;

  // ---- 定时
  /** cron 表达式，如 '0 8 * * *'（每天 8 点） */
  schedule(cron: string, fn: () => unknown): void;
  setInterval(fn: () => unknown, ms: number): void;
  setTimeout(fn: () => unknown, ms: number): void;
  onUnload(fn: () => unknown): void;
  /** 所有已加载的命令（做帮助菜单用） */
  listCommands(): { plugin: string; names: string[]; desc: string; usage?: string }[];

  // ---- 已弃用（为旧插件保留，下个大版本删除）
  /** @deprecated 内部对象，跨版本不稳定。请改用 ctx.qq / ctx.memory 等 */
  readonly bridge: any;
  /** @deprecated 内部对象。请改用 ctx.qq.recent */
  readonly store: any;
  /** @deprecated 内部对象 */
  readonly media: any;
  /** @deprecated 请改用 onConnected / onMessageSent / onMessage / onNotice / onRequest */
  on(event: 'message' | 'message_sent' | 'notice' | 'request' | 'connected', fn: (...args: any[]) => unknown): void;
}

export { z } from 'zod';
