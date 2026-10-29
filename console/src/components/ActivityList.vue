<script setup lang="ts">
import { NTag, NEmpty } from 'naive-ui';
import { fmtTime, fmtFull } from '../api';
import MessageContent from './MessageContent.vue';

defineProps<{ items: any[]; compact?: boolean }>();

const KIND: Record<string, [string, any]> = {
  trigger: ['触发', 'info'], wake: ['送达', 'success'], turn: ['回合', 'default'], sent: ['发出', 'success'], error: ['错误', 'error'], info: ['信息', 'default'],
};
const parse = (d: string) => { try { return d ? JSON.parse(d) : null; } catch { return null; } };
const money = (v: number) => `¥${v < 0.01 && v > 0 ? v.toFixed(4) : v.toFixed(3)}`;
const tok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
</script>

<template>
  <n-empty v-if="!items.length" description="暂无动态：开启仿真并收到消息后，这里会实时显示每一步" />
  <div v-for="a in items" :key="a.id" class="row" :class="a.level">
    <span class="t" :title="fmtFull(a.ts)">{{ fmtTime(a.ts) }}</span>
    <n-tag size="tiny" :type="(KIND[a.kind] ?? ['', 'default'])[1]" :bordered="false" class="k">{{ (KIND[a.kind] ?? [a.kind])[0] }}</n-tag>
    <div class="body">
      <div class="title">
        <span v-if="a.conv" class="conv">{{ a.convName || a.conv }}</span>
        <span>{{ a.title }}</span>
        <span v-if="a.actor && a.kind !== 'turn' && a.kind !== 'wake'" class="actor">· {{ a.actor }}</span>
      </div>
      <template v-if="!compact || a.kind === 'sent' || a.kind === 'error'">
        <div v-if="a.kind === 'sent'" class="detail msg"><MessageContent :text="a.detail" /></div>
        <template v-else-if="parse(a.detail)">
          <div v-if="parse(a.detail).tools" class="detail">
            <span v-if="parse(a.detail).tools.length">调用：<code v-for="(t, i) in parse(a.detail).tools" :key="i">{{ t }}</code></span>
            <span v-if="parse(a.detail).tokens"> · 输入 {{ tok(parse(a.detail).tokens.input) }} / 输出 {{ tok(parse(a.detail).tokens.output) }} · {{ money(parse(a.detail).cost) }}</span>
            <div v-if="parse(a.detail).text && !compact" class="think">想法：{{ parse(a.detail).text }}</div>
          </div>
          <div v-else-if="parse(a.detail).session" class="detail">DSH 会话 {{ String(parse(a.detail).session).slice(0, 16) }}…{{ parse(a.detail).chars ? ` · 提示词 ${parse(a.detail).chars} 字` : '' }}</div>
        </template>
        <div v-else-if="a.detail" class="detail">{{ a.detail }}</div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.row { display: flex; gap: 8px; padding: 6px 2px; border-bottom: 1px dashed rgba(128,128,128,.18); align-items: flex-start; }
.row.error .title { color: #d03050; }
.t { font-size: 12px; opacity: .55; width: 44px; flex-shrink: 0; padding-top: 2px; }
.k { flex-shrink: 0; }
.body { min-width: 0; flex: 1; }
.title { font-size: 13px; }
.conv { font-weight: 600; margin-right: 6px; }
.actor { opacity: .55; font-size: 12px; margin-left: 4px; }
.detail { font-size: 12px; opacity: .75; margin-top: 2px; word-break: break-all; }
.detail code { margin-right: 4px; }
.msg { opacity: .9; background: rgba(18,183,245,.08); padding: 4px 8px; border-radius: 6px; display: inline-block; }
.think { margin-top: 2px; opacity: .7; white-space: pre-wrap; }
</style>
