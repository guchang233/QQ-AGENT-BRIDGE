/**
 * 内置功能的内部接口。
 * 内置功能是程序本体的一部分，随版本一起改，可以直接使用内核对象（bridge、store、db）。
 * 第三方插件不要引用这里，请用公开 SDK（qq-agent-bridge），它跨版本保持稳定。
 */
export { definePlugin as defineFeature, definePlugin } from '../plugins/api.ts';
export type {
  PluginDefinition, PluginContext, PluginContext as FeatureContext, PluginMeta, MessageEvent, Handler, HandlerOptions, CommandOptions, PluginToolDef,
  ConfigSchema, ConfigField, ConfigOf, FieldType, RouteRequest, BridgeEventName,
} from '../plugins/api.ts';
export type { Segment, ConvRef } from '../message/segments.ts';
export { parseConv, convKey, plainText } from '../message/segments.ts';
export { oneLine } from '../bridge.ts';
export type { StoredMessage } from '../store/db.ts';
export type { ToolResult, ToolContent } from '../mcp/tools.ts';
export { z } from 'zod';
