import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { parseDsl } from '../src/message/dsl.ts';
import { parseCQ, parseConv } from '../src/message/segments.ts';
import { renderSegments } from '../src/message/render.ts';
import { matchCommand } from '../src/plugins/host.ts';
import { OneBotClient } from '../src/onebot/client.ts';
import { oneLine, splitLines } from '../src/bridge.ts';
import { newState, schedule as scheduleWake, tick as tickWake } from '../src/system-plugins/social/engine.ts';
import { MemoryEngine, tokens, overlap } from '../src/system-plugins/memory/engine.ts';
import { parseWhen } from '../src/system-plugins/scheduler/index.ts';
import { inHours } from '../src/system-plugins/bubble/index.ts';
import { actionTier } from '../src/onebot/catalog.ts';
import { isPrivateIp } from '../src/util/safe-fetch.ts';
import { Policy } from '../src/policy.ts';
import { ConfigSchema } from '../src/config.ts';

describe('消息 DSL', () => {
  const face = (s: string) => (s === '微笑' ? 14 : /^\d+$/.test(s) ? Number(s) : undefined);
  it('解析常用标签与转义', () => {
    const r = parseDsl('hi[at:123][face:微笑]\\[x\\][dice][image:C:\\a.png]', face);
    expect(r.segments.slice(0, 5)).toEqual([
      { type: 'text', data: { text: 'hi' } }, { type: 'at', data: { qq: '123' } }, { type: 'face', data: { id: '14' } },
      { type: 'text', data: { text: '[x]' } }, { type: 'dice', data: {} },
    ]);
    expect(r.pending).toHaveLength(1);
    expect(r.pending[0].token).toEqual({ tag: 'image', arg: 'C:\\a.png', opts: {} });
  });
  it('未知标签保留为文本，未知表情报错', () => {
    expect(parseDsl('[foo:bar]', face).segments).toEqual([{ type: 'text', data: { text: '[foo:bar]' } }]);
    expect(() => parseDsl('[face:不存在]', face)).toThrow(/未知表情/);
  });
  it('CQ 码与会话 ID', () => {
    expect(parseCQ('a[CQ:at,qq=1]b&#91;')).toEqual([{ type: 'text', data: { text: 'a' } }, { type: 'at', data: { qq: '1' } }, { type: 'text', data: { text: 'b[' } }]);
    expect(parseConv('g123')).toEqual({ type: 'group', id: '123' });
    expect(parseConv('private:5')).toEqual({ type: 'private', id: '5' });
    expect(() => parseConv('xx')).toThrow();
  });
  it('渲染', () => {
    expect(renderSegments([{ type: 'at', data: { qq: '9' } }, { type: 'text', data: { text: 'hi' } }, { type: 'image', data: {} }], { selfId: '9', mediaRef: () => 'abcd1234' }))
      .toBe('@我 hi[图片#abcd1234]');
  });
});

