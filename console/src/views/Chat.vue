<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  NInput, NButton, NAvatar, NBadge, NEmpty, NPopover, NIcon, NTabs, NTabPane, NScrollbar, NTag, NDropdown, NSpace, NTooltip, useMessage, useDialog,
} from 'naive-ui';
import { HappyOutline, ImageOutline, AttachOutline, SendOutline, ArrowBackOutline, CloudDownloadOutline, CheckmarkDoneOutline } from '@vicons/ionicons5';
import { api, upload, onPush, avatarOf, userAvatar, fmtTime, fmtFull, type Msg } from '../api';
import MessageContent from '../components/MessageContent.vue';
import EmojiPicker from '../components/EmojiPicker.vue';

const route = useRoute();
const router = useRouter();
const msg = useMessage();
const dialog = useDialog();

const convs = ref<any[]>([]);
const contacts = ref<{ groups: any[]; friends: any[] }>({ groups: [], friends: [] });
const search = ref('');
const current = computed(() => (route.params.conv as string) || '');
const messages = ref<Msg[]>([]);
const loadingOlder = ref(false);
const noMore = ref(false);
const draft = ref('');
const replyTo = ref<Msg | null>(null);
const sending = ref(false);
const scroller = ref<HTMLElement>();
const narrow = ref(window.innerWidth < 760);
const onResize = () => { narrow.value = window.innerWidth < 760; };

const currentInfo = computed(() => convs.value.find((c) => c.conv === current.value));
const filteredConvs = computed(() => convs.value.filter((c) => !search.value || (c.name ?? '').includes(search.value) || c.conv.includes(search.value)));
const filteredGroups = computed(() => contacts.value.groups.filter((g) => !search.value || g.name.includes(search.value) || g.id.includes(search.value)));
const filteredFriends = computed(() => contacts.value.friends.filter((f) => !search.value || `${f.remark}${f.nickname}${f.id}`.includes(search.value)));

async function loadConvs() { convs.value = await api('/api/conversations'); }
async function loadContacts() { contacts.value = await api('/api/contacts'); }

async function openConv(conv: string, fromServer = false) {
  noMore.value = false;
  messages.value = await api(`/api/conv/${conv}/messages?limit=50${fromServer ? '&server=1' : ''}`);
  if (!messages.value.length && !fromServer) messages.value = await api(`/api/conv/${conv}/messages?limit=50&server=1`);
  api(`/api/conv/${conv}/read`, { method: 'POST' }).then(loadConvs);
  await nextTick(); scrollBottom();
}

async function loadOlder() {
  if (loadingOlder.value || noMore.value || !messages.value.length) return;
  loadingOlder.value = true;
  const el = scroller.value!; const h0 = el.scrollHeight;
  const older: Msg[] = await api(`/api/conv/${current.value}/messages?limit=40&before=${messages.value[0].ts}`);
  if (!older.length) noMore.value = true;
  messages.value = [...older, ...messages.value];
  await nextTick(); el.scrollTop = el.scrollHeight - h0;
  loadingOlder.value = false;
}

function scrollBottom() { const el = scroller.value; if (el) el.scrollTop = el.scrollHeight; }
function onScroll() { if (scroller.value && scroller.value.scrollTop < 60) loadOlder(); }

async function send() {
  const text = draft.value.trim();
  if (!text || !current.value) return;
  sending.value = true;
  try {
    await api(`/api/conv/${current.value}/send`, { body: { message: text, replyTo: replyTo.value?.msgId } });
    draft.value = ''; replyTo.value = null;
  } catch (e: any) { msg.error(e.message); } finally { sending.value = false; }
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
}

function insert(token: string) { draft.value += token; }

