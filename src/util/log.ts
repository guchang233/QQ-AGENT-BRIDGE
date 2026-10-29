import { EventEmitter } from 'node:events';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface LogEntry { ts: number; level: LogLevel; scope: string; msg: string }

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const RING_MAX = 1000;

class LogHub extends EventEmitter {
  level: LogLevel = (process.env.QAB_LOG_LEVEL as LogLevel) || 'info';
  ring: LogEntry[] = [];
  /** 在 MCP stdio 模式下 stdout 被协议占用，日志必须走 stderr。 */
  stream: NodeJS.WriteStream = process.stdout;

  write(level: LogLevel, scope: string, args: unknown[]) {
    const msg = args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : safeJson(a))).join(' ');
    const entry: LogEntry = { ts: Date.now(), level, scope, msg };
    this.ring.push(entry);
    if (this.ring.length > RING_MAX) this.ring.splice(0, this.ring.length - RING_MAX);
    this.emit('log', entry);
    if (ORDER[level] < ORDER[this.level]) return;
    const t = new Date(entry.ts).toLocaleTimeString('zh-CN', { hour12: false });
    this.stream.write(`${t} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}\n`);
  }
}

export const logHub = new LogHub();

function safeJson(v: unknown) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

export function createLogger(scope: string) {
  return {
    debug: (...a: unknown[]) => logHub.write('debug', scope, a),
    info: (...a: unknown[]) => logHub.write('info', scope, a),
    warn: (...a: unknown[]) => logHub.write('warn', scope, a),
    error: (...a: unknown[]) => logHub.write('error', scope, a),
  };
}
export type Logger = ReturnType<typeof createLogger>;
