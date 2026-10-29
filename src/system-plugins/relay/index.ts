import { definePlugin, parseConv, convKey } from '../../sdk.ts';

/** 消息互通：把一个会话的消息转发到另一个会话（单向或双向）。 */
export default definePlugin({
  name: 'relay',
  displayName: '消息互通',
  version: '1.0.0',
  description: '在群与群（或群与私聊）之间转发消息',
  defaultEnabled: false,
  config: {
    routes: { type: 'list', default: [], description: '规则，每行一条：来源=>目标，双向用 <=>。例：group:111=>group:222　group:111<=>group:333' },
    format: { type: 'string', default: '[{from}] {name}：', description: '前缀模板：{from} 来源会话名 {name} 发送者' },
    includeMedia: { type: 'bool', default: true, description: '转发图片等媒体（否则仅文本）' },
  },
  setup(ctx) {
    const routes = new Map<string, string[]>();
    for (const line of ctx.config.routes) {
      const m = /^\s*(\S+)\s*(<=>|=>)\s*(\S+)\s*$/.exec(line);
      if (!m) { ctx.logger.warn(`无效规则：${line}`); continue; }
      const a = convKey(parseConv(m[1])); const b = convKey(parseConv(m[3]));
      routes.set(a, [...(routes.get(a) ?? []), b]);
      if (m[2] === '<=>') routes.set(b, [...(routes.get(b) ?? []), a]);
    }
    ctx.onMessage(async (e) => {
      const targets = routes.get(e.conv);
      if (!targets?.length) return;
      const prefix = ctx.config.format.replaceAll('{from}', ctx.bridge.convName(e.conv) || e.conv).replaceAll('{name}', e.senderName);
      const segs = e.segments.filter((s) => s.type !== 'reply' && (ctx.config.includeMedia || s.type === 'text' || s.type === 'face' || s.type === 'at'))
        .map((s) => (s.type === 'at' ? { type: 'text', data: { text: `@${ctx.qq.nameOf(e.conv, String(s.data.qq)) ?? s.data.qq} ` } } : s));
      if (!segs.length) return;
      for (const t of targets) await ctx.qq.send(t, [{ type: 'text', data: { text: prefix } }, ...segs]).catch((err) => ctx.logger.warn(`转发到 ${t} 失败：${err.message}`));
    }, { priority: -50 });
  },
});
