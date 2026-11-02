import { AceError, type Runner } from './cli.ts';

export interface HelpCommand { path: string[]; summary: string }
export interface HelpOption { names: string[]; takesValue: boolean; meta?: string; summary: string }
export interface Catalog {
  commands: HelpCommand[];
  options: Map<string, HelpOption[]>;
  helpText: Map<string, string>;
}

const STOP_WORD = new Set(['the', 'a', 'an', 'to', 'for', 'and', 'with', 'from', 'this', 'that', 'your', 'show', 'print', 'current', 'available', 'please', 'usage', 'options']);
const BLOCKED = /^(account|login|logout|token|password|credential|secret|billing|purchase|payment|license|activate|uninstall)$/i;

export function commandKey(p: string[]): string { return p.join(' ').toLowerCase(); }

export function isBlocked(p: string[]): boolean {
  return p.some((part) => BLOCKED.test(part.replace(/_/g, '-')));
}

function tokensOf(p: string[]): string[] {
  return p.flatMap((part) => part.toLowerCase().split(/[\s._-]+/)).filter(Boolean);
}

const ALIAS: Record<string, string[]> = {
  note: ['note', 'notes'],
  lyric: ['lyric', 'lyrics'],
  voice: ['voice', 'voices', 'singer', 'singers', 'speaker'],
  audio: ['audio', 'wav', 'stem'],
  track: ['track', 'tracks'],
};

function hasToken(toks: string[], want: string): boolean {
  const ok = ALIAS[want] ?? [want];
  return toks.some((t) => ok.includes(t));
}

