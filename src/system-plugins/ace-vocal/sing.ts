import fs from 'node:fs';
import path from 'node:path';
import { AceError, assertArgPath, explainFailure, isInside, type Runner } from './cli.ts';
import {
  catalogBrief, commandKey, ensureDetails, findOption, isBlocked, loadCatalog, matchCommand, parseHelpOptions,
  pickEnum, resolveStep, type Catalog, type HelpCommand, type HelpOption,
} from './help.ts';
import { notesDocument, plainLabel, type NoteIn } from './score.ts';

export interface SingInput {
  singer?: string;
  language: string;
  bpm: number;
  notes: NoteIn[];
  title: string;
  outFile: string;
  outRoot: string;
  notesFile: string;
  effects: 'off' | 'on';
  format: 'wav' | 'mp3';
  allowCurrentProject: boolean;
  timeoutMs: number;
}

export interface PlanStep { args: string[]; stdin?: string; timeoutMs: number }

const TRACK = 'QAB Vocal';

function opts(catalog: Catalog, cmd: HelpCommand): HelpOption[] {
  return catalog.options.get(commandKey(cmd.path)) ?? [];
}

function helpOf(catalog: Catalog, cmd: HelpCommand): string {
  return catalog.helpText.get(commandKey(cmd.path)) ?? '';
}

function pushOpt(args: string[], opt: HelpOption | undefined, value: string | undefined) {
  if (!opt || value === undefined) return;
  const name = opt.names[opt.names.length - 1];
  if (opt.takesValue) args.push(`--${name}`, value);
  else if (value === 'true' || value === 'on') args.push(`--${name}`);
}

function must(catalog: Catalog, cmd: HelpCommand, slot: string, what: string): HelpOption {
  const opt = findOption(opts(catalog, cmd), slot);
  if (!opt) {
    throw new AceError('UNSUPPORTED', `「${cmd.path.join(' ')}」没有${what}参数，已停止，没有改工程。\n${helpOf(catalog, cmd).trim().slice(0, 600)}\n当前命令：${catalogBrief(catalog)}`);
  }
  return opt;
}

function unsupported(what: string, catalog: Catalog): AceError {
  return new AceError('UNSUPPORTED', `${what}。已停止，没有改工程。\n当前 CLI 命令：${catalogBrief(catalog)}`);
}

/** 根据已经读到的帮助，排好「新建工程 → 上歌手 → 写入音符歌词 → 导出干声」。缺关键参数就停。 */
export function buildPlan(catalog: Catalog, input: SingInput & { singer: string }, notesFile: string): PlanStep[] {
  const exportCmd = resolveStep(catalog.commands, 'exportAudio');
  const noteCmd = resolveStep(catalog.commands, 'noteSet');
  const trackCmd = resolveStep(catalog.commands, 'trackAdd') ?? resolveStep(catalog.commands, 'voiceLoad');
  if (!exportCmd) throw unsupported('这个版本的 CLI 没有导出音频的命令', catalog);
  if (!noteCmd) throw unsupported('这个版本的 CLI 没有写入音符的命令', catalog);
  if (!trackCmd) throw unsupported('这个版本的 CLI 没有加载虚拟歌手的命令', catalog);
  const createCmd = resolveStep(catalog.commands, 'projectCreate');
  if (!createCmd && !input.allowCurrentProject) {
    throw new AceError('UNSUPPORTED', '这个 CLI 不能新建工程。为避免改动你正在打开的曲子，已停止。若确定要写进当前工程，请在插件配置里打开「允许使用当前工程」。');
  }

  const steps: PlanStep[] = [];
  const timeoutMs = input.timeoutMs;
  if (createCmd) {
    const args = [...createCmd.path];
    const nameOpt = findOption(opts(catalog, createCmd), 'name');
    if (nameOpt) pushOpt(args, nameOpt, input.title);
    else args.push(input.title);
    steps.push({ args, timeoutMs });
  }

  const tempo = resolveStep(catalog.commands, 'tempo');
  if (tempo) {
    const bpmOpt = findOption(opts(catalog, tempo), 'bpm');
    if (bpmOpt?.takesValue) {
      const args = [...tempo.path];
      pushOpt(args, bpmOpt, String(input.bpm));
      steps.push({ args, timeoutMs });
    }
  }

  const trackArgs = [...trackCmd.path];
  const trackOpts = opts(catalog, trackCmd);
  pushOpt(trackArgs, findOption(trackOpts, 'name'), TRACK);
  const typeOpt = findOption(trackOpts, 'type');
  if (typeOpt?.takesValue) pushOpt(trackArgs, typeOpt, pickEnum(typeOpt.meta, ['voice', 'vocal', 'singer'], 'voice'));
  const voiceOpt = must(catalog, trackCmd, 'voice', '指定歌手');
  pushOpt(trackArgs, voiceOpt, input.singer);
  const langOpt = findOption(trackOpts, 'language');
  if (langOpt?.takesValue) pushOpt(trackArgs, langOpt, input.language);
  steps.push({ args: trackArgs, timeoutMs });

  steps.push(bindNotes(catalog, noteCmd, notesFile, input, timeoutMs));
  steps.push(bindExport(catalog, exportCmd, input, timeoutMs));
  return steps;
}

