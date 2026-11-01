import { EventEmitter } from 'node:events';
import type { AgentToken, Config, Tier } from './config.ts';
import { type ConvRef, parseConv } from './message/segments.ts';

function parseConvSafe(s: string): ConvRef | null { try { return parseConv(s); } catch { return null; } }
import { TIER_ORDER } from './onebot/catalog.ts';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { randomToken } from './util/fs.ts';

export class PolicyError extends Error {
  constructor(message: string, public code: 'forbidden' | 'rate_limited' | 'denied' | 'read_only' | 'approval_timeout' | 'rejected') {
    super(message);
  }
}

/** 调用方身份：MCP agent token、控制台（人类）、插件。 */
export interface Caller {
  kind: 'agent' | 'console' | 'plugin';
  name: string;
  token?: AgentToken;
}

export const CONSOLE_CALLER: Caller = { kind: 'console', name: 'console' };

export interface Approval {
  id: string;
  ts: number;
  caller: string;
  tool: string;
  tier: Tier;
  summary: string;
  params: unknown;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
}

class SlidingWindow {
  private hits: number[] = [];
  constructor(private windowMs: number) {}
  count(now = Date.now()) { this.hits = this.hits.filter((t) => now - t < this.windowMs); return this.hits.length; }
  add(now = Date.now()) { this.hits.push(now); }
}

