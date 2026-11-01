<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { NSpace, NInput, NSelect, NButton, NSwitch } from 'naive-ui';
import { api, onPush } from '../api';

const logs = ref<any[]>([]);
const level = ref('info');
const q = ref('');
const follow = ref(true);
const box = ref<HTMLElement>();
const ORDER: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const shown = computed(() => logs.value.filter((l) => ORDER[l.level] >= ORDER[level.value] && (!q.value || `${l.scope} ${l.msg}`.includes(q.value))));

async function load() { logs.value = await api('/api/logs'); scroll(); }
function scroll() { if (follow.value) nextTick(() => { if (box.value) box.value.scrollTop = box.value.scrollHeight; }); }
const off = onPush((t, d) => { if (t === 'log') { logs.value.push(d); if (logs.value.length > 2000) logs.value.splice(0, 500); scroll(); } });
onMounted(load);
onUnmounted(off);
const color: Record<string, string> = { debug: '#888', info: 'inherit', warn: '#f0a020', error: '#d03050' };
</script>

<template>
  <div class="page">
    <div class="toolbar">
      <n-select v-model:value="level" size="small" style="width: 100px" :options="['debug', 'info', 'warn', 'error'].map((v) => ({ label: v, value: v }))" />
      <n-input v-model:value="q" size="small" placeholder="筛选" clearable style="width: 200px" />
      <n-button size="small" @click="load">刷新</n-button>
      <span class="hint">自动滚动</span><n-switch v-model:value="follow" size="small" />
    </div>
    <div ref="box" class="box">
      <div v-for="(l, i) in shown" :key="i" :style="{ color: color[l.level] }">
        <span class="t">{{ new Date(l.ts).toLocaleTimeString('zh-CN', { hour12: false }) }}</span> <b>{{ l.level.toUpperCase() }}</b> [{{ l.scope }}] {{ l.msg }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.box { height: calc(100vh - 118px); overflow: auto; font-family: Consolas, monospace; font-size: 12px; line-height: 1.6; padding: 8px; border: 1px solid rgba(128,128,128,.25); border-radius: 6px; white-space: pre-wrap; word-break: break-all; }
.t { opacity: .55; }
</style>
