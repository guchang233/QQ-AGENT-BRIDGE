import fs from 'node:fs';
import path from 'node:path';
import { definePlugin, z, type ToolContent } from '../../sdk.ts';
import type { Caller } from '../../policy.ts';
import { AceError, resolveCliPath, spawnCli, type Runner } from './cli.ts';
import { loadCatalog } from './help.ts';
import { assertLength, assertTempo, materialize, parseScoreString, placeholderFor, type RawNote } from './score.ts';
import { callChecked, guardArgv, listSingers, readDocs, synthesize } from './sing.ts';

/**
 * 虚拟歌姬：让 Agent 把歌词和音符交给本机已登录的 ACE Studio，合成一段清唱干声再交回来。
 * 只调用安装目录里的官方 acestudio-cli（命令以 `help` 为准）。不打包声库，不读取账号令牌。
 */
export default definePlugin({
  name: 'ace-vocal',
  displayName: '虚拟歌姬',
  version: '1.0.0',
  description: '用本机已登录的 ACE Studio，把歌词和音符合成虚拟歌手的清唱，并把音频交回给 AI',
  defaultEnabled: false,
  config: {
    cliPath: { type: 'string', default: '', description: 'acestudio-cli 的完整路径。留空则自动查找安装目录', group: '连接' },
    defaultSinger: { type: 'string', default: '', description: '默认歌手名，须是这个账号音色库里已有的名字。留空则用列表里的第一位', group: '合成' },
    language: { type: 'select', options: ['zh', 'en', 'ja', 'ko', 'es', 'yue'], default: 'zh', description: '默认演唱语言', group: '合成' },
    bpm: { type: 'int', default: 90, min: 40, max: 220, description: '默认速度', group: '合成' },
    allowCurrentProject: { type: 'bool', default: false, description: 'CLI 不能新建工程时，允许把音符写进当前已打开的工程', group: '合成' },
    effects: { type: 'select', options: ['off', 'on'], default: 'off', description: '导出时是否保留人声效果。清唱干声保持关闭', group: '合成' },
    format: { type: 'select', options: ['wav', 'mp3'], default: 'wav', description: '导出格式', group: '合成' },
    timeoutSec: { type: 'int', default: 180, min: 15, max: 600, description: '单次 CLI 最长等待秒数（含云端渲染）', group: '合成' },
    maxNotes: { type: 'int', default: 256, min: 1, max: 2000, description: '一次最多多少个音符', group: '合成' },
    perHour: { type: 'int', default: 12, min: 1, max: 60, description: '每小时最多合成或直接调用 CLI 几次', group: '合成' },
    embedAudio: { type: 'bool', default: true, description: '把音频附在工具结果里返回给 AI（太大时只给路径）', group: '返回' },
    maxEmbedKb: { type: 'int', default: 2048, min: 64, max: 8192, description: '内联返回给 AI 的音频上限（KB）', group: '返回' },
    maxSendKb: { type: 'int', default: 8192, min: 128, max: 20480, description: '发到 QQ 的语音上限（KB）', group: '返回' },
  },
  setup(ctx) {
    const hits: number[] = [];
    let chain: Promise<unknown> = Promise.resolve();
    const lock = <T>(fn: () => Promise<T>): Promise<T> => {
      const run = chain.then(fn, fn);
      chain = run.then(() => undefined, () => undefined);
      return run;
    };
    const limit = () => {
      const now = Date.now();
      while (hits.length && now - hits[0] > 3_600_000) hits.shift();
      if (hits.length >= ctx.config.perHour) throw new AceError('RATE', `合成太频繁（每小时上限 ${ctx.config.perHour} 次）。ACE Studio 的云端渲染会计入你的账号额度`);
      hits.push(now);
    };
    const renders = path.join(ctx.dataDir, 'renders');
    fs.mkdirSync(renders, { recursive: true });

    function open(): { bin: string; run: Runner } {
      const bin = resolveCliPath(ctx.config.cliPath);
      const timeoutMs = ctx.config.timeoutSec * 1000;
      return { bin, run: (args, opts) => spawnCli(bin, args, { stdin: opts?.stdin, timeoutMs: opts?.timeoutMs ?? timeoutMs }) };
    }

    function takeNotes(notes: string | undefined, score: RawNote[] | undefined, lyrics: string | undefined, language: string) {
      const raw = score?.length ? score : parseScoreString(notes ?? '');
      return materialize(raw, lyrics, language, ctx.config.maxNotes);
    }

    async function sing(input: { singer?: string; language?: string; bpm?: number; title?: string; notes?: string; score?: RawNote[]; lyrics?: string }) {
      const language = (input.language || ctx.config.language || 'zh').trim();
      if (!/^[a-z]{2,8}$/.test(language)) throw new AceError('BAD_SCORE', '演唱语言要用 zh、en、ja 这样的代码');
      const bpm = input.bpm ?? ctx.config.bpm;
      assertTempo(bpm);
      const sung = takeNotes(input.notes, input.score, input.lyrics, language);
      assertLength(sung, bpm);
      const session = open();
      limit();
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const ext = ctx.config.format === 'mp3' ? 'mp3' : 'wav';
      const outFile = path.join(renders, `vocal-${id}.${ext}`);
      const notesFile = path.join(renders, `notes-${id}.json`);
      const { run } = session;
      return synthesize(run, {
        singer: input.singer?.trim() || ctx.config.defaultSinger.trim() || undefined,
        language, bpm, notes: sung,
        title: input.title?.trim() || 'QAB Vocal',
        outFile, outRoot: renders, notesFile,
        effects: ctx.config.effects === 'on' ? 'on' : 'off',
        format: ext,
        allowCurrentProject: ctx.config.allowCurrentProject,
        timeoutMs: ctx.config.timeoutSec * 1000,
      });
    }

    function pack(file: string, meta: { singer: string; language: string; bpm: number; lyric: string }, sent?: string[]) {
      const buf = fs.readFileSync(file);
      const lines = [
        '清唱已合成（干声，没有伴奏）。',
        `歌手：${meta.singer}`,
        `语言：${meta.language}　速度：${meta.bpm}`,
        `歌词：${meta.lyric}`,
        `文件：${file}`,
      ];
      if (sent?.length) lines.push(`已作为语音发到会话，消息 ID：${sent.join(', ')}`);
      else lines.push('还没有发到 QQ。要给对方听，请重新调用并带上 conv，不要把文件路径贴进聊天。');
      const content: ToolContent[] = [{ type: 'text', text: lines.join('\n') }];
      const mime = file.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav';
      if (ctx.config.embedAudio && buf.length <= ctx.config.maxEmbedKb * 1024) content.push({ type: 'audio', data: buf.toString('base64'), mimeType: mime });
      else if (ctx.config.embedAudio) content.push({ type: 'text', text: '音频较大，没有内联进这条结果。' });
      return { content };
    }

    async function sendVoice(caller: Caller, conv: string, file: string) {
      const buf = fs.readFileSync(file);
      if (buf.length > ctx.config.maxSendKb * 1024) throw new AceError('OUTPUT', `音频超过 ${ctx.config.maxSendKb} KB，没有发到 QQ。文件留在插件目录`);
      const r = await ctx.bridge.send(caller, conv, [{ type: 'record', data: { file: `base64://${buf.toString('base64')}` } }]);
      return r.messageIds;
    }

    ctx.command(['清唱'], async (e) => {
      if (!e.argText) return e.reply('用法：/清唱 C4:1:你 D4:1:好 E4:2:-');
      try {
        const result = await lock(() => sing({ notes: e.argText }));
        const ids = await sendVoice({ kind: 'plugin', name: 'plugin:ace-vocal' }, e.conv, result.file);
        await e.reply(ids.length ? '清唱好了。' : '合成好了，但没有发出去。');
      } catch (err: any) {
        await e.reply(String(err?.message ?? err).slice(0, 300));
      }
    }, { desc: '用 ACE Studio 把简谱串唱成清唱（仅管理员）', usage: '<音高:拍:歌词 …>', ownerOnly: true });

    ctx.tool({
      name: 'qq_ace_status', title: '歌姬合成状态', tier: 'read', readOnly: true,
      description: '查看本机 ACE Studio 官方 CLI 是否可用、帮助里有哪些命令。需要软件已安装；账号是否登录要看 qq_ace_voices。不会读取登录令牌。',
      input: {},
      handler: async () => lock(async () => {
        const { bin, run } = open();
        const catalog = await loadCatalog(run, Math.min(ctx.config.timeoutSec * 1000, 20_000));
        return { cli: bin, commands: catalog.commands.map((c) => ({ command: c.path.join(' '), summary: c.summary })) };
      }),
    });

    ctx.tool({
      name: 'qq_ace_voices', title: '虚拟歌手列表', tier: 'read', readOnly: true,
      description: '列出当前已登录的 ACE Studio 账号可以使用的虚拟歌手。未登录会直接说明，不会尝试登录。',
      input: {},
      handler: async () => {
        const names = await lock(() => listSingers(open().run, ctx.config.timeoutSec * 1000));
        return names.join('\n');
      },
    });

    ctx.tool({
      name: 'qq_ace_docs', title: 'ACE Studio 命令说明', tier: 'read', readOnly: true,
      description: '读取本机 acestudio-cli 的帮助。topic 为空时返回命令一览；否则是帮助里的命令路径，例如 export audio。',
      input: { topic: z.string().default('').describe('命令路径，空格分隔；留空看总览') },
      handler: async ({ topic }) => {
        const parts = topic.trim() ? topic.trim().split(/\s+/) : [];
        return lock(() => readDocs(open().run, parts, Math.min(ctx.config.timeoutSec * 1000, 20_000)));
      },
    });

    ctx.tool({
      name: 'qq_ace_sing', title: '合成清唱', tier: 'send',
      description: [
        '用本机已登录的 ACE Studio，把歌词和音符合成一段虚拟歌手的清唱（干声，无伴奏），并把音频返回给你。',
        '事先：ACE Studio 已打开，账号已在软件里登录。这里只调用官方 acestudio-cli，不读取账号令牌，也不内置声库。',
        '音符用 notes，例如 "C4:1:你 D4:1:好 E4:2:-"：音高、拍数、一个音节。- 表示把上一个字延长。也可以传 score 数组，或另给 lyrics 让插件按音节填进音符。',
        '中文一字一音，英文按空格或连字符分音节。要发到 QQ 就填 conv，不要把文件路径贴进聊天。',
        '命令对不上当前 CLI 时会停下来并说明原因，不会猜测一条命令去改你正在打开的工程。',
      ].join('\n'),
      input: {
        notes: z.string().optional().describe('音高:拍数:歌词，空格分隔。例 C4:1:你 D4:1:好 E4:2:-'),
        score: z.array(z.object({
          pitch: z.union([z.number().int(), z.string()]).describe('MIDI 音高或 C4'),
          beats: z.number().gt(0).max(16),
          lyric: z.string().optional().describe('一个音节；延长填 -'),
        })).optional().describe('与 notes 二选一'),
        lyrics: z.string().optional().describe('整段歌词。音符上没写 lyric 时按音节填进去'),
        singer: z.string().optional().describe('音色库中的歌手名，留空用默认或列表第一位'),
        language: z.string().optional().describe('zh / en / ja / ko / es / yue，默认配置'),
        bpm: z.number().optional().describe('速度，默认配置'),
        title: z.string().optional().describe('临时工程名'),
        conv: z.string().optional().describe('填了就把清唱作为语音发到这个会话'),
      },
      handler: async (args, caller) => {
        if (!args.notes?.trim() && !args.score?.length) throw new AceError('BAD_SCORE', '请提供 notes 或 score');
        const result = await lock(() => sing(args));
        const meta = { singer: result.singer, language: args.language || ctx.config.language, bpm: args.bpm ?? ctx.config.bpm, lyric: lyricOf(args) };
        if (!args.conv) return pack(result.file, meta);
        try {
          return pack(result.file, meta, await sendVoice(caller, args.conv, result.file));
        } catch (e: any) {
          const packed = pack(result.file, meta);
          packed.content.unshift({ type: 'text', text: `音频已合成，但发到 QQ 失败：${e?.message ?? e}` });
          return packed;
        }
      },
    });

    ctx.tool({
      name: 'qq_ace_call', title: '调用 ACE Studio 命令', tier: 'send',
      description: '直接调用本机 acestudio-cli 的一条命令。只能运行 help 里列出的命令；账号、登录、付费命令会拒绝；文件路径必须在插件数据目录内。优先用 qq_ace_sing 合成清唱。',
      input: {
        argv: z.array(z.string().min(1)).min(1).max(32).describe('例如 ["export","audio","--help"]，不要带可执行文件路径'),
      },
      handler: async ({ argv }) => lock(async () => {
        limit();
        const { run } = open();
        const timeoutMs = Math.min(ctx.config.timeoutSec * 1000, 20_000);
        const catalog = await loadCatalog(run, timeoutMs);
        const args = guardArgv(argv, catalog, ctx.dataDir);
        return callChecked(run, args, ctx.config.timeoutSec * 1000);
      }),
    });

    ctx.provide({ sing, listSingers: () => listSingers(open().run, ctx.config.timeoutSec * 1000) });
  },
});

function lyricOf(args: { notes?: string; lyrics?: string; score?: { lyric?: string }[] }): string {
  if (args.lyrics?.trim()) return args.lyrics.trim().replace(/\s+/g, ' ').slice(0, 200);
  if (args.score?.length) return args.score.map((n) => n.lyric || placeholderFor('zh')).join('');
  return (args.notes ?? '').replace(/\s+/g, ' ').slice(0, 200);
}