async function attach(files: FileList | File[] | null, kind: 'image' | 'file') {
  for (const f of Array.from(files ?? [])) {
    try {
      const r = await upload(f);
      const isImg = r.mime.startsWith('image/');
      insert(isImg && kind === 'image' ? `[image:${r.path}]` : `[file:${r.path}|name=${f.name}]`);
    } catch (e: any) { msg.error(e.message); }
  }
}
function pickFile(kind: 'image' | 'file') {
  const input = document.createElement('input');
  input.type = 'file'; input.multiple = true;
  if (kind === 'image') input.accept = 'image/*';
  input.onchange = () => attach(input.files, kind);
  input.click();
}
function onPaste(e: ClipboardEvent) {
  const files = Array.from(e.clipboardData?.files ?? []);
  if (files.length) { e.preventDefault(); attach(files, 'image'); }
}
function onDrop(e: DragEvent) { e.preventDefault(); attach(e.dataTransfer?.files ?? null, 'image'); }

const menuFor = (m: Msg) => [
  { label: '回复', key: 'reply' },
  { label: '贴表情 👍', key: 'react' },
  ...(/\[图片(表情)?#/.test(m.text) ? [{ label: '收藏为表情包', key: 'collect' }] : []),
  { label: '复制文本', key: 'copy' },
  { label: '撤回', key: 'recall' },
];
async function onMenu(key: string, m: Msg) {
  try {
    if (key === 'reply') replyTo.value = m;
    if (key === 'react') { await api(`/api/messages/${m.msgId}/react`, { body: { emoji: '赞' } }); msg.success('已贴表情'); }
    if (key === 'copy') { await navigator.clipboard.writeText(m.text); msg.success('已复制'); }
    if (key === 'collect') {
      const ref = /\[图片(?:表情)?#([0-9a-f]{8})/.exec(m.text)?.[1];
      const s = await api('/api/stickers', { body: { source: ref, remark: '' } });
      msg.success(`已收藏为 #${s.id}`);
    }
    if (key === 'recall') dialog.warning({ title: '撤回消息', content: '确定撤回这条消息？', positiveText: '撤回', negativeText: '取消', onPositiveClick: async () => { await api(`/api/messages/${m.msgId}/recall`, { method: 'POST' }); m.recalled = true; } });
  } catch (e: any) { msg.error(e.message); }
}

function quote(id: string) {
  const el = document.getElementById(`m-${id}`);
  if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1200); }
}

const off = onPush((type, data) => {
  if (type === 'message') {
    const m = data as Msg;
    if (m.conv === current.value) {
      const el = scroller.value;
      const atBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 120;
      if (!messages.value.some((x) => x.seq === m.seq)) messages.value.push(m);
      if (atBottom) nextTick(scrollBottom);
      api(`/api/conv/${m.conv}/read`, { method: 'POST' }).catch(() => {});
    }
    clearTimeout(convTimer); convTimer = setTimeout(loadConvs, 400);
  }
  if (type === 'contacts') loadContacts();
});
let convTimer: any;

watch(current, (c) => { if (c) openConv(c); else messages.value = []; replyTo.value = null; });
onMounted(async () => { window.addEventListener('resize', onResize); await Promise.all([loadConvs(), loadContacts()]); if (current.value) openConv(current.value); });
onUnmounted(() => { off(); window.removeEventListener('resize', onResize); });

const showList = computed(() => !narrow.value || !current.value);
const showChat = computed(() => !narrow.value || !!current.value);
</script>

<template>
  <div class="chat">
    <div v-show="showList" class="side">
      <n-input v-model:value="search" placeholder="搜索会话 / 群 / 好友" clearable size="small" style="margin-bottom: 8px" />
      <n-tabs type="line" size="small" animated>
        <n-tab-pane name="recent" tab="最近">
          <n-scrollbar style="max-height: calc(100vh - 200px)">
            <n-empty v-if="!filteredConvs.length" description="还没有会话" style="margin-top: 40px" />
            <div v-for="c in filteredConvs" :key="c.conv" class="conv" :class="{ active: c.conv === current }" @click="router.push(`/chat/${c.conv}`)">
              <n-badge :value="c.unread" :max="99" :type="c.mentions ? 'error' : 'info'"><n-avatar round :size="38" :src="avatarOf(c.conv, 40)" /></n-badge>
              <div class="meta">
                <div class="row1"><span class="name">{{ c.name || c.conv }}</span><span class="time">{{ c.lastTs ? fmtTime(c.lastTs) : '' }}</span></div>
                <div class="row2"><n-tag v-if="!c.allowed" size="tiny" type="warning" :bordered="false">未允许</n-tag><span v-if="c.mentions" class="mention">[有人@我]</span>{{ c.lastSender ? `${c.lastSender}: ` : '' }}{{ c.lastText }}</div>
              </div>
            </div>
          </n-scrollbar>
        </n-tab-pane>
        <n-tab-pane name="groups" :tab="`群 ${contacts.groups.length}`">
          <n-scrollbar style="max-height: calc(100vh - 200px)">
            <div v-for="g in filteredGroups" :key="g.id" class="conv" @click="router.push(`/chat/group:${g.id}`)">
              <n-avatar round :size="34" :src="avatarOf(`group:${g.id}`, 40)" />
              <div class="meta"><div class="name">{{ g.name }}</div><div class="row2">{{ g.id }} · {{ g.memberCount ?? '?' }} 人</div></div>
            </div>
          </n-scrollbar>
        </n-tab-pane>
        <n-tab-pane name="friends" :tab="`好友 ${contacts.friends.length}`">
          <n-scrollbar style="max-height: calc(100vh - 200px)">
            <div v-for="f in filteredFriends" :key="f.id" class="conv" @click="router.push(`/chat/private:${f.id}`)">
              <n-avatar round :size="34" :src="userAvatar(f.id)" />
              <div class="meta"><div class="name">{{ f.remark || f.nickname }}</div><div class="row2">{{ f.id }}{{ f.remark ? ` · ${f.nickname}` : '' }}</div></div>
            </div>
          </n-scrollbar>
        </n-tab-pane>
      </n-tabs>
    </div>

    <div v-show="showChat" class="main" @dragover.prevent @drop="onDrop">
      <n-empty v-if="!current" description="选择一个会话开始聊天" style="margin: auto" />
      <template v-else>
        <div class="top">
          <n-button v-if="narrow" quaternary circle size="small" @click="router.push('/chat')"><template #icon><n-icon :component="ArrowBackOutline" /></template></n-button>
          <n-avatar round :size="30" :src="avatarOf(current, 40)" />
          <div class="tname">{{ currentInfo?.name || current }} <span class="sub">{{ current }}</span></div>
          <n-space style="margin-left: auto" :size="4">
            <n-tooltip><template #trigger><n-button quaternary circle size="small" @click="openConv(current, true)"><template #icon><n-icon :component="CloudDownloadOutline" /></template></n-button></template>从服务器拉取历史</n-tooltip>
            <n-tooltip><template #trigger><n-button quaternary circle size="small" @click="api(`/api/conv/${current}/read`, { method: 'POST' }).then(loadConvs)"><template #icon><n-icon :component="CheckmarkDoneOutline" /></template></n-button></template>标为已读</n-tooltip>
          </n-space>
        </div>

        <div ref="scroller" class="msgs" @scroll="onScroll">
          <div v-if="noMore" class="hint">没有更早的消息了</div>
          <div v-for="m in messages" :id="`m-${m.msgId}`" :key="m.seq" class="msg" :class="{ self: m.isSelf, mention: m.mentioned }">
            <n-avatar round :size="34" :src="userAvatar(m.senderId)" class="av" />
            <div class="body">
              <div class="who">{{ m.isSelf ? '我' : m.senderName }} <span class="sub">{{ m.senderId }} · <span :title="fmtFull(m.ts)">{{ fmtTime(m.ts) }}</span> · #{{ m.msgId }}</span></div>
              <n-dropdown trigger="click" :options="menuFor(m)" @select="(k: string) => onMenu(k, m)">
                <div class="bubble" :class="{ recalled: m.recalled }"><MessageContent :text="m.text" @quote="quote" /><span v-if="m.recalled" class="rc">（已撤回）</span></div>
              </n-dropdown>
            </div>
          </div>
        </div>

        <div class="compose">
          <div v-if="replyTo" class="replying">回复 {{ replyTo.senderName }}：{{ replyTo.text.slice(0, 50) }} <a @click="replyTo = null">✕</a></div>
          <div class="tools">
            <n-popover trigger="click" placement="top-start"><template #trigger><n-button quaternary circle size="small" title="表情"><template #icon><n-icon :component="HappyOutline" /></template></n-button></template><EmojiPicker @pick="insert" /></n-popover>
            <n-button quaternary circle size="small" title="图片" @click="pickFile('image')"><template #icon><n-icon :component="ImageOutline" /></template></n-button>
            <n-button quaternary circle size="small" title="文件" @click="pickFile('file')"><template #icon><n-icon :component="AttachOutline" /></template></n-button>
            <span class="tip">Enter 发送 · Shift+Enter 换行 · 可粘贴/拖入图片 · 支持 [at:QQ] [face:名] 等标记</span>
          </div>
          <div class="input-row">
            <n-input v-model:value="draft" type="textarea" :autosize="{ minRows: 2, maxRows: 8 }" placeholder="输入消息…" @keydown="onKey" @paste="onPaste" />
            <n-button type="primary" :loading="sending" :disabled="!draft.trim()" @click="send"><template #icon><n-icon :component="SendOutline" /></template>发送</n-button>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.chat { display: flex; gap: 12px; height: calc(100vh - 85px); }
.side { width: 280px; flex-shrink: 0; display: flex; flex-direction: column; }
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; border: 1px solid rgba(128,128,128,.2); border-radius: 8px; overflow: hidden; }
.conv { display: flex; gap: 10px; align-items: center; padding: 8px; border-radius: 6px; cursor: pointer; }
.conv:hover { background: rgba(128,128,128,.08); }
.conv.active { background: rgba(18,183,245,.14); }
.meta { min-width: 0; flex: 1; }
.row1 { display: flex; justify-content: space-between; }
.name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.time { font-size: 11px; opacity: .5; flex-shrink: 0; margin-left: 6px; }
.row2 { font-size: 12px; opacity: .6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mention { color: #e74c3c; margin-right: 2px; }
.top { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid rgba(128,128,128,.2); }
.tname { font-weight: 600; }
.sub { font-size: 11px; opacity: .5; font-weight: normal; }
.msgs { flex: 1; overflow-y: auto; padding: 12px; }
.hint { text-align: center; font-size: 12px; opacity: .5; margin-bottom: 8px; }
.msg { display: flex; gap: 8px; margin-bottom: 14px; transition: background .3s; border-radius: 6px; }
.msg.self { flex-direction: row-reverse; }
.msg.self .who { text-align: right; }
.msg.flash { background: rgba(18,183,245,.18); }
.body { max-width: 72%; min-width: 0; }
.who { font-size: 12px; opacity: .75; margin-bottom: 3px; }
.bubble { display: inline-block; padding: 7px 11px; border-radius: 10px; background: rgba(128,128,128,.12); cursor: pointer; max-width: 100%; line-height: 1.55; }
.msg.self .bubble { background: rgba(18,183,245,.22); float: right; }
.msg.mention .bubble { box-shadow: 0 0 0 1px rgba(231,76,60,.5) inset; }
.bubble.recalled { opacity: .5; text-decoration: line-through; }
.rc { font-size: 11px; }
.compose { border-top: 1px solid rgba(128,128,128,.2); padding: 8px 12px; }
.replying { font-size: 12px; opacity: .8; padding: 4px 8px; background: rgba(128,128,128,.1); border-radius: 4px; margin-bottom: 6px; }
.replying a { cursor: pointer; margin-left: 6px; }
.tools { display: flex; align-items: center; gap: 2px; margin-bottom: 4px; }
.tip { font-size: 11px; opacity: .45; margin-left: 8px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.input-row { display: flex; gap: 8px; align-items: flex-end; }
@media (max-width: 760px) { .side { width: 100%; } .body { max-width: 85%; } .tip { display: none; } }
</style>
