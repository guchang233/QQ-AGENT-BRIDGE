/**
 * 示例用户插件 —— 复制这个目录即可开始写你自己的插件（或运行 `qab plugin new 名字`）。
 * 保存文件后会自动热重载。完整文档：docs/plugins.md
 */
import { definePlugin, z } from 'qq-agent-bridge';

export default definePlugin({
  name: 'hello',
  displayName: '示例插件',
  version: '1.0.0',
  description: '演示命令、正则、通知、配置、定时任务、Agent 工具与插件间服务调用',
  softDepends: ['memory'],
  config: {
    greeting: { type: 'string', default: '你好呀', description: '打招呼用语' },
    pokeBack: { type: 'bool', default: true, description: '被戳时戳回去' },
  },
  setup(ctx) {
    // 命令：/hello [名字]   （群里 @我 时可以不带前缀）
    ctx.command(['hello'], async (e) => {
      await e.reply(`${ctx.config.greeting}，${e.argText || e.senderName}！[face:微笑]`);
    }, { desc: '打个招呼', usage: '[名字]' });

    // 正则：roll 2d6
    ctx.onRegex(/^roll\s+(\d{1,2})d(\d{1,3})$/i, async (e) => {
      const [n, s] = [Number(e.match![1]), Number(e.match![2])];
      const rolls = Array.from({ length: Math.min(n, 20) }, () => 1 + Math.floor(Math.random() * s));
      await e.reply(`🎲 ${rolls.join(' + ')} = ${rolls.reduce((a, b) => a + b, 0)}`);
    });

    // 通知：被戳时戳回去（每人 60 秒冷却）
    const cd = new Map<string, number>();
    ctx.onNotice('poke', async (ev) => {
      if (!ctx.config.pokeBack || String(ev.target_id) !== ctx.qq.selfId) return;
      const who = String(ev.user_id);
      if (Date.now() - (cd.get(who) ?? 0) < 60_000) return;
      cd.set(who, Date.now());
      await ctx.qq.call('send_poke', ev.group_id ? { group_id: ev.group_id, user_id: ev.user_id } : { user_id: ev.user_id });
    });

    // Agent 工具：出现在 MCP 工具列表中，名为 hello_roll_dice
    ctx.tool({
      name: 'roll_dice',
      description: '掷一个 N 面骰子，返回点数',
      tier: 'read',
      input: { sides: z.number().int().min(2).max(1000).default(6) },
      handler: ({ sides }) => `掷出了 ${1 + Math.floor(Math.random() * sides)} 点（${sides} 面）`,
    });

    // 调用其它插件提供的服务（可选依赖）
    const memory = ctx.useOptional<{ remember: (x: { content: string; scope?: string }) => Promise<unknown> }>('memory');
    ctx.command('记个笔记', async (e) => {
      if (!memory) return e.reply('记忆插件未启用');
      await memory.remember({ content: e.argText, scope: e.conv });
      await e.reply('记下了');
    }, { desc: '用记忆插件记一条笔记（演示插件间调用）', usage: '<内容>' });
  },
});
