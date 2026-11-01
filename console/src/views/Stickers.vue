<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { NCard, NInput, NButton, NSpace, NEmpty, NPopconfirm, NTag, NText, useMessage } from 'naive-ui';
import { api, upload } from '../api';
import PageHint from '../components/PageHint.vue';

const msg = useMessage();
const list = ref<any[]>([]);
const q = ref('');
const editingId = ref(0);
const url = ref('');

async function load() { list.value = await api(`/api/stickers?q=${encodeURIComponent(q.value)}`); }
async function save(s: any) { await api(`/api/stickers/${s.id}`, { method: 'PATCH', body: { remark: s.remark, tags: s.tags, note: s.note } }); msg.success('已保存'); }
const syncing = ref(false);
async function sync() {
  syncing.value = true;
  try { const r = await api('/api/p/stickers/sync', { method: 'POST' }); msg.success(`同步完成：新增 ${r.added} 张`); load(); }
  catch (e: any) { msg.error(e.status === 404 ? '表情包插件未启用' : e.message); } finally { syncing.value = false; }
}
async function del(s: any) { await api(`/api/stickers/${s.id}`, { method: 'DELETE' }); load(); }
async function addFiles() {
  const input = document.createElement('input');
  input.type = 'file'; input.multiple = true; input.accept = 'image/*';
  input.onchange = async () => {
    for (const f of Array.from(input.files ?? [])) {
      try { const r = await upload(f); await api('/api/stickers', { body: { source: r.path, remark: f.name.replace(/\.[^.]+$/, '') } }); } catch (e: any) { msg.error(`${f.name}：${e.message}`); }
    }
    load();
  };
  input.click();
}
async function addUrl() {
  if (!url.value) return;
  try { await api('/api/stickers', { body: { source: url.value } }); url.value = ''; load(); } catch (e: any) { msg.error(e.message); }
}
onMounted(load);
</script>

<template>
  <div class="page">
    <div class="toolbar">
      <n-input v-model:value="q" size="small" placeholder="按备注/标签搜索" clearable style="width: 200px" @keyup.enter="load" @clear="() => { q = ''; load(); }" />
      <n-button size="small" @click="load">搜索</n-button>
      <span class="grow" />
      <n-input v-model:value="url" size="small" placeholder="粘贴图片 URL" style="width: 200px" @keyup.enter="addUrl" />
      <n-button size="small" @click="addUrl">添加</n-button>
      <n-button size="small" :loading="syncing" @click="sync">同步 QQ 收藏</n-button>
      <n-button size="small" type="primary" @click="addFiles">上传图片</n-button>
    </div>
    <PageHint text="人和 Agent 共用这个表情包库。备注写得越清楚，Agent 越会用。">
      Agent 通过 qq_list_stickers / qq_send_sticker 调用，消息中用 [sticker:ID] 发送。聊天页的消息菜单可直接「收藏为表情包」。
    </PageHint>
    <n-card v-if="!list.length" size="small"><span class="hint">还没有表情包。可以上传图片，或同步 QQ 收藏。</span></n-card>
    <div class="grid">
      <div v-for="s in list" :key="s.id" class="item">
        <img :src="`/api/stickers/${s.id}/image`" class="img" :alt="s.remark || `表情 ${s.id}`" loading="lazy" />
        <div class="head">
          <span class="hint">#{{ s.id }}<template v-if="s.source === 'qq'"> · QQ收藏</template><template v-else-if="s.source === 'auto'"> · 自动</template> · 用过 {{ s.uses }} 次</span>
          <n-button size="tiny" quaternary @click="editingId = editingId === s.id ? 0 : s.id">{{ editingId === s.id ? '完成' : '编辑' }}</n-button>
        </div>
        <n-input v-model:value="s.remark" size="tiny" placeholder="备注（如：无语、狗头）" @blur="save(s)" />
        <template v-if="editingId === s.id">
          <n-input v-model:value="s.note" size="tiny" placeholder="理解（AI 看图后的描述）" @blur="save(s)" />
          <n-input v-model:value="s.tags" size="tiny" placeholder="标签，逗号分隔" @blur="save(s)" />
          <n-popconfirm @positive-click="del(s)"><template #trigger><n-button size="tiny" quaternary type="error" block>删除</n-button></template>确定删除？</n-popconfirm>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(136px, 1fr)); gap: 8px; align-items: start; }
.item { display: flex; flex-direction: column; gap: 4px; padding: 6px; border: 1px solid rgba(128,128,128,.18); border-radius: 6px; }
.img { width: 100%; height: 104px; object-fit: contain; border-radius: 4px; background: rgba(128,128,128,.08); }
.head { display: flex; align-items: center; justify-content: space-between; }
</style>
