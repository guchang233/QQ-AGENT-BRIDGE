/**
 * 插件 SDK 入口：插件中 `import { definePlugin, z } from 'qq-agent-bridge'`
 */
export { definePlugin } from './plugins/api.ts';
export type {
  PluginDefinition, PluginContext, PluginMeta, MessageEvent, Handler, HandlerOptions, CommandOptions, PluginToolDef,
  ConfigSchema, ConfigField, ConfigOf, FieldType, RouteRequest, BridgeEventName,
} from './plugins/api.ts';
export type { Segment, ConvRef } from './message/segments.ts';
export { parseConv, convKey, plainText } from './message/segments.ts';
export type { StoredMessage } from './store/db.ts';
export type { ToolResult, ToolContent } from './mcp/tools.ts';
export { z } from 'zod';
