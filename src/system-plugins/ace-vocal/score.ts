import { AceError } from './cli.ts';

export interface NoteIn {
  pitch: number;
  startBeat: number;
  durationBeat: number;
  lyric: string;
}

const SEMI: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

export function parsePitch(v: number | string): number {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 127) return v;
  const s = String(v).trim().replace(/\s/g, '');
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (n >= 0 && n <= 127) return n;
  }
  const m = /^([a-g])([#b♯♭]?)(-?\d)$/i.exec(s);
  if (!m) throw new AceError('BAD_SCORE', `无法识别音高「${String(v).slice(0, 32)}」，用 C4 或 MIDI 数字`);
  let semi = SEMI[m[1].toLowerCase()];
  if (m[2] === '#' || m[2] === '♯') semi += 1;
  if (m[2] === 'b' || m[2] === '♭') semi -= 1;
  const midi = (Number(m[3]) + 1) * 12 + semi;
  if (midi < 0 || midi > 127) throw new AceError('BAD_SCORE', `音高「${s}」超出 MIDI 范围`);
  return midi;
}

const CJK = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u;

/** 中日韩一字一音节；英文按空格或连字符切开；单独的 - 表示把上一个音节延长。 */
export function splitSyllables(input: string): string[] {
  const s = input.normalize('NFC').replace(/\r/g, '');
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/u.test(ch) || /[，。！？、,.!?;；:："“”'‘’()（）]/.test(ch)) { i++; continue; }
    if (ch === '-' || ch === '—' || ch === '–') { out.push('-'); i++; continue; }
    if (CJK.test(ch)) { out.push(ch); i++; continue; }
    let j = i;
    while (j < s.length && !/\s/u.test(s[j]) && !CJK.test(s[j]) && !/[，。！？、,.!?;；:："“”'‘’()（）]/.test(s[j])) j++;
    const word = s.slice(i, j);
    if (word.includes('-')) {
      for (const part of word.split('-')) out.push(part || '-');
    } else if (word) out.push(word);
    i = j;
  }
  return out.filter((x) => x !== '');
}

export function placeholderFor(language: string): string {
  return language === 'zh' || language === 'yue' ? '啦' : 'da';
}

export interface RawNote { pitch: number | string; beats: number; lyric?: string }

export function parseScoreString(text: string): RawNote[] {
  const src = text.trim().replace(/：/g, ':');
  if (!src) throw new AceError('BAD_SCORE', '没有音符');
  if (src.startsWith('[')) {
    let arr: any;
    try { arr = JSON.parse(src); } catch { throw new AceError('BAD_SCORE', '音符 JSON 无法解析'); }
    if (!Array.isArray(arr) || !arr.length) throw new AceError('BAD_SCORE', '音符 JSON 是空的');
    return arr.map((n) => ({ pitch: n.pitch, beats: Number(n.beats ?? n.duration ?? n.durationBeat), lyric: n.lyric }));
  }
  const notes: RawNote[] = [];
  for (const tok of src.split(/\s+/)) {
    if (!tok || tok === '|') continue;
    const parts = tok.split(':');
    if (parts.length < 2) throw new AceError('BAD_SCORE', `音符「${tok}」应为 音高:拍数 或 音高:拍数:歌词，例如 C4:1:你`);
    const beats = Number(parts[1]);
    if (!Number.isFinite(beats) || beats <= 0 || beats > 16) throw new AceError('BAD_SCORE', `音符「${tok}」的拍数要在 0 到 16 之间`);
    const lyric = parts.length > 2 ? parts.slice(2).join(':') : undefined;
    notes.push({ pitch: parts[0], beats, lyric: lyric === '' ? undefined : lyric });
  }
  if (!notes.length) throw new AceError('BAD_SCORE', '没有音符');
  return notes;
}

const round = (n: number) => Math.round(n * 10000) / 10000;

export function materialize(raw: RawNote[], lyrics: string | undefined, language: string, maxNotes: number): NoteIn[] {
  if (raw.length > maxNotes) throw new AceError('BAD_SCORE', `音符太多（${raw.length}），上限 ${maxNotes}`);
  const syllables = lyrics?.trim() ? splitSyllables(lyrics) : undefined;
  let si = 0;
  let beat = 0;
  const notes: NoteIn[] = [];
  for (const n of raw) {
    if (!Number.isFinite(n.beats) || n.beats <= 0 || n.beats > 16) throw new AceError('BAD_SCORE', '每一拍的时值要在 0 到 16 之间');
    let lyric = n.lyric?.trim();
    if (!lyric && syllables) lyric = si < syllables.length ? syllables[si++] : '-';
    if (!lyric) lyric = placeholderFor(language);
    const parts = splitSyllables(lyric);
    if (parts.length !== 1) throw new AceError('BAD_SCORE', `「${lyric}」不是一个音节。一个音符只放一个字，延长用 -`);
    notes.push({ pitch: parsePitch(n.pitch), startBeat: round(beat), durationBeat: round(n.beats), lyric: parts[0] });
    beat += n.beats;
  }
  if (syllables && si < syllables.length) {
    const rest = syllables.slice(si, si + 12).join('');
    throw new AceError('BAD_SCORE', `还有 ${syllables.length - si} 个音节没有音符（${rest}）。请补上音符，或在旋律里用 - 延长`);
  }
  if (beat <= 0) throw new AceError('BAD_SCORE', '旋律是空的');
  return notes;
}

export function assertLength(notes: NoteIn[], bpm: number) {
  const end = notes.reduce((m, n) => Math.max(m, n.startBeat + n.durationBeat), 0);
  const seconds = end * 60 / bpm;
  if (seconds > 180) throw new AceError('BAD_SCORE', `这段大约 ${Math.round(seconds)} 秒，清唱请控制在 3 分钟以内`);
}

export function assertTempo(bpm: number) {
  if (!Number.isFinite(bpm) || bpm < 40 || bpm > 220) throw new AceError('BAD_SCORE', '速度要在 40 到 220 之间');
}

export function notesDocument(input: { bpm: number; language: string; voice: string; notes: NoteIn[] }) {
  return {
    bpm: input.bpm,
    language: input.language,
    voice: input.voice,
    notes: input.notes.map((n) => ({
      pitch: n.pitch,
      startBeat: n.startBeat,
      durationBeat: n.durationBeat,
      durationBeats: n.durationBeat,
      lyric: n.lyric,
    })),
  };
}

export function plainLabel(v: string, max = 40): string {
  const s = v.replace(/[\0\r\n\t]/g, ' ').replace(/[\\/]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) throw new AceError('BAD_SCORE', '名称是空的');
  return [...s].slice(0, max).join('');
}
