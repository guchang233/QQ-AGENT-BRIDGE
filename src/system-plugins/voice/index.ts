import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { definePlugin, z } from '../../sdk.ts';
import type { StoredMessage } from '../../store/db.ts';

/**
 * 语音收发：
 * - TTS（文字转语音）：edge（微软 Edge 在线朗读，免配置）/ openai（兼容 /audio/speech 的服务）/ http（自定义 GET 接口）/ command（本地命令，如 piper）
 * - STT（语音转文字）：qq（QQ 自带转写）/ openai（兼容 /audio/transcriptions，如 Whisper）/ off
 * - 自动转写：收到语音后把文字追加到消息里，Agent 读消息时直接看到「[语音#ref] 转写：…」
 */
export default definePlugin({
  name: 'voice',
  displayName: '语音',
  version: '1.0.0',
  description: '文字转语音发送（Edge TTS / 自定义 TTS）与语音转文字',
  config: {
    ttsProvider: { type: 'select', options: ['edge', 'openai', 'http', 'command'], default: 'edge', description: 'TTS 引擎', group: '文字转语音' },
    edgeVoice: { type: 'string', default: 'zh-CN-XiaoxiaoNeural', description: 'Edge 音色（如 zh-CN-XiaoyiNeural、zh-CN-YunxiNeural，用 /音色 查看）', group: '文字转语音' },
    edgeRate: { type: 'string', default: '+0%', description: 'Edge 语速（如 +10%、-20%）', group: '文字转语音' },
    edgePitch: { type: 'string', default: '+0Hz', description: 'Edge 音调（如 +5Hz）', group: '文字转语音' },
    edgeVolume: { type: 'string', default: '+0%', description: 'Edge 音量', group: '文字转语音' },
    openaiBaseUrl: { type: 'string', default: 'https://api.openai.com/v1', description: 'OpenAI 兼容 TTS 地址', group: '文字转语音' },
    openaiApiKey: { type: 'secret', default: '', description: 'OpenAI 兼容 TTS 的 API Key', group: '文字转语音' },
    openaiModel: { type: 'string', default: 'gpt-4o-mini-tts', description: 'TTS 模型', group: '文字转语音' },
    openaiVoice: { type: 'string', default: 'alloy', description: 'TTS 音色', group: '文字转语音' },
    httpUrl: { type: 'string', default: '', description: '自定义 HTTP TTS：GET 地址模板，可用 {text} {voice}，返回音频', group: '文字转语音' },
    command: { type: 'string', default: '', description: '本地命令模板：可用 {out}（输出文件）{voice}；文本通过 stdin 传入。例：piper --model zh.onnx --output_file {out}', group: '文字转语音' },
    maxChars: { type: 'int', default: 300, description: '单条语音最多字数', group: '文字转语音' },
    sttProvider: { type: 'select', options: ['qq', 'openai', 'off'], default: 'qq', description: '语音转文字引擎', group: '语音转文字' },
    sttBaseUrl: { type: 'string', default: 'https://api.openai.com/v1', description: 'OpenAI 兼容转写地址', group: '语音转文字' },
    sttApiKey: { type: 'secret', default: '', description: '转写 API Key', group: '语音转文字' },
    sttModel: { type: 'string', default: 'whisper-1', description: '转写模型', group: '语音转文字' },
    autoTranscribe: { type: 'bool', default: true, description: '收到语音自动转写并附在消息后', group: '语音转文字' },
  },
  setup(ctx) {
    const bridge = ctx.bridge;
    const cacheDir = path.join(ctx.dataDir, 'tts');
    fs.mkdirSync(cacheDir, { recursive: true });

    // ------------------------------------------------------------ TTS
    async function synthesize(text: string, voice?: string): Promise<string> {
      const c = ctx.config;
      const t = text.trim();
      if (!t) throw new Error('文本为空');
      if ([...t].length > c.maxChars) throw new Error(`文本过长（上限 ${c.maxChars} 字）`);
      const key = crypto.createHash('sha1').update(JSON.stringify([c.ttsProvider, voice ?? '', t, c.edgeVoice, c.edgeRate, c.edgePitch, c.openaiVoice])).digest('hex').slice(0, 16);
      const out = path.join(cacheDir, `${key}.mp3`);
      if (fs.existsSync(out) && fs.statSync(out).size > 0) return out;

      if (c.ttsProvider === 'edge') {
        const { MsEdgeTTS, OUTPUT_FORMAT } = await import('msedge-tts');
        const tts = new MsEdgeTTS();
        try {
          await tts.setMetadata(voice || c.edgeVoice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
          const { audioStream } = tts.toStream(t, { rate: c.edgeRate, pitch: c.edgePitch, volume: c.edgeVolume });
          const chunks: Buffer[] = [];
          await new Promise<void>((resolve, reject) => {
            audioStream.on('data', (d: Buffer) => chunks.push(d));
            audioStream.on('end', () => resolve());
            audioStream.on('close', () => resolve());
            audioStream.on('error', reject);
          });
          const buf = Buffer.concat(chunks);
          if (!buf.length) throw new Error('Edge TTS 返回空音频（网络不可达或音色无效）');
          fs.writeFileSync(out, buf);
        } finally { tts.close(); }
      } else if (c.ttsProvider === 'openai') {
        if (!c.openaiApiKey) throw new Error('未配置 TTS API Key');
        const res = await fetch(`${c.openaiBaseUrl.replace(/\/+$/, '')}/audio/speech`, {
          method: 'POST',
          headers: { authorization: `Bearer ${c.openaiApiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: c.openaiModel, voice: voice || c.openaiVoice, input: t, response_format: 'mp3' }),
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) throw new Error(`TTS 接口错误 HTTP ${res.status}：${(await res.text()).slice(0, 200)}`);
        fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
      } else if (c.ttsProvider === 'http') {
        if (!c.httpUrl) throw new Error('未配置 HTTP TTS 地址');
        const url = c.httpUrl.replace('{text}', encodeURIComponent(t)).replace('{voice}', encodeURIComponent(voice ?? ''));
        const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) throw new Error(`TTS 接口错误 HTTP ${res.status}`);
        fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
      } else {
        if (!c.command) throw new Error('未配置本地 TTS 命令');
        const cmd = c.command.replace('{out}', `"${out}"`).replace('{voice}', voice ?? '');
        await new Promise<void>((resolve, reject) => {
          const p = spawn(cmd, { shell: true });
          let err = '';
          p.stderr.on('data', (d) => (err += d));
          p.on('error', reject);
          p.on('close', (code) => (code === 0 && fs.existsSync(out) ? resolve() : reject(new Error(`TTS 命令失败（${code}）：${err.slice(-300)}`))));
          p.stdin.end(t);
        });
      }
      return out;
    }

    async function speak(caller: any, conv: string, text: string, voice?: string) {
      const file = await synthesize(text, voice);
      const r = await bridge.send(caller, conv, [{ type: 'record', data: { file: `base64://${fs.readFileSync(file).toString('base64')}` } }]);
      return r.messageIds;
    }

    // ------------------------------------------------------------ STT
    async function transcribe(m: StoredMessage): Promise<string> {
      const c = ctx.config;
      if (c.sttProvider === 'off') throw new Error('语音转文字已关闭');
      if (c.sttProvider === 'qq') {
        const r: any = await bridge.bot.call('fetch_ptt_text', { message_id: Number(m.msgId) });
        const text = r?.text ?? (typeof r === 'string' ? r : '');
        if (!text) throw new Error('QQ 未返回转写结果');
        return text;
      }
      if (!c.sttApiKey) throw new Error('未配置转写 API Key');
      const seg = m.segments.find((s) => s.type === 'record');
      if (!seg) throw new Error('该消息不是语音');
      const ref = bridge.media.register(seg, m.conv, m.msgId);
      const { buf } = await bridge.media.fetch(ref);
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(buf)], { type: 'audio/mpeg' }), 'voice.mp3');
      form.append('model', c.sttModel);
      const res = await fetch(`${c.sttBaseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
        method: 'POST', headers: { authorization: `Bearer ${c.sttApiKey}` }, body: form, signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`转写接口错误 HTTP ${res.status}：${(await res.text()).slice(0, 200)}`);
      return String(((await res.json()) as any).text ?? '');
    }

    function attachTranscript(m: StoredMessage, text: string) {
      const t = text.replace(/\s+/g, ' ').trim();
      if (!t || m.text.includes('转写：')) return;
      m.text = m.text.replace(/\[语音(#[0-9a-f]+)?\]/, (s) => `${s}（转写：${t}）`);
      bridge.store.setMessageText(m.conv, m.msgId, m.text);
    }

    if (ctx.config.autoTranscribe && ctx.config.sttProvider !== 'off') {
      ctx.on('message', async (m: StoredMessage) => {
        if (!m.segments.some((s) => s.type === 'record')) return;
        try { attachTranscript(m, await transcribe(m)); } catch (e: any) { ctx.logger.debug(`自动转写失败：${e.message}`); }
      });
    }

    // ------------------------------------------------------------ 命令
    ctx.command(['说', 'tts'], async (e) => {
      if (!e.argText) return e.reply('用法：/说 要朗读的内容');
      await speak({ kind: 'plugin', name: 'plugin:voice' }, e.conv, e.argText);
    }, { desc: '把文字转成语音发出', usage: '<文本>' });

    ctx.command(['音色', 'voices'], async (e) => {
      const { MsEdgeTTS } = await import('msedge-tts');
      const tts = new MsEdgeTTS();
      const list = (await tts.getVoices()).filter((v) => v.Locale.startsWith(e.argText || 'zh-'));
      tts.close();
      await e.reply(list.slice(0, 40).map((v) => `${v.ShortName}（${v.Gender === 'Female' ? '女' : '男'}）`).join('\n') || '没有匹配的音色');
    }, { desc: '列出 Edge TTS 音色', usage: '[语言前缀，如 zh-CN]' });

    ctx.command(['转文字'], async (e) => {
      const reply = e.segments.find((s) => s.type === 'reply');
      const m = reply ? bridge.store.getMessage(String(reply.data.id)) : undefined;
      if (!m?.segments.some((s) => s.type === 'record')) return e.reply('请回复一条语音消息使用 /转文字');
      const t = await transcribe(m);
      attachTranscript(m, t);
      await e.reply(t || '（没有识别到文字）');
    }, { desc: '把语音转成文字（回复语音使用）' });

    // ------------------------------------------------------------ Agent 工具
    ctx.tool({
      name: 'qq_speak', title: '发送语音（TTS）', tier: 'send', selfAudited: true,
      description: '把文字合成语音并发送。适合打招呼、讲故事、强调语气；内容不要太长。',
      input: {
        conv: z.string().describe('group:群号 / private:QQ'),
        text: z.string().min(1).describe('要朗读的文字（纯文本，不支持内联标记）'),
        voice: z.string().optional().describe('音色，留空用默认（Edge 如 zh-CN-YunxiNeural）'),
      },
      handler: async ({ conv, text, voice }, caller) => `语音已发送，消息 ID：${(await speak(caller, conv, text, voice)).join(', ')}`,
    });

    ctx.tool({
      name: 'qq_transcribe', title: '语音转文字', tier: 'read', readOnly: true,
      description: '把一条语音消息转成文字（[语音#ref] 所在消息的 ID）。',
      input: { messageId: z.union([z.string(), z.number()]).transform(String) },
      handler: async ({ messageId }) => {
        const m = bridge.store.getMessage(messageId);
        if (!m) throw new Error('找不到该消息');
        const t = await transcribe(m);
        attachTranscript(m, t);
        return t || '（没有识别到文字）';
      },
    });

    ctx.tool({
      name: 'qq_tts_voices', title: 'TTS 音色列表', tier: 'read', readOnly: true,
      description: '列出 Edge TTS 可用音色（按语言前缀过滤，默认 zh-）。',
      input: { locale: z.string().default('zh-') },
      handler: async ({ locale }) => {
        const { MsEdgeTTS } = await import('msedge-tts');
        const tts = new MsEdgeTTS();
        try { return (await tts.getVoices()).filter((v) => v.Locale.startsWith(locale)).map((v) => `${v.ShortName} ${v.Gender} ${v.FriendlyName}`).join('\n'); } finally { tts.close(); }
      },
    });

    ctx.route('POST', 'preview', async (req) => {
      const file = await synthesize(String(req.body?.text ?? '你好，我是 QQ 机器人。'), req.body?.voice);
      return { path: file, size: fs.statSync(file).size };
    });

    ctx.provide({ synthesize, speak, transcribe });
  },
});
