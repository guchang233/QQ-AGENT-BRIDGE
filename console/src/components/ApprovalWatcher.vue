<script setup lang="ts">
import { h, onUnmounted, watch } from 'vue';
import { useNotification, NButton, NSpace } from 'naive-ui';
import { state, api, refreshApprovals, onPush, TIER_LABEL } from '../api';

// 新的审批请求弹出通知，可直接批准/拒绝
const notif = useNotification();
const shown = new Map<string, ReturnType<typeof notif.create>>();

async function decide(id: string, approve: boolean) {
  await api(`/api/approvals/${id}`, { body: { approve } }).catch(() => {});
  shown.get(id)?.destroy(); shown.delete(id);
  refreshApprovals();
}

watch(() => state.approvals, (list) => {
  const ids = new Set(list.map((a: any) => a.id));
  for (const [id, n] of shown) if (!ids.has(id)) { n.destroy(); shown.delete(id); }
  for (const a of list) {
    if (shown.has(a.id)) continue;
    shown.set(a.id, notif.warning({
      title: `Agent 请求${TIER_LABEL[a.tier] ?? a.tier}操作`,
      description: `${a.caller} → ${a.tool}`,
      content: a.summary,
      closable: false,
      action: () => h(NSpace, null, { default: () => [
        h(NButton, { size: 'small', onClick: () => decide(a.id, false) }, { default: () => '拒绝' }),
        h(NButton, { size: 'small', type: 'primary', onClick: () => decide(a.id, true) }, { default: () => '批准' }),
      ] }),
    }));
  }
}, { deep: true, immediate: true });

const off = onPush((type) => { if (type === 'approval') refreshApprovals(); });
onUnmounted(() => { off(); });
</script>

<template><span /></template>
