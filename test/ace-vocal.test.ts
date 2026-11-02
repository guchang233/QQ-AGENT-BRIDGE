import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isInside, resolveCliPath, type Runner } from '../src/system-plugins/ace-vocal/cli.ts';
import { parseHelpIndex, parseHelpOptions, resolveStep } from '../src/system-plugins/ace-vocal/help.ts';
import { materialize, parsePitch, parseScoreString, splitSyllables } from '../src/system-plugins/ace-vocal/score.ts';
import { buildPlan, guardArgv, seedDetails, synthesize, type SingInput } from '../src/system-plugins/ace-vocal/sing.ts';
import { loadCatalog } from '../src/system-plugins/ace-vocal/help.ts';

const INDEX = `
ACE Studio CLI 0.18.7

Commands:
  project info                   Show the current project
  project create                 Create an empty project
  voice list                     List singers
  track add                      Add a track and load a voice
  note set                       Replace notes and lyrics
  transport tempo                Set tempo
  export audio                   Export rendered audio
  clip beat-content              Read beat analysis
  account logout                 Sign out
`;

const DETAILS: Record<string, string> = {
  'project info': 'project info\nShow the current project.\n',
  'project create': 'Usage: acestudio-cli project create\n\nOptions:\n  --name <title>       Project name\n',
  'voice list': 'voice list\n\nOptions:\n  --json               Print JSON\n',
  'track add': 'Options:\n  --name <name>        Track name\n  --type <voice|audio> Track type\n  --voice <singer>     Singer\n  --language <code>    Language\n',
  'note set': 'Usage: acestudio-cli note set\n\nOptions:\n  --track <name>       Track\n  --notes-file <path>  JSON file of notes\n',
  'transport tempo': 'Options:\n  --bpm <number>       Tempo\n',
  'export audio': 'Options:\n  --track <name>       Track\n  --out <path>         Output file\n  --format <wav|mp3>   Format\n  --effects <on|off>   Vocal effects\n  --channels <mono|stereo>  Channels\n',
  'clip beat-content': 'clip beat-content\n',
};

function fake(opts?: { login?: boolean; write?: boolean; index?: string }) {
  const calls: string[][] = [];
  const run: Runner = async (args) => {
    calls.push([...args]);
    if (args[0] === 'help' && args.length === 1) return { code: 0, stdout: opts?.index ?? INDEX, stderr: '' };
    if (args[0] === 'help') return { code: 0, stdout: DETAILS[args.slice(1).join(' ')] ?? '', stderr: '' };
    if (opts?.login) return { code: 2, stdout: '', stderr: 'Please log in to your ACE Studio account' };
    if (args[0] === 'export' && args[1] === 'audio' && opts?.write !== false) {
      const out = args[args.indexOf('--out') + 1];
      fs.writeFileSync(out, Buffer.from('RIFFdemo'));
    }
    if (args[0] === 'voice') return { code: 0, stdout: 'Elirah\nEmma\n', stderr: '' };
    return { code: 0, stdout: '{}', stderr: '' };
  };
  return { run, calls };
}

function job(dir: string): SingInput {
  return {
    singer: 'Elirah', language: 'zh', bpm: 90, title: '试唱',
    notes: materialize(parseScoreString('C4:1:你 D4:1:好 E4:2:-'), undefined, 'zh', 32),
    outFile: path.join(dir, 'vocal.wav'),
    outRoot: dir,
    notesFile: path.join(dir, 'notes.json'),
    effects: 'off', format: 'wav', allowCurrentProject: false, timeoutMs: 5_000,
  };
}

describe('歌词和音符', () => {
  it('识别音高并按音节切开歌词', () => {
    expect(parsePitch('C4')).toBe(60);
    expect(parsePitch('Bb3')).toBe(58);
    expect(parsePitch(60)).toBe(60);
    expect(splitSyllables('你好 世界')).toEqual(['你', '好', '世', '界']);
    expect(splitSyllables('hel-lo world')).toEqual(['hel', 'lo', 'world']);
    expect(splitSyllables('你-好')).toEqual(['你', '-', '好']);
  });

  it('整段歌词按音符填充，多出来的音节会拒绝', () => {
    const raw = parseScoreString('C4:1 D4:1 E4:1 F4:1');
    const notes = materialize(raw, '你好世界', 'zh', 32);
    expect(notes.map((n) => n.lyric)).toEqual(['你', '好', '世', '界']);
    expect(notes[1]).toMatchObject({ pitch: 62, startBeat: 1, durationBeat: 1 });
    expect(() => materialize(raw.slice(0, 3), '你好世界', 'zh', 32)).toThrow(/没有音符/);
    expect(() => materialize([{ pitch: 'C4', beats: 1, lyric: '你好' }], undefined, 'zh', 32)).toThrow(/一个音节/);
  });
});

