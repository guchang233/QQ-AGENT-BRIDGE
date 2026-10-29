import { definePlugin } from '../../src/plugins/api.ts';

export default definePlugin({
  setup(ctx) {
    const state = new Map<string, { content: string; users: Set<string>; done: boolean }>();
    ctx.onMessage(async (e) => {
      // 用渲染文本作为比较键（图片按引用比较），但发送时用原始消息段
      const key = e.rendered.trim();
      if (!key) return;
      const s = state.get(e.conv);
      if (!s || s.content !== key) { state.set(e.conv, { content: key, users: new Set([e.senderId]), done: false }); return; }
      s.users.add(e.senderId);
      if (!s.done && s.users.size >= (ctx.config.threshold ?? 3) && Math.random() < (ctx.config.probability ?? 1)) {
        s.done = true;
        await e.send(e.segments.filter((x) => x.type !== 'reply'));
      }
    }, { scope: 'group', priority: -20 });
  },
});
