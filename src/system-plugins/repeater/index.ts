import { definePlugin } from '../../sdk.ts';

/** 复读机：群里连续多人发同一句话时跟着复读一次。 */
export default definePlugin({
  name: 'repeater',
  displayName: '复读机',
  version: '1.0.0',
  description: '群里连续多人发同一句话时跟着复读一次',
  defaultEnabled: false,
  config: {
    threshold: { type: 'int', default: 3, description: '连续多少人发送相同内容后复读' },
    probability: { type: 'float', default: 1, description: '达到阈值后复读的概率 0~1' },
  },
  setup(ctx) {
    const state = new Map<string, { content: string; users: Set<string>; done: boolean }>();
    ctx.onMessage(async (e) => {
      const key = e.rendered.trim();
      if (!key) return;
      const s = state.get(e.conv);
      if (!s || s.content !== key) { state.set(e.conv, { content: key, users: new Set([e.senderId]), done: false }); return; }
      s.users.add(e.senderId);
      if (!s.done && s.users.size >= ctx.config.threshold && Math.random() < ctx.config.probability) {
        s.done = true;
        await e.send(e.segments.filter((x) => x.type !== 'reply'));
      }
    }, { scope: 'group', priority: -20 });
  },
});
