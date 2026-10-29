import { definePlugin } from '../../sdk.ts';

/** 入群欢迎 / 退群提示。模板变量：{at} {name} {qq} {group} */
export default definePlugin({
  name: 'welcome',
  displayName: '入群欢迎',
  version: '1.0.0',
  description: '新成员入群欢迎、成员退群提示（可按群配置）',
  defaultEnabled: false,
  config: {
    welcome: { type: 'text', default: '欢迎 {at} 加入本群！[face:鼓掌] 有问题可以随时问～', description: '欢迎语（{at} {name} {qq} {group}，支持内联标记）' },
    farewell: { type: 'text', default: '', description: '退群提示（留空不发送）' },
    groups: { type: 'list', default: [], description: '生效的群号（留空 = 所有允许的群）' },
    delaySec: { type: 'int', default: 3, description: '延迟发送秒数（等新人加载完）' },
  },
  setup(ctx) {
    const enabledIn = (g: string) => !ctx.config.groups.length || ctx.config.groups.includes(g);
    const render = async (tpl: string, groupId: string, userId: string) => {
      let name = userId;
      try { const info: any = await ctx.bridge.bot.call('get_stranger_info', { user_id: Number(userId) }); name = info?.nickname || userId; } catch { /* ignore */ }
      const group = ctx.bridge.groups.get(groupId)?.name ?? groupId;
      return tpl.replaceAll('{at}', `[at:${userId}]`).replaceAll('{name}', name).replaceAll('{qq}', userId).replaceAll('{group}', group);
    };
    ctx.onNotice('group_increase', async (ev) => {
      const g = String(ev.group_id); const u = String(ev.user_id);
      if (u === ctx.qq.selfId || !enabledIn(g) || !ctx.config.welcome) return;
      const text = await render(ctx.config.welcome, g, u);
      ctx.setTimeout(() => ctx.qq.send(`group:${g}`, text), ctx.config.delaySec * 1000);
    });
    ctx.onNotice('group_decrease', async (ev) => {
      const g = String(ev.group_id); const u = String(ev.user_id);
      if (u === ctx.qq.selfId || !enabledIn(g) || !ctx.config.farewell) return;
      await ctx.qq.send(`group:${g}`, await render(ctx.config.farewell, g, u));
    });
  },
});
