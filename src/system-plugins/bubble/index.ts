import { definePlugin, parseConv, convKey } from '../../sdk.ts';

interface BubbleState { nextAt: number; until: number }

const rand = (a: number, b: number) => a + Math.random() * Math.max(0, b - a);
const pick = <T>(l: T[]) => l[Math.floor(Math.random() * l.length)];

/** 「0-8」「23-7」这样的时段，当前小时落在里面返回 true */
export function inHours(spec: string, h: number) {
  return spec.split(/[,，]/).some((part) => {
    const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(part);
    if (!m) return false;
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a <= b ? h >= a && h < b : h >= a || h < b;
  });
}

/**
 * 冒泡：在完全随机的时机出来说几句，过一会儿自动潜水。
 * 启用了仿真的会话由 AI 自己决定说什么（冒泡期间保持活跃，有人接话就聊）；
 * 没启用仿真的会话从预设语句里随机挑一句。
 */
export default definePlugin({
  name: 'bubble',
  displayName: '冒泡',
  version: '1.0.0',
  description: '随机时间出来冒个泡、活跃一会儿，然后自动潜水',
  defaultEnabled: false,
  softDepends: ['social'],
  config: {
    convs: { type: 'list', default: [], description: '冒泡的会话（group:群号）；留空 = 所有启用了仿真的群', group: '基本' },
    style: { type: 'select', options: ['auto', 'ai', 'template'], default: 'auto', description: 'auto：启用仿真的会话由 AI 说，否则用预设语句 / ai：只用 AI / template：只用预设语句', group: '基本' },
    minIntervalMinutes: { type: 'int', default: 120, min: 5, description: '两次冒泡最短间隔（分钟）', group: '时机' },
    maxIntervalMinutes: { type: 'int', default: 600, min: 5, description: '两次冒泡最长间隔（分钟），实际在两者间完全随机', group: '时机' },
    minStayMinutes: { type: 'int', default: 5, min: 1, description: '冒泡后最少活跃多久（分钟）', group: '时机' },
    maxStayMinutes: { type: 'int', default: 25, min: 1, description: '冒泡后最多活跃多久（分钟），到点自动潜水', group: '时机' },
    quietHours: { type: 'string', default: '0-8', description: '这些时段不冒泡（小时，如 0-8 或 23-7，多段用逗号）', group: '时机' },
    skipIfSpokeMinutes: { type: 'int', default: 30, description: '最近这么多分钟内说过话就不冒泡（本来就在线）', group: '时机' },
    farewell: { type: 'float', default: 0.3, min: 0, max: 1, description: '潜水时说一句再走的概率', group: '语句' },
    templates: { type: 'list', default: ['冒个泡', '潜水久了 出来透口气', '有人吗', '来了来了', '大家都在忙啥', '(探头)'], description: '预设冒泡语句（template 模式用）', group: '语句' },
    farewellTemplates: { type: 'list', default: ['潜了', '先溜了', '继续潜水去了'], description: '预设潜水语句', group: '语句' },
  },
  setup(ctx) {
    const c = new Proxy({} as typeof ctx.config, { get: (_t, k) => (ctx.config as any)[k] });
    const bridge = ctx.bridge;
    const social = () => ctx.useOptional<any>('social');
    const socialOn = (conv: string) => !!social()?.enabled?.().includes(conv);
    const useAi = (conv: string) => c.style === 'ai' || (c.style === 'auto' && socialOn(conv));

    const targets = (): string[] => {
      const list = c.convs.length ? c.convs : (social()?.enabled?.() ?? []).filter((x: string) => x.startsWith('group:'));
      return [...new Set(list.flatMap((x: string) => { try { return [convKey(parseConv(x))]; } catch { return []; } }))] as string[];
    };
    const nextDelay = () => rand(c.minIntervalMinutes, Math.max(c.minIntervalMinutes, c.maxIntervalMinutes)) * 60_000;
    const stayMs = () => rand(c.minStayMinutes, Math.max(c.minStayMinutes, c.maxStayMinutes)) * 60_000;

    const states = new Map<string, BubbleState>();
    const stateOf = (conv: string) => {
      let s = states.get(conv);
      if (!s) {
        s = ctx.kv.get<BubbleState | undefined>(`state:${conv}`, undefined) ?? { nextAt: Date.now() + nextDelay(), until: 0 };
        states.set(conv, s);
      }
      return s;
    };
    const save = (conv: string) => ctx.kv.set(`state:${conv}`, stateOf(conv));
    const lastSelfSend = (conv: string) => Number((ctx.db.prepare('SELECT MAX(ts) t FROM messages WHERE conv = ? AND is_self = 1').get(conv) as any)?.t ?? 0);

    /** 出来冒泡 */
    async function surface(conv: string, by = 'random') {
      const s = stateOf(conv);
      const stay = stayMs();
      s.until = Date.now() + stay;
      s.nextAt = s.until + nextDelay();
      save(conv);
      const mins = Math.round(stay / 60_000);
      if (useAi(conv)) {
        if (!socialOn(conv)) throw new Error('该会话没有启用仿真，AI 冒泡不了（可改用 template 模式）');
        const sv = social()!;
        sv.setMode(conv, 'active', { holdUntil: s.until });
        sv.addNote(conv, `你潜水有一阵了，现在随手打开群出来冒个泡：看看最近在聊什么，接个话或者随便说一两句（自然点，别说"我来冒泡了"这种话，也别解释自己为什么出现）。接下来约 ${mins} 分钟你保持活跃，有人理你就聊；到点系统会自动让你潜水。`, 'bubble');
      } else {
        await ctx.qq.send(conv, pick(c.templates.length ? c.templates : ['冒个泡']));
      }
      bridge.activity({ kind: 'info', conv, actor: by === 'random' ? '冒泡' : by, title: '冒泡', detail: `${useAi(conv) ? 'AI' : '预设语句'}，约 ${mins} 分钟后潜水` });
      ctx.logger.info(`${conv} 冒泡，约 ${mins} 分钟后潜水`);
    }

    /** 回去潜水 */
    async function dive(conv: string, by = 'random') {
      const s = stateOf(conv);
      s.until = 0;
      save(conv);
      const bye = Math.random() < c.farewell;
      if (useAi(conv) && socialOn(conv)) {
        const sv = social()!;
        const st = sv.stateOf(conv);
        if (st.mode === 'sleeping') { sv.setMode(conv, 'sleeping', { sleepMinutes: Math.max(1, (st.sleepUntil - Date.now()) / 60_000) }); return; }
        sv.setMode(conv, 'diving');
        if (bye) sv.addNote(conv, '冒泡时间到了，你准备回去潜水。正在聊的话可以简单收个尾或说一声再走（也可以什么都不说），然后用 qq_set_wake 选 diving。', 'bubbleEnd');
      } else if (bye && c.farewellTemplates.length) {
        await ctx.qq.send(conv, pick(c.farewellTemplates)).catch((e) => ctx.logger.warn(`潜水语句发送失败：${e.message}`));
      }
      bridge.activity({ kind: 'info', conv, actor: by === 'random' ? '冒泡' : by, title: '潜水', detail: bye ? '说了一声再走' : '' });
    }

    ctx.setInterval(async () => {
      const now = Date.now();
      for (const conv of targets()) {
        const s = stateOf(conv);
        try {
          if (s.until) { if (s.until <= now) await dive(conv); continue; }
          if (s.nextAt > now) continue;
          // 不合适的时机：顺延一段随机时间再看
          const busy = now - lastSelfSend(conv) < c.skipIfSpokeMinutes * 60_000;
          const quiet = inHours(c.quietHours, new Date(now).getHours());
          const sleeping = socialOn(conv) && social()!.stateOf(conv).mode === 'sleeping';
          const noDriver = useAi(conv) && !socialOn(conv);
          if (busy || quiet || sleeping || noDriver) { s.nextAt = now + rand(20, 90) * 60_000; save(conv); continue; }
          await surface(conv);
        } catch (e: any) {
          ctx.logger.warn(`${conv} 冒泡失败：${e.message}`);
          s.nextAt = now + nextDelay(); s.until = 0; save(conv);
        }
      }
    }, 30_000);

    const resolveConv = (arg: string | undefined, here: string) => (arg ? convKey(parseConv(/^\d+$/.test(arg) ? `group:${arg}` : arg)) : here);

    ctx.command(['冒泡'], async (e) => {
      const conv = resolveConv(e.args[0], e.conv);
      await surface(conv, e.senderId);
      if (conv !== e.conv) await e.reply(`已让 ${bridge.convName(conv) || conv} 冒泡`);
    }, { desc: '立刻在本会话（或指定群号）冒个泡', usage: '[群号]', ownerOnly: true });

    ctx.command(['潜水'], async (e) => {
      const conv = resolveConv(e.args[0], e.conv);
      await dive(conv, e.senderId);
      if (conv !== e.conv) await e.reply(`${bridge.convName(conv) || conv} 已潜水`);
    }, { desc: '结束冒泡，回去潜水', usage: '[群号]', ownerOnly: true });

    // 控制台
    ctx.route('GET', 'status', () => targets().map((conv) => {
      const s = stateOf(conv);
      return { conv, name: bridge.convName(conv), ai: useAi(conv), bubbling: s.until > Date.now(), until: s.until || null, nextAt: s.nextAt };
    }));
    ctx.route('POST', 'surface/:conv', async ({ params }) => { await surface(convKey(parseConv(params.conv)), 'console'); return { ok: true }; });
    ctx.route('POST', 'dive/:conv', async ({ params }) => { await dive(convKey(parseConv(params.conv)), 'console'); return { ok: true }; });
    ctx.provide({ surface, dive, status: () => targets().map((conv) => ({ conv, ...stateOf(conv) })) });
  },
});
