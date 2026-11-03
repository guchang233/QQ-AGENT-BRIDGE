<script setup lang="ts">
import { computed } from 'vue';
import { state } from '../api';
import { useBot } from '../bot';
import ReplyFlow from '../components/ReplyFlow.vue';

const { pulse } = useBot();
const s = computed(() => state.status ?? {});
const problems = computed<any[]>(() => s.value.agent?.problems ?? []);
</script>

<template>
  <div class="page">
    <ReplyFlow :running="s.agent?.running ?? []" :offline="pulse.state === 'offline'" :driver-problem="problems.map((p) => `${p.label}：${p.detail}`).join('；')" :limit="30" />
  </div>
</template>
