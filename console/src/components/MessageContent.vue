<script setup lang="ts">
import { computed } from 'vue';
import { NImage, NTag } from 'naive-ui';

const props = defineProps<{ text: string; onQuote?: (id: string) => void }>();
const emit = defineEmits<{ (e: 'quote', id: string): void }>();

type Part = { kind: 'text' | 'image' | 'face' | 'tag' | 'reply' | 'at'; text: string; ref?: string; sticker?: boolean };
const RE = /\[(图片表情|图片|语音|视频|文件|表情|大表情|回复|合并转发|卡片|戳一戳|骰子|猜拳|链接|音乐分享|位置|Markdown|推荐好友|推荐群)(?:#(-?[0-9a-zA-Z]+))?(?::([^\]]*))?\]|@(?:我|全体成员|[^\s(]+\(\d+\)|\d+) /g;

const parts = computed<Part[]>(() => {
  const out: Part[] = [];
  let last = 0;
  for (const m of props.text.matchAll(RE)) {
    if (m.index! > last) out.push({ kind: 'text', text: props.text.slice(last, m.index) });
    const [all, kind, ref, extra] = m;
    if (!kind) out.push({ kind: 'at', text: all.trim() });
    else if ((kind === '图片' || kind === '图片表情') && ref) out.push({ kind: 'image', text: extra ?? '', ref, sticker: kind === '图片表情' });
    else if (kind === '表情') out.push({ kind: 'face', text: extra ?? '' });
    else if (kind === '回复') out.push({ kind: 'reply', text: ref ?? '', ref });
    else out.push({ kind: 'tag', text: `${kind}${extra ? `:${extra}` : ''}${ref && kind !== '图片' ? ` #${ref}` : ''}` });
    last = m.index! + all.length;
  }
  if (last < props.text.length) out.push({ kind: 'text', text: props.text.slice(last) });
  return out;
});
</script>

<template>
  <span class="mc">
    <template v-for="(p, i) in parts" :key="i">
      <span v-if="p.kind === 'text'" class="t">{{ p.text }}</span>
      <span v-else-if="p.kind === 'at'" class="at">{{ p.text }} </span>
      <span v-else-if="p.kind === 'face'" class="face">[{{ p.text }}]</span>
      <a v-else-if="p.kind === 'reply'" class="reply" @click="emit('quote', p.ref!)">↩ 回复 #{{ p.ref }}</a>
      <n-image v-else-if="p.kind === 'image'" :src="`/api/media/${p.ref}`" :class="p.sticker ? 'img sticker' : 'img'" object-fit="contain" lazy fallback-src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='40'%3E%3Ctext x='4' y='24' font-size='12' fill='%23999'%3E图片已过期%3C/text%3E%3C/svg%3E" />
      <n-tag v-else size="tiny" :bordered="false" class="tag">{{ p.text }}</n-tag>
    </template>
  </span>
</template>

<style scoped>
.mc { white-space: pre-wrap; word-break: break-word; }
.at { color: #12b7f5; }
.face { color: #e6a23c; }
.reply { display: block; font-size: 12px; opacity: .65; cursor: pointer; margin-bottom: 2px; }
.img :deep(img) { max-width: 240px; max-height: 240px; border-radius: 6px; display: block; margin: 4px 0; }
.sticker :deep(img) { max-width: 120px; max-height: 120px; }
.tag { margin: 0 2px; }
</style>
