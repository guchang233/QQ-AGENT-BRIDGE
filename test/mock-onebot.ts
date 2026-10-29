/**
 * Mock OneBot v11 服务端（WS Universal + HTTP），用于离线开发与测试。
 * 运行：npm run mock   （WS :13001，HTTP :13000，token: mock）
 */
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

export interface MockOptions { wsPort?: number; httpPort?: number; token?: string; selfId?: number }

export class MockOneBot {
  calls: { action: string; params: any }[] = [];
  private msgSeq = 1000;
  private wss?: WebSocketServer;
  private httpServer?: http.Server;
  private clients = new Set<WebSocket>();
  selfId: number;
  token: string;
  handlers: Record<string, (p: any) => any> = {};

  constructor(private opts: MockOptions = {}) {
    this.selfId = opts.selfId ?? 10000;
    this.token = opts.token ?? 'mock';
    this.handlers = {
      get_login_info: () => ({ user_id: this.selfId, nickname: '测试机器人' }),
      get_status: () => ({ online: true, good: true }),
      get_version_info: () => ({ app_name: 'MockOneBot', app_version: '1.0' }),
      get_group_list: () => [{ group_id: 111, group_name: '测试群', member_count: 3 }, { group_id: 222, group_name: '另一个群', member_count: 5 }],
      get_friend_list: () => [{ user_id: 20001, nickname: '小明', remark: '明哥' }],
      get_group_member_list: (p) => [{ user_id: 20001, nickname: '小明', card: '群名片明', role: 'member' }, { user_id: this.selfId, nickname: '测试机器人', role: 'admin' }],
      fetch_sys_faces: () => [{ face_id: 14, name: '微笑' }, { face_id: 179, name: 'doge' }, { face_id: 999, name: '测试表情' }],
      send_group_msg: () => ({ message_id: ++this.msgSeq }),
      send_private_msg: () => ({ message_id: ++this.msgSeq }),
      send_msg: () => ({ message_id: ++this.msgSeq }),
      delete_msg: () => null,
      get_group_msg_history: (p) => ({ messages: [
        { message_id: 1, message_type: 'group', group_id: p.group_id, user_id: 20001, time: Math.floor(Date.now() / 1000) - 600, sender: { nickname: '小明', card: '' }, message: [{ type: 'text', data: { text: '历史消息1' } }] },
      ] }),
      get_qzone_feeds: () => ({ feeds: [{ tid: 't1', uin: 20001, content: '今天天气不错' }] }),
      send_qzone_msg: (p) => ({ tid: 'new-tid' }),
      get_image: () => ({ base64: PNG_1PX }),
    };
  }

  async start() {
    const wsPort = this.opts.wsPort ?? 13001;
    const httpPort = this.opts.httpPort ?? 13000;
    this.wss = new WebSocketServer({ port: wsPort, verifyClient: (info, cb) => {
      const auth = info.req.headers.authorization ?? '';
      const ok = !this.token || auth === `Bearer ${this.token}` || new URL(info.req.url ?? '/', 'http://x').searchParams.get('access_token') === this.token;
      ok ? cb(true) : cb(false, 401, 'Unauthorized');
    } });
    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      ws.send(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect', self_id: this.selfId, time: now() }));
      ws.on('message', async (buf) => {
        const req = JSON.parse(buf.toString());
        ws.send(JSON.stringify({ ...(await this.handle(req.action, req.params ?? {})), echo: req.echo }));
      });
      ws.on('close', () => this.clients.delete(ws));
    });
    this.httpServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        if (this.token && req.headers.authorization !== `Bearer ${this.token}`) { res.writeHead(401); res.end(JSON.stringify({ status: 'failed', retcode: 1401 })); return; }
        const action = (req.url ?? '/').replace(/^\//, '').split('?')[0];
        const r = await this.handle(action, body ? JSON.parse(body) : {});
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r));
      });
    });
    await new Promise<void>((r) => this.httpServer!.listen(httpPort, '127.0.0.1', r));
    return { wsUrl: `ws://127.0.0.1:${wsPort}`, httpUrl: `http://127.0.0.1:${httpPort}` };
  }

  async handle(action: string, params: any) {
    this.calls.push({ action, params });
    const h = this.handlers[action];
    if (!h) return { status: 'failed', retcode: 1404, wording: `mock 未实现 ${action}`, data: null };
    try { return { status: 'ok', retcode: 0, data: await h(params) }; } catch (e: any) { return { status: 'failed', retcode: 100, wording: e.message, data: null }; }
  }

  /** 推送一条群消息事件。 */
  pushGroupMessage(groupId: number, userId: number, message: any[], extra: any = {}) {
    const ev = { post_type: 'message', message_type: 'group', sub_type: 'normal', time: now(), self_id: this.selfId, group_id: groupId, user_id: userId,
      message_id: ++this.msgSeq, message, raw_message: '', sender: { user_id: userId, nickname: `用户${userId}`, card: '' }, ...extra };
    this.broadcast(ev);
    return ev.message_id;
  }

  pushPrivateMessage(userId: number, message: any[]) {
    const ev = { post_type: 'message', message_type: 'private', sub_type: 'friend', time: now(), self_id: this.selfId, user_id: userId,
      message_id: ++this.msgSeq, message, raw_message: '', sender: { user_id: userId, nickname: `用户${userId}` } };
    this.broadcast(ev);
    return ev.message_id;
  }

  broadcast(ev: any) { for (const c of this.clients) c.send(JSON.stringify(ev)); }

  async stop() {
    for (const c of this.clients) c.terminate();
    await new Promise<void>((r) => this.wss ? this.wss.close(() => r()) : r());
    await new Promise<void>((r) => this.httpServer ? this.httpServer.close(() => r()) : r());
  }
}

const now = () => Math.floor(Date.now() / 1000);
export const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// 直接运行时启动常驻 mock，并每 20 秒推送一条示例消息
if (process.argv[1] && /mock-onebot\.ts$/.test(process.argv[1])) {
  const m = new MockOneBot();
  const ep = await m.start();
  console.log(`Mock OneBot 已启动 ${ep.wsUrl} ${ep.httpUrl} token=mock`);
  let i = 0;
  setInterval(() => {
    m.pushGroupMessage(111, 20001, [{ type: 'text', data: { text: `示例群消息 ${++i}` } }]);
    if (i % 3 === 0) m.pushGroupMessage(111, 20001, [{ type: 'at', data: { qq: String(m.selfId) } }, { type: 'text', data: { text: ' 机器人在吗？' } }, { type: 'image', data: { file: 'abc.png', url: '', summary: '' } }]);
  }, 20000);
}