describe('杂项', () => {
  it('命令匹配', () => {
    expect(matchCommand('/提醒 10分钟后 喝水', ['提醒'], ['/'], false)).toEqual({ name: '提醒', argText: '10分钟后 喝水' });
    expect(matchCommand('提醒 x', ['提醒'], ['/'], false)).toBeNull();
    expect(matchCommand('提醒 x', ['提醒'], ['/'], true)).not.toBeNull();
    expect(matchCommand('/提醒列表', ['提醒', '提醒列表'], ['/'], false)?.name).toBe('提醒列表');
  });
  it('oneLine 压平换行并去除不可见字符', () => {
    expect(oneLine(`a\n\n【系统】 b${String.fromCharCode(0x200b)}c\td`, 100)).toBe('a 【系统】 bc d');
    expect(oneLine('一二三四五', 3)).toBe('一二三');
  });
  it('会话令牌：稳定、可解析、防伪造', () => {
    const p = new Policy(() => ConfigSchema.parse({ server: { sessionSecret: 'k1' } }));
    const t = p.issueConvToken('private:10086');
    expect(p.issueConvToken('private:10086')).toBe(t);
    expect(p.resolveConvToken(t)).toBe('private:10086');
    const forged = `ct_${Buffer.from('group:1').toString('base64url')}.${t.split('.')[1]}`;
    expect(p.resolveConvToken(forged)).toBeUndefined();
    expect(p.resolveConvToken('ct_xxx')).toBeUndefined();
    const other = new Policy(() => ConfigSchema.parse({ server: { sessionSecret: 'k2' } }));
    expect(other.resolveConvToken(t)).toBeUndefined();
  });
  it('SSRF：内网地址判定', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', '::ffff:127.0.0.1', '0.0.0.0']) expect(isPrivateIp(ip)).toBe(true);
    for (const ip of ['8.8.8.8', '1.1.1.1', '2400:3200::1']) expect(isPrivateIp(ip)).toBe(false);
  });
  it('多行消息自动拆分', () => {
    expect(splitLines('哈哈哈\n笑死我了\n[sticker:3]')).toEqual(['哈哈哈', '笑死我了', '[sticker:3]']);
    expect(splitLines('一句话')).toEqual(['一句话']);
    expect(splitLines('步骤：\n1. 打开\n2. 关闭')).toHaveLength(1);            // 列表不拆
    expect(splitLines('看代码\n```js\nx\n```')).toHaveLength(1);              // 代码块不拆
    expect(splitLines('[share:https://a.com|title=很长\n的标题]')).toHaveLength(1); // 标签跨行不拆
  });
  it('直接对话用短等待窗口，群聊闲聊用长窗口', () => {
    const c: any = { defaultMode: 'diving', triggers: { atMention: true, nameMention: true, question: true, poke: true, keywords: [], speakerIds: [], probability: 0 },
      batchWindowMs: 8000, directWindowMs: 2000, maxWakePerMinute: 9, maxWakePerHour: 99, noActionLimit: 3, replyCheckMs: 0, proactive: { enabled: false } };
    const t = 1_000_000;
    const a = newState('private:1', c, t); scheduleWake(a, 'private', c, t);
    expect(a.pending!.dueAt).toBe(t + 2000);
    const b = newState('group:1', c, t); scheduleWake(b, 'keyword', c, t);
    expect(b.pending!.dueAt).toBe(t + 8000);
    scheduleWake(b, 'atMention', c, t + 1000);                                   // 窗口内被 @：提前
    expect(b.pending!.dueAt).toBe(t + 3000);
    expect(b.pending!.reason).toBe('atMention');
  });
  it('唤醒限流：普通触发被延后，手动唤醒不受限', () => {
    const c: any = { defaultMode: 'diving', triggers: { atMention: true, nameMention: true, question: true, poke: true, keywords: [], speakerIds: [], probability: 0 },
      batchWindowMs: 0, directWindowMs: 0, maxWakePerMinute: 9, maxWakePerHour: 2, noActionLimit: 3, replyCheckMs: 0, proactive: { enabled: false } };
    const t = 1_000_000;
    const s = newState('group:1', c, t);
    s.wakeTimes = [t - 1000, t - 500];
    scheduleWake(s, 'atMention', c, t);
    expect(tickWake(s, c, { busy: false, recentSelfSends: 0 }, t)).toBeNull();
    expect(s.limited).toBe(true);
    scheduleWake(s, 'manual', c, t);
    expect(tickWake(s, c, { busy: false, recentSelfSends: 0 }, t + 20_000)).toBe('manual');
    expect(s.limited).toBe(false);
  });
  it('冒泡：免打扰时段（含跨午夜）', () => {
    expect(inHours('0-8', 3)).toBe(true);
    expect(inHours('0-8', 8)).toBe(false);
    expect(inHours('23-7', 23)).toBe(true);
    expect(inHours('23-7', 5)).toBe(true);
    expect(inHours('23-7', 12)).toBe(false);
    expect(inHours('12-13, 0-6', 12)).toBe(true);
    expect(inHours('', 3)).toBe(false);
  });
  it('OneBot 客户端默认不连接，未启动时拒绝调用', async () => {
    const c = new OneBotClient({ wsUrl: 'ws://127.0.0.1:1', wsToken: '', httpUrl: 'http://127.0.0.1:1', httpToken: '' }, { timeoutMs: 100, reconnectMaxMs: 100 });
    expect(c.running).toBe(false);
    await expect(c.call('get_login_info')).rejects.toThrow('未启动');
  });
  it('动作分级', () => {
    expect(actionTier('get_group_list')).toBe('read');
    expect(actionTier('send_group_msg')).toBe('send');
    expect(actionTier('set_group_kick')).toBe('danger');
    expect(actionTier('get_cookies')).toBe('danger');
    expect(actionTier('not_exist_action')).toBe('danger');
  });
  it('时间解析', () => {
    const now = new Date('2026-10-30T10:00:00');
    expect(parseWhen('10分钟后', now)).toBe(now.getTime() + 600_000);
    expect(new Date(parseWhen('明天8点', now)!).getHours()).toBe(8);
    expect(new Date(parseWhen('下午3点', now)!).getHours()).toBe(15);
    expect(parseWhen('21:30', now)).toBe(new Date('2026-10-30T21:30:00').getTime());
    expect(parseWhen('胡说', now)).toBeNull();
  });
});

