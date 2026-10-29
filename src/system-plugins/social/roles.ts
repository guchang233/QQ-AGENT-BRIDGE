import fs from 'node:fs';
import path from 'node:path';

/**
 * 人格卡（与 qq-bridge 的 roles/*.md 格式兼容）。
 * 标题可带模式标签：〔二代〕/[v2]/（reserved2） 或 〔一代〕/[v1]/（reserved）。
 * 本项目的仿真等同 qq-bridge 二代：保留无标签与二代章节，去掉一代章节与标签。
 * 另外按 qq-bridge 的经验去掉一代协议残留行（[SILENT] / 空格分隔 等）。
 */
const V1_TAG = /〔一代〕|\[v1\]|（reserved）|\(reserved\)/i;
const V2_TAG = /〔二代〕|\[v2\]|（reserved2）|\(reserved2\)/gi;
const GEN1_LINE = /\[SILENT\]|空格分隔|自动转发/;

export function selectRoleText(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let skipLevel = 0;
  for (const line of lines) {
    const h = /^(#{1,6})\s/.exec(line);
    if (h) {
      const level = h[1].length;
      if (skipLevel && level <= skipLevel) skipLevel = 0;
      if (!skipLevel && V1_TAG.test(line)) { skipLevel = level; continue; }
    }
    if (skipLevel) continue;
    if (GEN1_LINE.test(line)) continue;
    out.push(line.replace(V2_TAG, '').replace(/\s+$/, ''));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function sanitizeRoleName(name: string): string {
  const n = String(name).trim().replace(/\.md$/i, '').replace(/[^\w一-鿿-]/g, '').slice(0, 40);
  if (!n || /^(readme|con|prn|aux|nul|com\d|lpt\d)$/i.test(n)) throw new Error('无效的人格名');
  return n;
}

export class RoleStore {
  private cache = new Map<string, { key: string; text: string }>();
  constructor(public dir: string, private maxChars: () => number) { fs.mkdirSync(dir, { recursive: true }); }

  list(): { name: string; size: number; mtime: number }[] {
    return fs.readdirSync(this.dir).filter((f) => f.endsWith('.md') && !/^readme\.md$/i.test(f)).map((f) => {
      const st = fs.statSync(path.join(this.dir, f));
      return { name: f.slice(0, -3), size: st.size, mtime: st.mtimeMs };
    });
  }

  raw(name: string): string { return fs.readFileSync(path.join(this.dir, `${sanitizeRoleName(name)}.md`), 'utf8'); }

  /** 注入用文本（按模式筛选 + 截断）；不存在返回空串。缓存键含 mtime+size（qq-bridge 曾因只看 mtime 吃过亏）。 */
  text(name: string): string {
    if (!name) return '';
    let file: string;
    try { file = path.join(this.dir, `${sanitizeRoleName(name)}.md`); } catch { return ''; }
    let st: fs.Stats;
    try { st = fs.statSync(file); } catch { return ''; }
    const key = `${st.mtimeMs}|${st.size}|${this.maxChars()}`;
    const c = this.cache.get(name);
    if (c?.key === key) return c.text;
    const t = [...selectRoleText(fs.readFileSync(file, 'utf8'))].slice(0, this.maxChars()).join('');
    this.cache.set(name, { key, text: t });
    return t;
  }

  /** 内容指纹：人格变化时需要重新发送完整人格卡。 */
  version(name: string): string {
    try { const st = fs.statSync(path.join(this.dir, `${sanitizeRoleName(name)}.md`)); return `${name}|${st.mtimeMs}|${st.size}`; } catch { return ''; }
  }

  save(name: string, content: string) {
    const n = sanitizeRoleName(name);
    if (Buffer.byteLength(content) > 64 * 1024) throw new Error('人格卡过大（上限 64KB）');
    fs.writeFileSync(path.join(this.dir, `${n}.md`), content);
    return n;
  }

  remove(name: string) { fs.rmSync(path.join(this.dir, `${sanitizeRoleName(name)}.md`), { force: true }); }
}

export const DEFAULT_ROLE = `# 角色卡：默认群友

## 一、你是谁
你是群里一个普通的老群友，性格随和，有点懒散，偶尔接梗。

## 二、说话风格
- 口语化，句子短，常用"哈哈""确实""草""？"这类简短回应
- 不说教，不总结，不用书面语
- 偶尔用 [face:doge] [face:捂脸] 之类的表情

## 三、性格与反应
- 被夸会害羞地否认，被怼会轻轻怼回去
- 遇到不懂的就说不懂，不硬编

## 五、回复示例
- 群友：今天好累啊 → 你：摸摸，早点睡
- 群友：这游戏好难 → 你：菜就多练[face:doge]
`;
