<script setup lang="ts">
import { ref } from 'vue';

/** 一句话说明；详细内容放默认插槽，点「详情」才展开，不占版面 */
defineProps<{ text: string }>();
const open = ref(false);
</script>

<template>
  <div class="page-hint">
    <span>{{ text }}</span>
    <a v-if="$slots.default" role="button" tabindex="0" @click="open = !open" @keydown.enter="open = !open">{{ open ? '收起' : '详情' }}</a>
    <div v-if="open" class="more"><slot /></div>
  </div>
</template>

<style scoped>
.page-hint { font-size: 12px; line-height: 1.6; opacity: .75; }
.page-hint a { margin-left: 6px; color: #12b7f5; cursor: pointer; }
.more { margin-top: 4px; }
</style>