export class Policy extends EventEmitter {
  private minute = new SlidingWindow(60_000);
  private hour = new SlidingWindow(3_600_000);
  private convMinute = new Map<string, SlidingWindow>();
  approvals = new Map<string, Approval & { resolve: (ok: boolean) => void }>();
  /**
   * 会话令牌（驱动签发，供 sessionBound token 使用）：ct_<会话 base64url>.<HMAC 签名>。
   * 无状态、跨重启稳定（DSH 会话上下文里的旧令牌在守护进程重启后依然有效），且无法伪造。
   */
  private sign(conv: string) { return createHmac('sha256', this.cfg().server.sessionSecret).update(`conv:${conv}`).digest('base64url').slice(0, 16); }
  issueConvToken(conv: string): string { return `ct_${Buffer.from(conv).toString('base64url')}.${this.sign(conv)}`; }
  resolveConvToken(t: string): string | undefined {
    const m = /^ct_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{16})$/.exec(String(t).trim());
    if (!m) return undefined;
    const conv = Buffer.from(m[1], 'base64url').toString();
    const a = Buffer.from(this.sign(conv)); const b = Buffer.from(m[2]);
    return a.length === b.length && timingSafeEqual(a, b) ? conv : undefined;
  }

  /** 把调用方收窄到单个会话（会话绑定 token 用）。 */
  narrow(caller: Caller, conv: ConvRef): Caller {
    if (!caller.token) return caller;
    return { ...caller, name: `${caller.name}@${conv.type}:${conv.id}`, token: { ...caller.token, groups: conv.type === 'group' ? [conv.id] : ['__none__'], private: conv.type === 'private' ? [conv.id] : ['__none__'] } };
  }

  constructor(public cfg: () => Config) { super(); }

  /** 会话绑定的调用方当前所在的会话。 */
  boundConv(caller: Caller): string | undefined {
    const t = caller.token;
    if (!t?.sessionBound) return undefined;
    if (t.groups[0] && t.groups[0] !== '__none__') return `group:${t.groups[0]}`;
    if (t.private[0] && t.private[0] !== '__none__') return `private:${t.private[0]}`;
    return undefined;
  }

  /** 会话是否在全局访问范围内（白/黑名单）。 */
  convAllowed(c: ConvRef): boolean {
    const a = this.cfg().access;
    const deny = c.type === 'group' ? a.denyGroups : a.denyPrivate;
    if (deny.includes(c.id)) return false;
    if (a.mode === 'all') return true;
    const allow = c.type === 'group' ? a.groups : a.private;
    if (c.type === 'private' && this.cfg().owners.includes(c.id)) return true;
    return allow.includes(c.id);
  }

  /** agent token 自身的会话范围限制。 */
  callerConvAllowed(caller: Caller, c: ConvRef): boolean {
    const t = caller.token;
    if (!t) return true;
    const list = c.type === 'group' ? t.groups : t.private;
    if (!t.groups.length && !t.private.length) return true;
    return list.includes(c.id);
  }

  /** 该调用方能否看到这个会话（读取类工具用来过滤结果）。 */
  visible(caller: Caller, conv: string | ConvRef): boolean {
    if (caller.kind === 'console') return true;
    const c = typeof conv === 'string' ? parseConvSafe(conv) : conv;
    return !!c && this.convAllowed(c) && this.callerConvAllowed(caller, c);
  }

  assertConv(caller: Caller, c: ConvRef) {
    if (caller.kind === 'console') return;
    if (!this.convAllowed(c)) throw new PolicyError(`会话 ${c.type}:${c.id} 不在允许范围（access 白/黑名单），操作未执行`, 'forbidden');
    if (!this.callerConvAllowed(caller, c)) throw new PolicyError(`当前 token「${caller.name}」无权操作 ${c.type}:${c.id}，操作未执行`, 'forbidden');
  }

  /**
   * 权限等级检查。返回前可能挂起等待控制台审批。
   * 人类控制台不受 tier/审批限制（只受只读开关限制 send 以上动作时给出提示）。
   */
  async authorize(caller: Caller, tool: string, tier: Tier, summary: string, params: unknown): Promise<void> {
    const cfg = this.cfg();
    if (cfg.access.readOnly && tier !== 'read' && caller.kind === 'agent') {
      throw new PolicyError('桥接处于只读模式，非读取类操作已被拒绝', 'read_only');
    }
    if (caller.kind !== 'agent') return;
    const t = caller.token!;
    if (!t.tiers.includes(tier)) {
      throw new PolicyError(`token「${t.name}」没有 ${tier} 级权限（拥有：${t.tiers.join(',')}），${tool} 未执行`, 'forbidden');
    }
    const mode = cfg.agents.policy[tier];
    if (mode === 'deny') throw new PolicyError(`${tier} 级操作已被策略禁止，${tool} 未执行`, 'denied');
    if (mode === 'approve') await this.requestApproval(caller, tool, tier, summary, params);
  }

  private requestApproval(caller: Caller, tool: string, tier: Tier, summary: string, params: unknown): Promise<void> {
    const id = randomToken(6);
    return new Promise<void>((resolve, reject) => {
      const timeoutMs = this.cfg().agents.approvalTimeoutMs;
      const timer = setTimeout(() => {
        const a = this.approvals.get(id);
        if (!a) return;
        a.status = 'expired';
        this.approvals.delete(id);
        this.emit('approval', this.publicApproval(a));
        reject(new PolicyError(`等待人工审批超时（${Math.round(timeoutMs / 1000)}s），${tool} 未执行`, 'approval_timeout'));
      }, timeoutMs);
      const entry = {
        id, ts: Date.now(), caller: caller.name, tool, tier, summary, params, status: 'pending' as const,
        resolve: (ok: boolean) => {
          clearTimeout(timer);
          this.approvals.delete(id);
          if (ok) resolve(); else reject(new PolicyError(`操作被控制台拒绝，${tool} 未执行`, 'rejected'));
        },
      };
      this.approvals.set(id, entry);
      this.emit('approval', this.publicApproval(entry));
    });
  }

  /** 向控制台发起审批并等待结果（不抛错，超时/拒绝返回 false）。 */
  async ask(callerName: string, tool: string, tier: Tier, summary: string, params: unknown): Promise<boolean> {
    try { await this.requestApproval({ kind: 'agent', name: callerName }, tool, tier, summary, params); return true; } catch { return false; }
  }

  decide(id: string, approve: boolean): boolean {
    const a = this.approvals.get(id);
    if (!a) return false;
    a.status = approve ? 'approved' : 'rejected';
    this.emit('approval', this.publicApproval(a));
    a.resolve(approve);
    return true;
  }

  pendingApprovals(): Approval[] { return [...this.approvals.values()].map((a) => this.publicApproval(a)); }

  private publicApproval(a: Approval): Approval {
    const { id, ts, caller, tool, tier, summary, params, status } = a;
    return { id, ts, caller, tool, tier, summary, params, status };
  }

  /** 发送限流（全局分钟/小时 + 单会话分钟）。人类控制台不计入。 */
  checkSendRate(caller: Caller, conv: string, n = 1) {
    if (caller.kind === 'console') return;
    const l = this.cfg().limits;
    const cm = this.convMinute.get(conv) ?? new SlidingWindow(60_000);
    this.convMinute.set(conv, cm);
    if (this.minute.count() + n > l.sendPerMinute) throw new PolicyError(`发送过于频繁：每分钟上限 ${l.sendPerMinute} 条，请稍后再发`, 'rate_limited');
    if (this.hour.count() + n > l.sendPerHour) throw new PolicyError(`发送过于频繁：每小时上限 ${l.sendPerHour} 条`, 'rate_limited');
    if (cm.count() + n > l.convPerMinute) throw new PolicyError(`该会话发送过于频繁：每分钟上限 ${l.convPerMinute} 条`, 'rate_limited');
  }

  recordSend(caller: Caller, conv: string) {
    if (caller.kind === 'console') return;
    this.minute.add(); this.hour.add();
    const cm = this.convMinute.get(conv) ?? new SlidingWindow(60_000);
    cm.add(); this.convMinute.set(conv, cm);
  }

  /** 模拟打字节奏的条间延迟。 */
  /** 拟人的条间间隔：按下一条的字数模拟打字时间，再加 ±25% 的随机抖动。 */
  gapFor(textLen: number): number {
    const l = this.cfg().limits;
    const base = Math.min(l.gapMaxMs, l.gapBaseMs + l.gapPerCharMs * textLen);
    return Math.round(base * (0.75 + Math.random() * 0.5));
  }

  tierAllowed(caller: Caller, tier: Tier): boolean {
    if (caller.kind !== 'agent') return true;
    return caller.token!.tiers.some((t) => TIER_ORDER[t] >= TIER_ORDER[tier]) && caller.token!.tiers.includes(tier);
  }

  findToken(token: string): AgentToken | undefined {
    return this.cfg().agents.tokens.find((t) => t.enabled && t.token === token);
  }
}