function bindNotes(catalog: Catalog, cmd: HelpCommand, notesFile: string, input: SingInput & { singer: string }, timeoutMs: number): PlanStep {
  const options = opts(catalog, cmd);
  const args = [...cmd.path];
  const trackOpt = findOption(options, 'track');
  if (trackOpt?.takesValue) pushOpt(args, trackOpt, TRACK);
  const notesOpt = findOption(options, 'notes');
  if (notesOpt?.takesValue) {
    const meta = `${notesOpt.meta ?? ''} ${notesOpt.summary} ${notesOpt.names.join(' ')}`.toLowerCase();
    const asFile = /file|path/.test(meta) || !/json/.test(meta);
    pushOpt(args, notesOpt, asFile ? notesFile : JSON.stringify(notesDocument({ ...input, voice: input.singer })));
    return { args, timeoutMs };
  }
  const usage = helpOf(catalog, cmd);
  const positional = usage.split(/\r?\n/).find((l) => /usage/i.test(l)) ?? '';
  if (/<(?:notes|score|file|json)[^>]*>/i.test(positional)) return { args: [...args, notesFile], timeoutMs };
  const jsonOpt = findOption(options, 'json');
  if (jsonOpt && !jsonOpt.takesValue) {
    args.push(`--${jsonOpt.names[jsonOpt.names.length - 1]}`);
    return { args, stdin: JSON.stringify(notesDocument({ ...input, voice: input.singer })), timeoutMs };
  }
  if (/stdin|standard input/i.test(usage)) {
    return { args, stdin: JSON.stringify(notesDocument({ ...input, voice: input.singer })), timeoutMs };
  }
  throw new AceError('UNSUPPORTED', `「${cmd.path.join(' ')}」看不出怎么传入音符，已停止。\n${usage.trim().slice(0, 600)}`);
}

function bindExport(catalog: Catalog, cmd: HelpCommand, input: SingInput, timeoutMs: number): PlanStep {
  const options = opts(catalog, cmd);
  const args = [...cmd.path];
  const outOpt = must(catalog, cmd, 'out', '指定导出文件');
  if (!outOpt.takesValue) throw new AceError('UNSUPPORTED', '导出命令不能指定输出文件，已停止，以免音频写到未知位置。');
  pushOpt(args, outOpt, input.outFile);
  const trackOpt = findOption(options, 'track');
  if (trackOpt?.takesValue) pushOpt(args, trackOpt, TRACK);
  const formatOpt = findOption(options, 'format');
  if (formatOpt?.takesValue) pushOpt(args, formatOpt, pickEnum(formatOpt.meta, [input.format], input.format));
  const chOpt = findOption(options, 'channels');
  if (chOpt?.takesValue) pushOpt(args, chOpt, pickEnum(chOpt.meta, ['mono', '1'], 'mono'));
  if (input.effects === 'off') {
    const dry = findOption(options, 'dry');
    if (dry && !dry.takesValue) args.push(`--${dry.names[dry.names.length - 1]}`);
    const fx = findOption(options, 'effects');
    if (fx?.takesValue) pushOpt(args, fx, pickEnum(fx.meta, ['off', 'false', 'none', '0'], 'off'));
  }
  return { args, timeoutMs };
}

