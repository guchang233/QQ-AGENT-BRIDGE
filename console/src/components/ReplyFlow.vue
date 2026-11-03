<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { NButton, NPopconfirm, useMessage } from 'naive-ui';
import { api, onPush, fmtTime } from '../api';

/**
 * 回复流程条：每次可能叫醒 AI 的事走一遍「收到 → 会话启用 → 唤醒 → 交给 AI → AI 处理 → 回复」，
 * 卡在哪一步就在那一步说明原因、给出去处。不用专门去做诊断。
 */
const props = defineProps<{ running: any[]; offline: boolean; driverProblem: string }>();
const router = useRouter();
const msg = useMessage();
const traces = ref<any[]>([]);
const now = ref(Date.now());
const tick = setInterval(() => (now.value = Date.now()), 1000);

async function load() { try { traces.value = await api('/api/traces'); } catch { /* 旧版本后端 */ } }
const off = onPush((t, d) => {
  if (t !== 'trace') return;
  const i = traces.value.findIndex((x) => x.id === d.id);
  if (i >= 0) traces.value.splice(i, 1, d); else traces.value.unshift(d);
  traces.value.sort((a, b) => b.id - a.id);
  traces.value.length = Math.min(traces.value.length, 30);
});
onMounted(load);
onUnmounted(() => { off(); clearInterval(tick); });

