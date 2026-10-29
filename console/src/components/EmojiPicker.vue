<script setup lang="ts">
import { onMounted, ref, computed } from 'vue';
import { NTabs, NTabPane, NInput, NScrollbar, NEmpty } from 'naive-ui';
import { api } from '../api';

const emit = defineEmits<{ (e: 'pick', token: string): void }>();
const faces = ref<{ id: number; name: string }[]>([]);
const stickers = ref<any[]>([]);
const q = ref('');
const COMMON = ['😀', '😂', '🤣', '😊', '😍', '🥺', '😭', '😡', '👍', '👎', '👏', '🙏', '🎉', '❤️', '🔥', '✨', '🤔', '😅', '😎', '🙄', '😴', '🤡', '💩', '🐶'];

onMounted(async () => {
  [faces.value, stickers.value] = await Promise.all([api('/api/faces'), api('/api/stickers')]);
});
const fFaces = computed(() => faces.value.filter((f) => !q.value || f.name.includes(q.value) || String(f.id) === q.value));
const fStickers = computed(() => stickers.value.filter((s) => !q.value || s.remark.includes(q.value) || s.tags.includes(q.value)));
</script>

<template>
  <div style="width: 340px">
    <n-input v-model:value="q" size="small" placeholder="搜索表情 / 表情包" clearable style="margin-bottom: 6px" />
    <n-tabs type="segment" size="small" animated>
      <n-tab-pane name="face" tab="QQ 表情">
        <n-scrollbar style="max-height: 240px">
          <div class="grid">
            <button v-for="f in fFaces" :key="f.id" class="face" :title="`${f.name} (${f.id})`" @click="emit('pick', `[face:${f.name}]`)">{{ f.name }}</button>
          </div>
        </n-scrollbar>
      </n-tab-pane>
      <n-tab-pane name="sticker" tab="表情包">
        <n-scrollbar style="max-height: 240px">
          <n-empty v-if="!fStickers.length" description="还没有收藏表情包" size="small" />
          <div class="grid st">
            <img v-for="s in fStickers" :key="s.id" :src="`/api/stickers/${s.id}/image`" :title="s.remark" @click="emit('pick', `[sticker:${s.id}]`)" />
          </div>
        </n-scrollbar>
      </n-tab-pane>
      <n-tab-pane name="emoji" tab="Emoji">
        <div class="grid em"><button v-for="e in COMMON" :key="e" class="face" @click="emit('pick', e)">{{ e }}</button></div>
      </n-tab-pane>
    </n-tabs>
  </div>
</template>

<style scoped>
.grid { display: flex; flex-wrap: wrap; gap: 4px; }
.face { border: 1px solid rgba(128,128,128,.25); background: transparent; color: inherit; border-radius: 4px; padding: 2px 6px; font-size: 12px; cursor: pointer; }
.face:hover { background: rgba(18,183,245,.15); }
.em .face { font-size: 20px; padding: 2px 4px; }
.st img { width: 64px; height: 64px; object-fit: contain; cursor: pointer; border-radius: 4px; border: 1px solid rgba(128,128,128,.2); }
.st img:hover { border-color: #12b7f5; }
</style>
