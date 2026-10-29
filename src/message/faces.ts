/**
 * QQ 系统表情名 ↔ ID。启动后用 fetch_sys_faces 拉取的完整目录覆盖；
 * 下面是离线兜底（常用表情）。
 */
const FALLBACK: Record<number, string> = {
  0: '惊讶', 1: '撇嘴', 2: '色', 3: '发呆', 4: '得意', 5: '流泪', 6: '害羞', 7: '闭嘴', 8: '睡', 9: '大哭', 10: '尴尬',
  11: '发怒', 12: '调皮', 13: '呲牙', 14: '微笑', 15: '难过', 16: '酷', 18: '抓狂', 19: '吐', 20: '偷笑', 21: '可爱',
  22: '白眼', 23: '傲慢', 24: '饥饿', 25: '困', 26: '惊恐', 27: '流汗', 28: '憨笑', 29: '悠闲', 30: '奋斗', 31: '咒骂',
  32: '疑问', 33: '嘘', 34: '晕', 35: '折磨', 36: '衰', 37: '骷髅', 38: '敲打', 39: '再见', 41: '发抖', 42: '爱情',
  43: '跳跳', 49: '拥抱', 53: '蛋糕', 60: '咖啡', 63: '玫瑰', 64: '凋谢', 66: '爱心', 67: '心碎', 74: '太阳', 75: '月亮',
  76: '赞', 77: '踩', 78: '握手', 79: '胜利', 85: '飞吻', 86: '怄火', 89: '西瓜', 96: '冷汗', 97: '擦汗', 98: '抠鼻',
  99: '鼓掌', 100: '糗大了', 101: '坏笑', 102: '左哼哼', 103: '右哼哼', 104: '哈欠', 105: '鄙视', 106: '委屈', 107: '快哭了',
  108: '阴险', 109: '左亲亲', 110: '吓', 111: '可怜', 112: '菜刀', 114: '篮球', 116: '示爱', 118: '抱拳', 119: '勾引',
  120: '拳头', 121: '差劲', 122: '爱你', 123: 'NO', 124: 'OK', 125: '转圈', 129: '挥手', 144: '喝彩', 147: '棒棒糖',
  171: '茶', 173: '泪奔', 174: '无奈', 175: '卖萌', 176: '小纠结', 177: '喷血', 178: '斜眼笑', 179: 'doge', 180: '惊喜',
  181: '骚扰', 182: '笑哭', 183: '我最美', 201: '点赞', 203: '托脸', 212: '托腮', 214: '啵啵', 219: '蹭一蹭', 222: '抱抱',
  227: '拍手', 232: '佛系', 240: '喷脸', 243: '甩头', 246: '加油抱抱', 262: '脑阔疼', 264: '捂脸', 265: '辣眼睛', 266: '哦哟',
  267: '头秃', 268: '问号脸', 269: '暗中观察', 270: 'emm', 271: '吃瓜', 272: '呵呵哒', 273: '我酸了', 277: '汪汪',
  281: '无眼笑', 282: '敬礼', 284: '面无表情', 285: '摸鱼', 287: '哦', 289: '睁眼', 290: '敲开心', 293: '摸锦鲤', 294: '期待',
  297: '拜谢', 298: '元宝', 299: '牛啊', 305: '右亲亲', 306: '牛气冲天', 307: '喵喵', 314: '仔细分析', 315: '加油',
  318: '崇拜', 319: '比心', 320: '庆祝', 322: '拒绝', 324: '吃糖', 326: '生气',
};

export interface FaceInfo { id: number; name: string; source: 'fallback' | 'qq' }

export class FaceTable {
  private byId = new Map<number, FaceInfo>();
  private byName = new Map<string, FaceInfo>();
  loadedFromQQ = false;

  constructor() {
    for (const [id, name] of Object.entries(FALLBACK)) this.add({ id: Number(id), name, source: 'fallback' });
  }

  private add(f: FaceInfo) {
    this.byId.set(f.id, f);
    this.byName.set(f.name.toLowerCase(), f);
  }

  /** 接受 fetch_sys_faces 的各种返回形状（数组 / {faces:[]} / 分组）。 */
  loadFromQQ(data: unknown) {
    const items: any[] = [];
    const walk = (v: any) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        const id = v.face_id ?? v.faceId ?? v.id ?? v.qsid ?? v.QSid;
        const name = v.name ?? v.desc ?? v.face_name ?? v.QDes ?? v.description;
        if (id !== undefined && name) items.push({ id: Number(id), name: String(name).replace(/^\//, '') });
        else Object.values(v).forEach(walk);
      }
    };
    walk(data);
    for (const it of items) if (Number.isFinite(it.id)) this.add({ id: it.id, name: it.name, source: 'qq' });
    if (items.length) this.loadedFromQQ = true;
    return items.length;
  }

  nameOf(id: number | string): string | undefined { return this.byId.get(Number(id))?.name; }

  /** 名称精确匹配，或数字 ID。 */
  resolve(nameOrId: string): number | undefined {
    const s = nameOrId.trim().replace(/^\//, '');
    if (/^\d+$/.test(s)) return Number(s);
    return this.byName.get(s.toLowerCase())?.id;
  }

  search(q: string, limit = 30): FaceInfo[] {
    const s = q.trim().toLowerCase();
    const all = [...this.byId.values()];
    if (!s) return all.slice(0, limit);
    const exact = all.filter((f) => f.name.toLowerCase() === s);
    const part = all.filter((f) => f.name.toLowerCase() !== s && (f.name.toLowerCase().includes(s) || String(f.id) === s));
    return [...exact, ...part].slice(0, limit);
  }

  all(): FaceInfo[] { return [...this.byId.values()].sort((a, b) => a.id - b.id); }
}