// 进行中的全显示；结束的只留最近几条
const shown = computed(() => {
  const live = traces.value.filter((t) => !t.endedAt);
  const done = traces.value.filter((t) => t.endedAt).slice(0, Math.max(0, 4 - live.length));
  return [...live, ...done];
});
const runOf = (t: any) => props.running.find((r) => r.conv === t.conv);
/** AI 正在处理、但不是从这里触发的（后台提炼、外部调用等），也列出来，方便强制结束 */
const others = computed(() => props.running.filter((r) => !traces.value.some((t) => !t.endedAt && t.conv === r.conv)));
const ago = (ts: number) => { const s = Math.max(0, Math.round((now.value - ts) / 1000)); return s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`; };
const OUTCOME: Record<string, [string, string]> = { replied: ['已回复', 'ok'], silent: ['看过了，没说话', 'muted'], stopped: ['没叫醒 AI', 'muted'], blocked: ['卡住了', 'bad'] };
/** 卡住或停下的那一步（说明文字显示在流程条下面） */
const stopAt = (t: any) => t.steps.find((s: any) => s.state === 'blocked' || s.state === 'stop');
const current = (t: any) => stopAt(t) ?? [...t.steps].reverse().find((s: any) => s.state === 'active' || s.state === 'wait');
const noteOf = (t: any, s: any) => {
  if (s.key === 'think' && s.state === 'active') {
    const r = runOf(t);
    if (r?.step) return `${r.step}${r.lastProgressAt && now.value - r.lastProgressAt > 30000 ? `，已经 ${ago(r.lastProgressAt)} 没有进展` : ''}`;
  }
  return s.note;
};

const stopping = ref('');
async function forceEnd(t: any) {
  const r = runOf(t);
  stopping.value = t.conv;
  try { await api(`/api/drivers/${r?.driver ?? 'dsh'}/cancel`, { body: { conv: t.conv } }); msg.success('已结束这一轮'); }
  catch (e: any) { msg.error(e.message); } finally { stopping.value = ''; }
}
</script>

<template>
  <section class="flow-card">
    <header class="head">
      <b>回复流程</b>
      <span class="hint">每次叫醒 AI 都会在这里走一遍，卡在哪一步就会说明原因</span>
    </header>

    <div v-if="!shown.length && !others.length" class="empty">
      <template v-if="offline">机器人没有连上 QQ，收不到消息。先在上面点「启动」。</template>
      <template v-else-if="driverProblem">AI 现在不可用：{{ driverProblem }}。<a @click="router.push('/agent')">去处理</a></template>
      <template v-else>还没有触发过。到群里 @ 机器人或私聊它一句，这里会实时显示它怎么处理。</template>
    </div>

    <div v-for="r in others" :key="r.driver + r.conv" class="trace live other">
      <div class="meta">
        <b class="line">{{ r.convName || r.conv }}</b>
        <span class="hint line">AI 处理中{{ r.step ? `：${r.step}` : '' }}</span>
        <span class="grow" />
        <span v-if="r.since" class="hint">{{ ago(r.since) }}</span>
        <n-popconfirm @positive-click="forceEnd(r)">
          <template #trigger><n-button size="tiny" :loading="stopping === r.conv">强制结束</n-button></template>
          结束这个会话当前的 AI 回合？
        </n-popconfirm>
      </div>
    </div>

    <article v-for="t in shown" :key="t.id" class="trace" :class="{ live: !t.endedAt }">
      <div class="meta">
        <b class="line">{{ t.convName || t.conv }}</b>
        <span class="hint line">
          {{ t.sender ? `${t.sender}：${t.text || ''}` : t.origin }}<template v-if="t.merged > 1">（共 {{ t.merged }} 条）</template>
        </span>
        <span class="grow" />
        <span v-if="!t.endedAt" class="hint">{{ ago(t.startedAt) }}</span>
        <span v-else class="tag" :class="OUTCOME[t.outcome]?.[1]">{{ OUTCOME[t.outcome]?.[0] }}</span>
        <span class="hint">{{ fmtTime(t.startedAt) }}</span>
      </div>

      <ol class="steps">
        <li v-for="s in t.steps" :key="s.key" class="step" :class="`s-${s.state}`" :title="noteOf(t, s) || s.label">
          <span class="dot" />
          <span class="label">{{ s.label }}</span>
        </li>
      </ol>

      <div v-if="current(t)" class="why" :class="`w-${current(t).state}`">
        <span class="min0">{{ current(t).label }}：{{ noteOf(t, current(t)) || (current(t).state === 'active' ? '进行中' : '') }}</span>
        <n-button v-if="current(t).fix" size="tiny" @click="router.push(current(t).fix.to)">{{ current(t).fix.label }}</n-button>
        <n-popconfirm v-if="!t.endedAt && current(t).key === 'think'" @positive-click="forceEnd(t)">
          <template #trigger><n-button size="tiny" :loading="stopping === t.conv">强制结束</n-button></template>
          结束这个会话当前的 AI 回合？已经发出的消息不受影响，下一条新消息会重新唤醒。
        </n-popconfirm>
      </div>
      <div v-else-if="t.endedAt" class="why w-done">
        <span class="min0">{{ [...t.steps].reverse().find((s: any) => s.state === 'done')?.note }}</span>
      </div>
    </article>
  </section>
</template>

<style scoped>
.flow-card { display: flex; flex-direction: column; gap: 8px; padding: 10px 14px; border: 1px solid rgba(128,128,128,.18); border-radius: 8px; }
.head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; font-size: 13px; }
.empty { font-size: 13px; opacity: .75; }
.empty a { color: #12b7f5; cursor: pointer; }
.trace { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border-radius: 6px; background: rgba(128,128,128,.05); }
.trace.live { background: rgba(18,183,245,.06); }
.meta { display: flex; align-items: baseline; gap: 8px; min-width: 0; font-size: 13px; }
.meta .line { min-width: 0; }
.grow { flex: 1; }
.tag { flex: none; font-size: 12px; padding: 0 6px; border-radius: 4px; }
.tag.ok { color: #18a058; background: rgba(24,160,88,.12); }
.tag.muted { opacity: .7; background: rgba(128,128,128,.12); }
.tag.bad { color: #d03050; background: rgba(208,48,80,.12); }

.steps { display: grid; grid-template-columns: repeat(6, 1fr); margin: 0; padding: 0; list-style: none; }
.step { position: relative; display: flex; flex-direction: column; align-items: center; gap: 3px; font-size: 12px; text-align: center; }
/* 两步之间的连线 */
.step:not(:first-child)::before { content: ''; position: absolute; top: 6px; right: 50%; width: 100%; height: 2px; background: rgba(128,128,128,.25); }
.step.s-done::before, .step.s-active::before, .step.s-wait::before, .step.s-blocked::before, .step.s-stop::before { background: #18a058; }
.dot { position: relative; z-index: 1; width: 14px; height: 14px; border-radius: 50%; border: 2px solid rgba(128,128,128,.4); background: rgba(128,128,128,.15); box-sizing: border-box; }
.label { opacity: .55; }
.s-done .dot { border-color: #18a058; background: #18a058; }
.s-done .label { opacity: .85; }
.s-skip .dot { border-style: dashed; }
.s-skip .label { opacity: .35; }
.s-active .dot { border-color: #12b7f5; background: #12b7f5; animation: pulse 1.2s ease-in-out infinite; }
.s-active .label, .s-wait .label, .s-blocked .label, .s-stop .label { opacity: 1; font-weight: 600; }
.s-wait .dot { border-color: #f0a020; background: #f0a020; }
.s-stop .dot { border-color: #8a8f98; background: #8a8f98; }
.s-blocked .dot { border-color: #d03050; background: #d03050; }
.s-blocked .label { color: #d03050; }

.why { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; font-size: 12.5px; line-height: 1.5; }
.why .min0 { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.w-blocked { color: #d03050; }
.w-wait { color: #c08000; }
.w-stop, .w-done { opacity: .75; }
@keyframes pulse { 50% { opacity: .45; } }
@media (prefers-reduced-motion: reduce) { .s-active .dot { animation: none; } }
@media (max-width: 640px) { .label { font-size: 11px; } .meta { flex-wrap: wrap; } }
</style>
