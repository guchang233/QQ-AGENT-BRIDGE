import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig, resolveFromRoot } from '../config.ts';

const TEMPLATES: Record<string, (name: string) => string> = {
  basic: (name) => `import { definePlugin } from 'qq-agent-bridge';

export default definePlugin({
  name: '${name}',
  displayName: '${name}',
  version: '0.1.0',
  description: '一句话说明这个插件做什么',
  config: {
    enabled_groups: { type: 'list', default: [], description: '生效的群号（留空 = 全部）' },
  },
  setup(ctx) {
    ctx.onMessage(async (e) => {
      if (ctx.config.enabled_groups.length && !ctx.config.enabled_groups.includes(e.groupId ?? '')) return;
      if (e.text === 'ping') await e.reply('pong');
    });
    ctx.logger.info('${name} 已加载');
  },
});
`,
  command: (name) => `import { definePlugin } from 'qq-agent-bridge';

export default definePlugin({
  name: '${name}',
  displayName: '${name}',
  version: '0.1.0',
  description: '命令型插件示例',
  config: {
    cooldownSec: { type: 'int', default: 5, description: '每人冷却秒数' },
  },
  setup(ctx) {
    const last = new Map<string, number>();
    ctx.command(['${name}'], async (e) => {
      if (Date.now() - (last.get(e.senderId) ?? 0) < ctx.config.cooldownSec * 1000) return e.reply('太快啦，稍后再试');
      last.set(e.senderId, Date.now());
      await e.reply(\`收到参数：\${e.args.join(' | ') || '（无）'}\`);
    }, { desc: '示例命令', usage: '[参数...]' });
  },
});
`,
  'agent-tool': (name) => `import { definePlugin, z } from 'qq-agent-bridge';

export default definePlugin({
  name: '${name}',
  displayName: '${name}',
  version: '0.1.0',
  description: '给 Agent 提供新工具的插件',
  setup(ctx) {
    ctx.tool({
      name: 'lookup',                      // 实际工具名：${name}_lookup
      description: '说明清楚：做什么、什么时候用、返回什么',
      tier: 'read',                        // read / send / manage / danger
      readOnly: true,
      input: { keyword: z.string().describe('要查询的关键词') },
      handler: async ({ keyword }) => \`关于「\${keyword}」的结果……\`,
    });
  },
});
`,
  service: (name) => `import { definePlugin } from 'qq-agent-bridge';

/** 依赖记忆插件并对外提供服务的示例。其它插件：ctx.use('${name}') */
export default definePlugin({
  name: '${name}',
  displayName: '${name}',
  version: '0.1.0',
  description: '服务型插件示例',
  depends: ['memory'],
  setup(ctx) {
    const memory = ctx.use<{ recall: (q: { query: string; limit?: number }) => Promise<{ content: string }[]> }>('memory');
    ctx.provide({
      async summarize(topic: string) {
        const list = await memory.recall({ query: topic, limit: 5 });
        return list.map((m) => m.content).join('；');
      },
    });
    ctx.route('GET', 'summary', async ({ query }) => ({ text: await (ctx.use('${name}') as any).summarize(query.topic ?? '') }));
  },
});
`,
};

export function scaffoldPlugin(name: string, template = 'basic'): string {
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(name)) throw new Error('插件名只能包含小写字母、数字和短横线，且以字母开头');
  const tpl = TEMPLATES[template];
  if (!tpl) throw new Error(`未知模板 ${template}，可选：${Object.keys(TEMPLATES).join(', ')}`);
  const { config } = loadConfig();
  const dir = path.join(resolveFromRoot(config.plugins.dir), name);
  if (fs.existsSync(dir)) throw new Error(`目录已存在：${dir}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.ts'), tpl(name));
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n\n说明这个插件的用途、命令、配置项和 Agent 工具。\n`);
  return dir;
}

/** 从 git 仓库安装插件到 plugins/（或 astrbot_plugins/）。安装依赖时只装生产依赖且忽略脚本。 */
export async function installPlugin(repo: string, opts: { astrbot?: boolean } = {}): Promise<string> {
  if (!/^(https:\/\/|git@)[\w.@:/~-]+$/.test(repo)) throw new Error('只支持 https:// 或 git@ 开头的 git 仓库地址');
  const { config } = loadConfig();
  const base = resolveFromRoot(opts.astrbot ? config.plugins.astrbot.dir : config.plugins.dir);
  fs.mkdirSync(base, { recursive: true });
  const name = repo.replace(/\.git$/, '').split(/[/:]/).pop()!.replace(/^(qab-plugin-|astrbot_plugin_)/, '');
  const dir = path.join(base, name);
  if (fs.existsSync(dir)) throw new Error(`已存在：${dir}（如需更新请在该目录执行 git pull）`);
  execFileSync('git', ['clone', '--depth', '1', repo, dir], { stdio: 'inherit' });
  if (!opts.astrbot && fs.existsSync(path.join(dir, 'package.json'))) {
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--ignore-scripts'], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
  }
  if (opts.astrbot && fs.existsSync(path.join(dir, 'requirements.txt'))) {
    console.log(`提示：该 AstrBot 插件有 Python 依赖，请确认后手动安装：pip install -r "${path.join(dir, 'requirements.txt')}"`);
  }
  return dir;
}
