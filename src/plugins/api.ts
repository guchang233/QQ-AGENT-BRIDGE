import type { z } from 'zod';
import type { Segment, ConvRef } from '../message/segments.ts';
import type { Logger } from '../util/log.ts';
import type { Tier } from '../config.ts';
import type { Bridge, SendOptions } from '../bridge.ts';
import type { ToolResult } from '../mcp/tools.ts';

export interface PluginManifest {
  name: string;
  displayName?: string;
  version?: string;
  description?: string;
  author?: string;
  main?: string;
}

export interface MessageEvent {
  conv: string;
  convRef: ConvRef;
  msgId: string;
  senderId: string;
  senderName: string;
  isGroup: boolean;
  groupId?: string;
  /** 纯文本（去掉 @我 与命令前缀前的原文） */
  text: string;
  /** 可读渲染（含 [图片#ref] 等） */
  rendered: string;
  segments: Segment[];
  mentioned: boolean;
  isOwner: boolean;
  ts: number;
  /** 命令处理器：命令后面的参数（按空白切分）与原始参数串 */
  args: string[];
  argText: string;
  /** 正则处理器：匹配结果 */
  match?: RegExpMatchArray;
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
  /** 越大越先执行 */
  priority?: number;
  /** group / private / all */
  scope?: 'group' | 'private' | 'all';
  /** 仅主人可触发 */
  ownerOnly?: boolean;
  /** 群聊中仅被 @ 时触发 */
  requireMention?: boolean;
  desc?: string;
}

export interface CommandOptions extends HandlerOptions { aliases?: string[] }

export interface PluginToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title?: string;
  description: string;
  tier?: Tier;
  input: S;
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<string | ToolResult | object> | string | ToolResult | object;
}

export interface PluginContext {
  readonly name: string;
  readonly logger: Logger;
  readonly dataDir: string;
  /** 合并默认值后的插件配置（来自 config.schema.json 默认值 + data/plugins/<name>/config.json） */
  config: Record<string, any>;
  saveConfig(): void;
  kv: { get<T = unknown>(key: string): T | undefined; set(key: string, value: unknown): void };
  qq: {
    send(conv: string, content: string | Segment[], opts?: SendOptions): Promise<string[]>;
    call<T = any>(action: string, params?: Record<string, unknown>): Promise<T>;
    readonly selfId: string | undefined;
  };
  /** 底层桥接对象（逃生舱，慎用） */
  readonly bridge: Bridge;
  command(name: string | string[], handler: Handler, opts?: CommandOptions): void;
  onRegex(re: RegExp, handler: Handler, opts?: HandlerOptions): void;
  onMessage(handler: Handler, opts?: HandlerOptions): void;
  onNotice(type: string | '*', handler: (ev: any) => unknown): void;
  onRequest(handler: (req: any) => unknown): void;
  tool<S extends z.ZodRawShape>(def: PluginToolDef<S>): void;
  /** cron 表达式（秒可选），如 '0 8 * * *' 每天 8 点 */
  schedule(cron: string, fn: () => unknown): void;
  onUnload(fn: () => unknown): void;
  /** 所有已加载插件注册的命令（用于帮助菜单） */
  listCommands(): { plugin: string; names: string[]; desc: string }[];
}

export interface PluginModule {
  setup(ctx: PluginContext): void | Promise<void>;
}

export function definePlugin(p: PluginModule): PluginModule { return p; }
