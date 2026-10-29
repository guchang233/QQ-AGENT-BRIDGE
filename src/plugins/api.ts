import type { DatabaseSync } from 'node:sqlite';
import type { z } from 'zod';
import type { Segment, ConvRef } from '../message/segments.ts';
import type { Logger } from '../util/log.ts';
import type { Tier } from '../config.ts';
import type { Bridge, SendOptions } from '../bridge.ts';
import type { ToolResult } from '../mcp/tools.ts';
import type { StoredMessage, Store } from '../store/db.ts';
import type { MediaService } from '../media.ts';
import type { Caller } from '../policy.ts';

// ============================================================================
// 配置声明（同时驱动：类型推断 + 默认值 + 控制台表单）
// ============================================================================
export type FieldType = 'string' | 'text' | 'secret' | 'int' | 'float' | 'bool' | 'list' | 'select' | 'json';

export interface ConfigField<T extends FieldType = FieldType> {
  type: T;
  default?: unknown;
  description?: string;
  hint?: string;
  /** select 的可选项 */
  options?: (string | number)[];
  min?: number;
  max?: number;
  /** 控制台中归入的分组标题 */
  group?: string;
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
  /** 唯一名称（英文、短横线）。目录插件可省略，默认取目录名 */
  name?: string;
  displayName?: string;
  version?: string;
  description?: string;
  author?: string;
  /** 依赖的其它插件；会先于本插件加载，可通过 ctx.use(name) 取得其服务 */
  depends?: string[];
  /** 可选依赖：存在则先加载，不存在也不报错 */
  softDepends?: string[];
  /** 未在设置中显式开关时是否启用（默认 true） */
  defaultEnabled?: boolean;
  /** 配置声明 */
  config?: ConfigSchema;
}

export interface PluginDefinition<S extends ConfigSchema = ConfigSchema> extends PluginMeta {
  config?: S;
  setup(ctx: PluginContext<ConfigOf<S>>): void | Promise<void>;
}

/** 定义插件。配置类型会根据 config 声明自动推断。 */
export function definePlugin<S extends ConfigSchema = {}>(def: PluginDefinition<S>): PluginDefinition<S> { return def; }

// ============================================================================
// 消息事件
// ============================================================================
export interface MessageEvent {
  conv: string;
  convRef: ConvRef;
  msgId: string;
  senderId: string;
  senderName: string;
  isGroup: boolean;
  groupId?: string;
  /** 纯文本（去掉开头的 @我 与回复段） */
  text: string;
  /** 可读渲染（含 [图片#ref] 等） */
  rendered: string;
  segments: Segment[];
  mentioned: boolean;
  isOwner: boolean;
  ts: number;
  /** 命令处理器：命令后面的参数 */
  args: string[];
  argText: string;
  /** 正则处理器：匹配结果 */
  match?: RegExpMatchArray;
  message: StoredMessage;
  raw: any;
  reply(content: string | Segment[], opts?: { at?: boolean }): Promise<void>;
  send(content: string | Segment[], opts?: SendOptions): Promise<void>;
  react(emoji: string): Promise<void>;
  /** 阻止后续插件处理该消息 */
  stop(): void;
  readonly stopped: boolean;
}

export type Handler = (e: MessageEvent) => unknown | Promise<unknown>;

export interface HandlerOptions {
  /** 越大越先执行（默认 0；系统插件常用 ±100） */
  priority?: number;
  scope?: 'group' | 'private' | 'all';
  ownerOnly?: boolean;
  /** 群聊中仅被 @ 时触发 */
  requireMention?: boolean;
  desc?: string;
}
export interface CommandOptions extends HandlerOptions {
  aliases?: string[];
  /** 用法提示，如 "<关键词> [数量]" */
  usage?: string;
}

export interface PluginToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  /** 以 qq_ 开头则原样使用，否则自动加 "<插件名>_" 前缀 */
  name: string;
  title?: string;
  description: string;
  tier?: Tier;
  readOnly?: boolean;
  /** 处理器内部已通过 bridge.send / bridge.callAction(caller, …) 完成鉴权与审计时设为 true，避免重复审批 */
  selfAudited?: boolean;
  input: S;
  /** caller：调用该工具的 Agent 身份；发消息时传给 bridge.send 以计入其限流与审计 */
  handler: (args: z.infer<z.ZodObject<S>>, caller: Caller) => Promise<string | ToolResult | object> | string | ToolResult | object;
}

export interface RouteRequest { query: Record<string, string>; body: any; params: Record<string, string> }

export type BridgeEventName = 'message' | 'message_sent' | 'notice' | 'request' | 'connected';

// ============================================================================
// 插件上下文
// ============================================================================
export interface PluginContext<C = Record<string, any>> {
  readonly name: string;
  readonly logger: Logger;
  /** 插件专属数据目录 data/plugins/<name> */
  readonly dataDir: string;
  /** 合并默认值后的配置（控制台保存后插件会自动重载） */
  readonly config: C;
  saveConfig(patch: Partial<C>): void;

  /** 简单 KV 持久化 */
  kv: { get<T = unknown>(key: string, fallback?: T): T; set(key: string, value: unknown): void; delete(key: string): void };
  /** 共享 SQLite 连接（建议表名以插件名为前缀） */
  readonly db: DatabaseSync;
  /** 执行建表/迁移 SQL（幂等） */
  migrate(sql: string): void;
  readonly store: Store;
  readonly media: MediaService;

  qq: {
    send(conv: string, content: string | Segment[], opts?: SendOptions): Promise<string[]>;
    call<T = any>(action: string, params?: Record<string, unknown>): Promise<T>;
    readonly selfId: string | undefined;
    nameOf(conv: string, userId: string): string | undefined;
    format(m: StoredMessage): string;
  };
  /** 底层桥接对象（逃生舱，慎用） */
  readonly bridge: Bridge;

  // ---- 消息处理
  command(name: string | string[], handler: Handler, opts?: CommandOptions): void;
  onRegex(re: RegExp, handler: Handler, opts?: HandlerOptions): void;
  onMessage(handler: Handler, opts?: HandlerOptions): void;
  onNotice(type: string | '*', handler: (ev: any) => unknown): void;
  onRequest(handler: (req: any) => unknown): void;
  /** 订阅桥接事件（自动在卸载时退订） */
  on(event: BridgeEventName, fn: (...args: any[]) => unknown): void;

  // ---- 对外能力
  /** 注册 MCP 工具，供 Agent 调用 */
  tool<S extends z.ZodRawShape>(def: PluginToolDef<S>): void;
  /** 向其它插件提供服务（ctx.use(本插件名) 取得） */
  provide<T extends object>(service: T): void;
  /** 取得依赖插件提供的服务 */
  use<T = any>(plugin: string): T;
  useOptional<T = any>(plugin: string): T | undefined;
  /** 注册控制台 HTTP 接口：/api/p/<插件名>/<path>（需登录），path 支持 :param */
  route(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, handler: (req: RouteRequest) => unknown | Promise<unknown>): void;

  // ---- 定时
  /** cron 表达式，如 '0 8 * * *'（每天 8 点） */
  schedule(cron: string, fn: () => unknown): void;
  setInterval(fn: () => unknown, ms: number): void;
  setTimeout(fn: () => unknown, ms: number): void;
  onUnload(fn: () => unknown): void;

  /** 所有已加载插件注册的命令（用于帮助菜单） */
  listCommands(): { plugin: string; names: string[]; desc: string; usage?: string }[];
}