/** 从 `acestudio-cli help` 的输出里抽出命令。实验性 CLI 的格式会变，所以同时认缩进、列表和 JSON。 */
export function parseHelpIndex(text: string): HelpCommand[] {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = commandsFromJson(trimmed);
    if (parsed.length) return parsed;
  }
  const cmds: HelpCommand[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const body = raw.replace(/\t/g, '    ').trim().replace(/^[-*]\s+/, '').replace(/`/g, '');
    if (!body || /^(usage|options|commands|examples?)\b/i.test(body)) continue;
    let head = '';
    let summary = '';
    const colon = body.match(/^([a-z][\w.-]*(?:\s+[a-z][\w.-]*){0,4})\s*[:：]\s*(\S.*)$/i);
    if (colon) { head = colon[1]; summary = colon[2]; }
    else {
      const parts = body.split(/\s{2,}|\s+[—–]\s+|\s+-\s+/);
      head = parts[0] ?? '';
      summary = parts.slice(1).join(' ').trim();
    }
    if (!/^[a-z][\w.-]*(?:\s+[a-z][\w.-]*){0,4}$/i.test(head)) continue;
    const path = head.split(/\s+/).filter(Boolean);
    if (path.some((p) => STOP_WORD.has(p.toLowerCase()))) continue;
    if (path.length === 1 && /^(help|get_docs|docs)$/i.test(path[0])) continue;
    const key = commandKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    cmds.push({ path, summary });
  }
  return cmds;
}

function commandsFromJson(text: string): HelpCommand[] {
  try {
    const j = JSON.parse(text);
    const arr = Array.isArray(j) ? j : j.commands ?? j.tools ?? [];
    if (!Array.isArray(arr)) return [];
    const out: HelpCommand[] = [];
    for (const c of arr) {
      const name = String(c?.name ?? c?.command ?? '');
      const path = name.split(/[\s.]+/).filter(Boolean);
      if (!path.length || path.some((p) => !/^[a-z0-9_-]+$/i.test(p))) continue;
      out.push({ path, summary: String(c?.description ?? c?.summary ?? '') });
    }
    return out;
  } catch { return []; }
}

export function parseHelpOptions(text: string): HelpOption[] {
  const out: HelpOption[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, '  ');
    const m = line.match(/^\s+(?:-\w,\s+)?((?:--[A-Za-z0-9][\w-]*\s*,\s+)*--[A-Za-z0-9][\w-]*)\s*(.*)$/);
    if (!m) continue;
    const names = [...m[1].matchAll(/--([A-Za-z0-9][\w-]*)/g)].map((x) => x[1]);
    if (!names.length) continue;
    let rest = m[2] ?? '';
    let meta: string | undefined;
    const bracket = rest.match(/^([<\[][^>\]]+[>\]])\s*([\s\S]*)$/);
    const metavar = rest.match(/^([A-Z][A-Z0-9_-]*)\s+([\s\S]*)$/);
    if (bracket) { meta = bracket[1]; rest = bracket[2]; }
    else if (metavar && /PATH|FILE|DIR|NAME|OUT|FORMAT|BPM|ID|JSON|LANG/.test(metavar[1])) { meta = metavar[1]; rest = metavar[2]; }
    out.push({ names, takesValue: !!meta, meta, summary: rest.trim() });
  }
  return out;
}

export const STEP_GROUPS = {
  projectInfo: [['project', 'info'], ['session', 'info'], ['project', 'status']],
  projectCreate: [['project', 'create'], ['project', 'new'], ['session', 'create']],
  voiceList: [['voice', 'list'], ['singer', 'list']],
  trackAdd: [['track', 'add'], ['track', 'create'], ['track', 'new']],
  voiceLoad: [['voice', 'load'], ['voice', 'set'], ['singer', 'load'], ['singer', 'set']],
  noteSet: [['note', 'set'], ['note', 'add'], ['note', 'replace'], ['clip', 'note']],
  tempo: [['tempo', 'set'], ['transport', 'tempo'], ['project', 'tempo']],
  exportAudio: [['export', 'audio'], ['export', 'stem'], ['export', 'wav']],
} as const;

export type StepId = keyof typeof STEP_GROUPS;

export function resolveStep(commands: HelpCommand[], id: StepId): HelpCommand | undefined {
  for (const group of STEP_GROUPS[id]) {
    let best: { cmd: HelpCommand; extra: number } | undefined;
    for (const cmd of commands) {
      if (isBlocked(cmd.path)) continue;
      const toks = tokensOf(cmd.path);
      if (!group.every((g) => hasToken(toks, g))) continue;
      const extra = Math.max(0, toks.length - group.length);
      if (!best || extra < best.extra) best = { cmd, extra };
    }
    if (best) return best.cmd;
  }
  return undefined;
}

const SLOT_NAMES: Record<string, string[]> = {
  out: ['out', 'output', 'dest', 'destination', 'filepath', 'file-path'],
  track: ['track', 'track-name', 'track-id'],
  voice: ['voice', 'singer', 'speaker', 'voice-name'],
  language: ['language', 'lang', 'singing-language'],
  bpm: ['bpm', 'tempo'],
  notes: ['notes-file', 'notes', 'score-file', 'score'],
  format: ['format', 'ext'],
  effects: ['effects', 'vocal-effects', 'fx'],
  channels: ['channels', 'channel-mode'],
  name: ['name', 'title', 'project-name'],
  type: ['type', 'kind', 'track-type'],
  json: ['json'],
  dry: ['dry', 'dry-vocal', 'without-effects'],
};

export function findOption(options: HelpOption[], slot: string): HelpOption | undefined {
  for (const name of SLOT_NAMES[slot] ?? [slot]) {
    const hit = options.find((o) => o.names.some((n) => n.toLowerCase() === name));
    if (hit) return hit;
  }
  return undefined;
}

export function pickEnum(meta: string | undefined, prefer: string[], fallback: string): string {
  const choices = (meta ?? '').replace(/[<>\[\]]/g, '').split(/[|,/]/).map((s) => s.trim()).filter(Boolean);
  for (const p of prefer) {
    const hit = choices.find((c) => c.toLowerCase() === p.toLowerCase());
    if (hit) return hit;
  }
  return choices[0] && prefer.length === 0 ? choices[0] : fallback;
}

export function catalogBrief(catalog: Catalog): string {
  return catalog.commands.slice(0, 40).map((c) => c.path.join(' ')).join('、') || '（没有解析到命令）';
}

async function runText(run: Runner, args: string[], timeoutMs: number): Promise<{ code: number; text: string; stdout: string; stderr: string }> {
  const r = await run(args, { timeoutMs });
  return { code: r.code, stdout: r.stdout, stderr: r.stderr, text: [r.stdout, r.stderr].filter(Boolean).join('\n') };
}

/** 读一遍帮助，得到当前安装的命令表。这是官方文档所说的「链路」来源。 */
export async function loadCatalog(run: Runner, timeoutMs: number): Promise<Catalog> {
  let text = '';
  for (const args of [['help'], ['get_docs'], ['--help']]) {
    const r = await runText(run, args, timeoutMs);
    if (r.text.trim()) { text = r.text; if (parseHelpIndex(text).length) break; }
  }
  const commands = parseHelpIndex(text).filter((c) => !isBlocked(c.path));
  if (!commands.length) {
    throw new AceError('UNSUPPORTED', `acestudio-cli 有响应，但没有解析出命令。请升级 ACE Studio 后重试。\n${text.trim().slice(0, 500)}`);
  }
  return { commands, options: new Map(), helpText: new Map() };
}

export async function ensureDetails(run: Runner, catalog: Catalog, cmd: HelpCommand, timeoutMs: number): Promise<HelpOption[]> {
  const key = commandKey(cmd.path);
  const cached = catalog.options.get(key);
  if (cached) return cached;
  const r = await runText(run, ['help', ...cmd.path], timeoutMs);
  const text = r.text || '';
  const options = parseHelpOptions(text);
  catalog.helpText.set(key, text);
  catalog.options.set(key, options);
  return options;
}

export function matchCommand(argv: string[], commands: HelpCommand[]): { cmd: HelpCommand; rest: string[] } | undefined {
  let best: HelpCommand | undefined;
  for (const cmd of commands) {
    if (cmd.path.length > argv.length) continue;
    if (!cmd.path.every((p, i) => p.toLowerCase() === argv[i]?.toLowerCase())) continue;
    if (!best || cmd.path.length > best.path.length) best = cmd;
  }
  if (!best) return undefined;
  return { cmd: best, rest: argv.slice(best.path.length) };
}