async function checked(run: Runner, step: PlanStep): Promise<void> {
  const r = await run(step.args, { stdin: step.stdin, timeoutMs: step.timeoutMs });
  const text = [r.stdout, r.stderr].filter(Boolean).join('\n');
  const hint = explainFailure(text);
  if (hint) throw new AceError(hint.code, hint.message);
  if (r.code !== 0) throw new AceError('CLI', `acestudio-cli ${step.args.join(' ')} 失败（${r.code}）：${text.trim().slice(-500)}`);
}

export function parseVoiceNames(text: string): string[] {
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      const j = JSON.parse(t);
      const arr = Array.isArray(j) ? j : j.voices ?? j.singers ?? j.items ?? [];
      if (Array.isArray(arr)) {
        return arr.map((v) => typeof v === 'string' ? v : String(v?.name ?? v?.title ?? '')).map((s) => s.trim()).filter(Boolean);
      }
    } catch { /* 按行解析 */ }
  }
  return t.split(/\r?\n/).map((l) => l.replace(/^[\s*+-]+/, '').replace(/`/g, '').trim())
    .filter((l) => l && l.length <= 80 && !/^[{[]/.test(l) && !/^(commands?|usage|options)\b/i.test(l) && !l.startsWith('--'));
}

async function readVoices(run: Runner, catalog: Catalog, timeoutMs: number): Promise<string[]> {
  const cmd = resolveStep(catalog.commands, 'voiceList');
  if (!cmd) throw unsupported('这个版本的 CLI 没有列出歌手的命令', catalog);
  await ensureDetails(run, catalog, cmd, Math.min(timeoutMs, 20_000));
  const args = [...cmd.path];
  const jsonOpt = findOption(opts(catalog, cmd), 'json');
  if (jsonOpt && !jsonOpt.takesValue) args.push(`--${jsonOpt.names[jsonOpt.names.length - 1]}`);
  const r = await run(args, { timeoutMs });
  const text = [r.stdout, r.stderr].filter(Boolean).join('\n');
  const hint = explainFailure(text);
  if (hint) throw new AceError(hint.code, hint.message);
  if (r.code !== 0) throw new AceError('CLI', `读取歌手失败：${text.trim().slice(-400)}`);
  const names = parseVoiceNames(r.stdout);
  if (!names.length) throw new AceError('CLI', '没有从 ACE Studio 读到歌手。请确认账号已登录，并且音色库里至少有一位虚拟歌手。');
  return names;
}

/**
 * 用官方 CLI 合成清唱。命令名来自本机 `acestudio-cli help`，对不上就停，不猜测、不改当前工程。
 * 不读取账号目录，也不绕过登录。
 */
export async function synthesize(run: Runner, input: SingInput): Promise<{ file: string; singer: string; commands: string[][] }> {
  if (!isInside(input.outRoot, input.outFile) || !isInside(input.outRoot, input.notesFile)) {
    throw new AceError('OUTPUT', '导出路径跑到了插件数据目录外面，已拒绝');
  }
  const helpTimeout = Math.min(input.timeoutMs, 20_000);
  const catalog = await loadCatalog(run, helpTimeout);
  const needed = ['exportAudio', 'noteSet', 'trackAdd', 'voiceLoad', 'projectCreate', 'projectInfo', 'tempo', 'voiceList'] as const;
  for (const id of needed) {
    const cmd = resolveStep(catalog.commands, id);
    if (cmd) await ensureDetails(run, catalog, cmd, helpTimeout);
  }

  const info = resolveStep(catalog.commands, 'projectInfo');
  if (info) {
    const r = await run([...info.path], { timeoutMs: helpTimeout });
    const text = [r.stdout, r.stderr].filter(Boolean).join('\n');
    const hint = explainFailure(text);
    if (hint?.code === 'LOGIN') throw new AceError('LOGIN', hint.message);
    if (hint?.code === 'CLI' && /连不上/.test(hint.message)) throw new AceError('CLI', hint.message);
  }

  let singer = input.singer?.trim() ? plainLabel(input.singer, 60) : '';
  if (!singer || !info) {
    const names = await readVoices(run, catalog, input.timeoutMs);
    if (!singer) singer = plainLabel(names[0], 60);
  }
  const ready = { ...input, singer, title: plainLabel(input.title || 'QAB Vocal', 40) };
  const plan = buildPlan(catalog, ready, input.notesFile);
  fs.mkdirSync(path.dirname(input.notesFile), { recursive: true });
  fs.writeFileSync(input.notesFile, JSON.stringify(notesDocument({ ...ready, voice: singer }), null, 2));
  for (const step of plan) await checked(run, step);
  if (!fs.existsSync(input.outFile) || fs.statSync(input.outFile).size <= 0 || !isInside(input.outRoot, input.outFile)) {
    throw new AceError('OUTPUT', 'CLI 已返回，但没有在插件目录里生成音频。可以先看 qq_ace_docs 里 export 的说明，或升级 ACE Studio。');
  }
  return { file: input.outFile, singer, commands: plan.map((s) => s.args) };
}

export async function listSingers(run: Runner, timeoutMs: number): Promise<string[]> {
  const catalog = await loadCatalog(run, Math.min(timeoutMs, 20_000));
  return readVoices(run, catalog, timeoutMs);
}

export async function readDocs(run: Runner, topic: string[], timeoutMs: number): Promise<string> {
  const catalog = await loadCatalog(run, timeoutMs);
  if (!topic.length) {
    const r = await run(['help'], { timeoutMs });
    const text = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
    return (text || catalog.commands.map((c) => `${c.path.join(' ')}  ${c.summary}`).join('\n')).slice(0, 12_000);
  }
  const hit = matchCommand(topic, catalog.commands);
  if (!hit || hit.rest.length) throw new AceError('UNSUPPORTED', `帮助里没有「${topic.join(' ')}」。可选：${catalogBrief(catalog)}`);
  if (isBlocked(hit.cmd.path)) throw new AceError('UNSUPPORTED', '账号、登录和付费相关命令不会代为执行');
  const r = await run(['help', ...hit.cmd.path], { timeoutMs });
  return [r.stdout, r.stderr].filter(Boolean).join('\n').trim().slice(0, 12_000);
}

/** 只允许帮助里出现过的命令，并且任何文件路径都不能离开插件数据目录。 */
export function guardArgv(argv: string[], catalog: Catalog, dataDir: string): string[] {
  if (argv.length < 1 || argv.length > 32) throw new AceError('UNSUPPORTED', '命令长度不合法');
  for (const a of argv) {
    if (typeof a !== 'string' || !a || a.length > 4000 || /[\0\r\n]/.test(a)) throw new AceError('UNSUPPORTED', '参数里有空字符或换行，已拒绝');
  }
  const hit = matchCommand(argv, catalog.commands);
  if (!hit) throw new AceError('UNSUPPORTED', `「${argv.join(' ')}」不在当前 CLI 帮助里，已拒绝`);
  if (isBlocked(hit.cmd.path)) throw new AceError('UNSUPPORTED', '账号、登录和付费相关命令不会代为执行');
  for (const a of hit.rest) assertArgPath(a, dataDir);
  return [...hit.cmd.path, ...hit.rest];
}

export async function callChecked(run: Runner, args: string[], timeoutMs: number): Promise<string> {
  const r = await run(args, { timeoutMs });
  const text = [r.stdout, r.stderr].filter(Boolean).join('\n');
  const hint = explainFailure(text);
  if (hint) throw new AceError(hint.code, hint.message);
  if (r.code !== 0) throw new AceError('CLI', `acestudio-cli ${args.join(' ')} 失败（${r.code}）：${text.trim().slice(-500)}`);
  return text.trim().slice(0, 12_000);
}

/** 测试用：把一段帮助文本直接写进目录，省掉再跑一遍 help。 */
export function seedDetails(catalog: Catalog, cmd: HelpCommand, text: string) {
  catalog.helpText.set(commandKey(cmd.path), text);
  catalog.options.set(commandKey(cmd.path), parseHelpOptions(text));
}
