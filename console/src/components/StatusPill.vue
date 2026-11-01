<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router';
import { useBot } from '../bot';

const route = useRoute();
const router = useRouter();
const { pulse, view, askStart } = useBot();
const click = () => (pulse.value.state === 'offline' ? askStart() : router.push('/dashboard'));
</script>

<template>
  <!-- 仪表盘上已有完整状态，这里不重复 -->
  <button v-if="route.path !== '/dashboard'" class="pill" :class="`st-${pulse.state}`" :title="view.sub" @click="click">
    <span class="bot-dot" />{{ view.label }}
  </button>
</template>

<style scoped>
.pill { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; border-radius: 12px; font: inherit; font-size: 12px; color: inherit; cursor: pointer;
  border: 1px solid color-mix(in srgb, var(--c) 45%, transparent); background: color-mix(in srgb, var(--c) 10%, transparent); }
.pill:hover { background: color-mix(in srgb, var(--c) 18%, transparent); }
.pill :deep(.bot-dot) { width: 8px; height: 8px; }
</style>
