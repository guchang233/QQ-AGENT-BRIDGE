import type { EventEmitter } from 'node:events';

/**
 * Agent 驱动：把"唤醒"变成一轮 AI 运行的执行器（DSH、将来的 WorkBuddy / 内置 API 等）。
 * 仿真引擎只依赖这个接口，不关心背后是谁。
 *
 * 事件：
 *  'turn-start' (conv)
 *  'turn-end'   (conv, TurnResult)
 *  'state'      (DriverStatus)
 */
export interface WakeRequest {
  conv: string;
  /** 唤醒原因（private / atMention / timeout …），用于日志与统计 */
  reason: string;
  /** 完整提示词（由仿真引擎构建） */
  prompt: string;
  /** 附带图片（base64），可选 */
  images?: { mediaType: string; data: string; name?: string }[];
}

export interface TurnResult {
  reason: 'completed' | 'error' | 'aborted' | 'timeout';
  error?: string;
  /** 模型输出的纯文本（工具模式下只是"想法"，不会发到 QQ） */
  text: string;
  /** 本轮调用过的工具名（已去掉 mcp__xx__ 前缀） */
  tools: string[];
  durationMs: number;
}

export interface DriverStatus {
  id: string;
  kind: string;
  label: string;
  state: 'disabled' | 'connecting' | 'ready' | 'error';
  detail: string;
  /** 正在运行回合的会话 */
  busy: string[];
  sessions: number;
}

export interface AgentDriver extends EventEmitter {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): DriverStatus;
  isBusy(conv: string): boolean;
  /** 提交一轮运行；返回时只代表"已提交"，结果通过 'turn-end' 事件给出 */
  wake(req: WakeRequest): Promise<void>;
  /** 丢弃某会话的 AI 会话（重置上下文） */
  reset(conv: string): Promise<void>;
  /** 中止某会话当前回合 */
  cancel(conv: string): Promise<void>;
}