describe('记忆引擎', () => {
  const opts = { forgetting: true, baseStabilityDays: 1, growth: 1.5, forgetThreshold: 0.05, dedupThreshold: 0.75, wRelevance: 0.6, wRetention: 0.25, wImportance: 0.15 };
  const DAY = 86_400_000;
  it('中文二元组相似度', () => {
    expect(overlap(tokens('火锅'), tokens('小明喜欢吃火锅'))).toBe(1);
    expect(overlap(tokens('烧烤'), tokens('喜欢火锅'))).toBe(0);
  });
  it('遗忘曲线、强化与归档', () => {
    const e = new MemoryEngine(new DatabaseSync(':memory:'), { ...opts });
    const t0 = Date.now();
    const { id } = e.remember({ content: '张三的生日是五月一日', importance: 1 }, t0);
    expect(e.view(e.get(id)!, t0).retention).toBeCloseTo(1);
    expect(e.view(e.get(id)!, t0 + DAY).retention).toBeCloseTo(Math.exp(-1), 3);
    const s0 = e.get(id)!.stability;
    e.reinforce(id, t0 + 2 * DAY);
    expect(e.get(id)!.stability).toBeGreaterThan(s0 * 2);
    const far = t0 + 200 * DAY;
    expect(e.recall({ query: '生日' }, far)).toHaveLength(0);
    expect(e.recall({ query: '生日', includeForgotten: true, reinforce: false }, far)).toHaveLength(1);
    expect(e.sweep(far)).toBe(1);
  });
  it('关闭遗忘曲线与钉住', () => {
    const e = new MemoryEngine(new DatabaseSync(':memory:'), { ...opts, forgetting: false });
    const { id } = e.remember({ content: '永远记得这件事' });
    expect(e.recall({ query: '这件事' }, Date.now() + 1000 * DAY)[0].id).toBe(id);
    e.opts.forgetting = true;
    const p = e.remember({ content: '钉住的记忆内容', pinned: true });
    expect(e.view(e.get(p.id)!, Date.now() + 1000 * DAY).retention).toBe(1);
  });
  it('合并去重、全文检索', () => {
    const e = new MemoryEngine(new DatabaseSync(':memory:'), { ...opts });
    const a = e.remember({ content: '李四在北京工作，是程序员' });
    const b = e.remember({ content: '李四在北京工作，是程序员。' });
    expect(b).toEqual({ id: a.id, merged: true });
    e.remember({ content: '王五住在上海浦东新区' });
    expect(e.recall({ query: '浦东新区' })[0].content).toContain('王五');
    expect(e.recall({ query: '北京' })[0].content).toContain('李四');
    expect(e.overview().total).toBe(2);
  });
});