describe('CLI 帮助', () => {
  it('抽出命令并丢掉账号命令和说明文字', () => {
    const cmds = parseHelpIndex(INDEX);
    expect(cmds.map((c) => c.path.join(' '))).toContain('clip beat-content');
    expect(cmds.map((c) => c.path.join(' '))).toContain('export audio');
    expect(cmds.some((c) => c.path[0] === 'help')).toBe(false);
    expect(resolveStep(cmds, 'exportAudio')?.path).toEqual(['export', 'audio']);
    expect(resolveStep(cmds, 'noteSet')?.path).toEqual(['note', 'set']);
    const options = parseHelpOptions(DETAILS['export audio']);
    expect(options.find((o) => o.names.includes('out'))).toMatchObject({ takesValue: true });
    expect(options.find((o) => o.names.includes('effects'))?.meta).toBe('<on|off>');
  });

  it('也认 JSON 命令表', () => {
    const cmds = parseHelpIndex(JSON.stringify({ commands: [{ name: 'export audio', description: '导出' }] }));
    expect(cmds).toEqual([{ path: ['export', 'audio'], summary: '导出' }]);
  });
});

describe('清唱链路', () => {
  it('按帮助把歌词音符交给 CLI，并只把干声写进插件目录', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-vocal-'));
    const { run, calls } = fake({ write: true });
    const result = await synthesize(run, job(dir));
    expect(result.singer).toBe('Elirah');
    expect(fs.readFileSync(result.file).toString()).toBe('RIFFdemo');
    const notes = JSON.parse(fs.readFileSync(path.join(dir, 'notes.json'), 'utf8'));
    expect(notes.notes.map((n: { lyric: string; pitch: number }) => [n.pitch, n.lyric])).toEqual([[60, '你'], [62, '好'], [64, '-']]);
    const flat = calls.map((c) => c.join(' '));
    expect(flat.some((c) => c.startsWith('project create'))).toBe(true);
    expect(flat.some((c) => c.includes('--voice') && c.includes('Elirah') && c.includes('--type') && c.includes('voice'))).toBe(true);
    expect(flat.some((c) => c.includes('--effects') && c.includes('off') && c.includes('--channels') && c.includes('mono'))).toBe(true);
    expect(flat.some((c) => c.includes('account'))).toBe(false);
  });

  it('未登录时停在探测，不新建工程也不导出', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-vocal-'));
    const { run, calls } = fake({ login: true });
    await expect(synthesize(run, job(dir))).rejects.toThrow(/还没登录/);
    expect(calls.some((c) => c[0] === 'project' && c[1] === 'create')).toBe(false);
    expect(calls.some((c) => c[0] === 'export')).toBe(false);
    expect(fs.existsSync(path.join(dir, 'notes.json'))).toBe(false);
  });

  it('没有导出命令或不能新建工程时，不改当前工程', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-vocal-'));
    const index = INDEX.replace('  export audio                   Export rendered audio\n', '');
    const { run, calls } = fake({ index });
    await expect(synthesize(run, job(dir))).rejects.toThrow(/导出音频/);
    expect(calls.some((c) => c[0] === 'project' && c[1] === 'create')).toBe(false);

    const catalog = await loadCatalog(fake({ index: INDEX.replace('  project create                 Create an empty project\n', '') }).run, 1000);
    for (const id of ['exportAudio', 'noteSet', 'trackAdd', 'tempo'] as const) {
      const cmd = resolveStep(catalog.commands, id)!;
      seedDetails(catalog, cmd, DETAILS[cmd.path.join(' ')]);
    }
    const input = job(dir);
    expect(() => buildPlan(catalog, { ...input, singer: input.singer ?? 'Elirah', allowCurrentProject: false }, input.notesFile)).toThrow(/当前工程/);
  });

  it('直接调用只接受帮助里的命令，路径不能离开数据目录', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-vocal-'));
    const catalog = await loadCatalog(fake().run, 1000);
    expect(guardArgv(['export', 'audio', '--out', path.join(dir, 'a.wav')], catalog, dir).slice(0, 2)).toEqual(['export', 'audio']);
    expect(() => guardArgv(['export', 'audio', '--out', '/tmp/leak.wav'], catalog, dir)).toThrow(/数据目录/);
    expect(() => guardArgv(['rm', '-rf', '/'], catalog, dir)).toThrow(/不在当前/);
    catalog.commands.push({ path: ['account', 'logout'], summary: '' });
    expect(() => guardArgv(['account', 'logout'], catalog, dir)).toThrow(/不会代为执行/);
  });
});

describe('CLI 路径', () => {
  it('只接受官方文件名或用户自己填的路径', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-bin-'));
    const bin = path.join(dir, 'acestudio-cli');
    fs.writeFileSync(bin, '');
    expect(resolveCliPath(bin)).toBe(bin);
    expect(resolveCliPath('', { platform: 'linux', env: { PATH: dir }, exists: (p) => p === bin })).toBe(bin);
    const mac = '/Applications/ACE Studio.app/Contents/Helpers/acestudio-cli';
    expect(resolveCliPath('', { platform: 'darwin', env: {}, exists: (p) => p === mac })).toBe(mac);
    expect(() => resolveCliPath('', { platform: 'linux', env: { PATH: '' }, exists: () => false })).toThrow(/没有找到/);
    expect(isInside(dir, path.join(dir, 'a.wav'))).toBe(true);
    expect(isInside(dir, path.join(dir, '..', 'a.wav'))).toBe(false);
  });
});
