<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { NCard, NInput, NButton, NSpace, NEmpty, NPopconfirm, NTag, NText, useMessage } from 'naive-ui';
import { api, upload } from '../api';

const msg = useMessage();
const list = ref<any[]>([]);
const q = ref('');
const url = ref('');

async function load() { list.value = await api(`/api/stickers?q=${encodeURIComponent(q.value)}`); }
async function save(s: any) { await api(`/api/stickers/${s.id}`, { method: 'PATCH', body: { remark: s.remark, tags: s.tags } }); msg.success('已保存'); }
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
  <n-space vertical :size="12">
    <n-space align="center">
      <n-input v-model:value="q" placeholder="按备注/标签搜索" clearable style="width: 220px" @keyup.enter="load" @clear="() => { q = ''; load(); }" />
      <n-button @click="load">搜索</n-button>
      <n-button type="primary" @click="addFiles">上传图片</n-button>
      <n-input v-model:value="url" placeholder="或粘贴图片 URL" style="width: 260px" @keyup.enter="addUrl" />
      <n-button @click="addUrl">添加</n-button>
    </n-space>
    <n-text depth="3" style="font-size: 12px">表情包库同时供人和 Agent 使用：Agent 通过 qq_list_stickers / qq_send_sticker 调用，消息中用 [sticker:ID] 发送。聊天页的消息菜单可直接「收藏为表情包」。备注越清楚，Agent 越会用。</n-text>
    <n-empty v-if="!list.length" description="还没有表情包" style="margin-top: 40px" />
    <div class="grid">
      <n-card v-for="s in list" :key="s.id" size="small" class="item">
        <template #cover><img :src="`/api/stickers/${s.id}/image`" class="img" /></template>
        <n-space vertical :size="4">
          <n-space justify="space-between" align="center"><n-tag size="small">#{{ s.id }}</n-tag><span style="font-size: 11px; opacity: .55">用过 {{ s.uses }} 次</span></n-space>
          <n-input v-model:value="s.remark" size="tiny" placeholder="备注（如：无语、狗头）" @blur="save(s)" />
          <n-input v-model:value="s.tags" size="tiny" placeholder="标签，逗号分隔" @blur="save(s)" />
          <n-popconfirm @positive-click="del(s)"><template #trigger><n-button size="tiny" type="error" ghost block>删除</n-button></template>确定删除？</n-popconfirm>
        </n-space>
      </n-card>
    </div>
  </n-space>
</template>

<style scoped>
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
.img { width: 100%; height: 130px; object-fit: contain; background: rgba(128,128,128,.08); }
</style>
