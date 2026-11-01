<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { NGrid, NGi, NCard, NStatistic, NSpace, NRadioGroup, NRadioButton, NDataTable, NEmpty, NText, NButton, NModal, NInput, NTooltip, useMessage, type DataTableColumns } from 'naive-ui';
import { api, onPush, fmtFull, fmtTime } from '../api';

const msg = useMessage();
const sum = ref<any>(null);
const series = ref<any[]>([]);
const days = ref(30);
const by = ref<'conv' | 'model' | 'driver'>('conv');
const rows = ref<any[]>([]);
const turns = ref<any[]>([]);
const showPrices = ref(false);
const pricesText = ref('');

const sym = computed(() => sum.value?.symbol ?? '¥');
const money = (v: number) => `${sym.value}${v < 0.01 && v > 0 ? v.toFixed(4) : v.toFixed(2)}`;
const tok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n));
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

async function load() {
  [sum.value, series.value, rows.value, turns.value] = await Promise.all([
    api('/api/usage/summary'), api(`/api/usage/series?days=${days.value}`), api(`/api/usage/breakdown?by=${by.value}&days=${days.value}`), api('/api/usage/turns?limit=60'),
  ]);
}
async function openPrices() { pricesText.value = JSON.stringify(await api('/api/usage/prices'), null, 2); showPrices.value = true; }
async function savePrices() {
  let p: any;
  try { p = JSON.parse(pricesText.value); } catch { return msg.error('JSON 格式错误'); }
  const r = await api('/api/usage/prices', { method: 'PUT', body: { models: p.models, peakMultiplier: p.peakMultiplier, peakWindows: p.peakWindows, currency: p.currency, symbol: p.symbol, fallbackModel: p.fallbackModel } });
  msg.success(`已保存并重算 ${r.recomputed} 条记录`); showPrices.value = false; load();
}

// 简单 SVG 柱状图：每天费用，高峰部分深色
const chart = computed(() => {
  const list = series.value;
  const max = Math.max(0.0001, ...list.map((d) => d.cost));
  const w = Math.max(8, Math.min(28, 760 / Math.max(1, list.length)));
  return { list, max, w, width: Math.max(300, list.length * (w + 4)) };
});

const cols = computed<DataTableColumns<any>>(() => [
  { title: by.value === 'conv' ? '会话' : by.value === 'model' ? '模型' : '驱动', key: 'key', render: (r) => (r.name ? `${r.name}（${r.key}）` : r.key || '—') },
  { title: '回合', key: 'turns', width: 70 },
  { title: '输入', key: 'input', width: 90, render: (r) => tok(r.input) },
  { title: '输出', key: 'output', width: 80, render: (r) => tok(r.output) },
  { title: '缓存命中', key: 'cacheHitRate', width: 90, render: (r) => pct(r.cacheHitRate) },
  { title: '费用', key: 'cost', width: 100, render: (r) => money(r.cost) },
  { title: '最近', key: 'last', width: 120, render: (r) => fmtTime(r.last) },
]);
const turnCols: DataTableColumns<any> = [
  { title: '时间', key: 'ts', width: 160, render: (r) => fmtFull(r.ts) },
  { title: '会话', key: 'conv', width: 170 },
  { title: '回合', key: 'turn', width: 60, render: (r) => (r.turn < 0 ? '基线' : r.turn) },
  { title: '模型', key: 'models', width: 140 },
  { title: '步数', key: 'steps', width: 60 },
  { title: '未命中', key: 'cacheMiss', width: 90, render: (r) => tok(r.cacheMiss) },
  { title: '命中', key: 'cacheHit', width: 90, render: (r) => tok(r.cacheHit) },
  { title: '输出', key: 'output', width: 80, render: (r) => tok(r.output) },
  { title: '费用', key: 'cost', width: 100, render: (r) => money(r.cost) },
];

let t: any;
const detail = ref<'group' | 'turns'>('group');
const off = onPush((type) => { if (type === 'usage') { clearTimeout(t); t = setTimeout(load, 1500); } });
onMounted(load);
onUnmounted(() => { off(); clearTimeout(t); });
</script>

<template>
  <div class="page">
    <n-card v-if="sum && !sum.total.turns" size="small">
      <div class="toolbar"><span class="hint grow">还没有用量记录。接入 DeepSeek Harness 并开启仿真后，这里会显示每一轮的 Token 与费用。</span><n-button size="tiny" quaternary @click="openPrices">价目设置</n-button></div>
    </n-card>
    <template v-else-if="sum">
      <div class="sums">
        <n-card v-for="(lbl, k) in { today: '今天', last7d: '近 7 天', last30d: '近 30 天', total: '累计' }" :key="k" size="small">
          <div class="sum-top"><span class="hint">{{ lbl }}</span><b>{{ money(sum[k].cost) }}</b></div>
          <div class="hint">{{ sum[k].turns }} 轮 · {{ tok(sum[k].total) }} tokens · 命中 {{ pct(sum[k].cacheHitRate) }}<span v-if="sum[k].hasEstimated"> · 含估算</span></div>
        </n-card>
      </div>

      <n-card size="small" title="每日费用">
        <template #header-extra>
          <n-space :size="6">
            <n-radio-group v-model:value="days" size="small" @update:value="load">
              <n-radio-button :value="7">7 天</n-radio-button><n-radio-button :value="30">30 天</n-radio-button><n-radio-button :value="90">90 天</n-radio-button>
            </n-radio-group>
            <n-button size="small" quaternary @click="openPrices">价目设置</n-button>
          </n-space>
        </template>
        <div v-if="!chart.list.length" class="hint">暂无数据</div>
        <div v-else style="overflow-x: auto">
          <svg :width="chart.width" height="140" style="display: block">
            <g v-for="(d, i) in chart.list" :key="d.day" transform="translate(0, -30)">
              <n-tooltip>
                <template #trigger>
                  <g>
                    <rect :x="i * (chart.w + 4)" :y="150 - (d.cost / chart.max) * 110" :width="chart.w" :height="Math.max(1, (d.cost / chart.max) * 110)" fill="#12b7f5" opacity="0.55" rx="2" />
                    <rect :x="i * (chart.w + 4)" :y="150 - (d.peakCost / chart.max) * 110" :width="chart.w" :height="(d.peakCost / chart.max) * 110" fill="#0b8fc4" rx="2" />
                  </g>
                </template>
                {{ d.day }}：{{ money(d.cost) }}（高峰 {{ money(d.peakCost) }}）· {{ d.turns }} 轮 · 输出 {{ tok(d.output) }}
              </n-tooltip>
              <text v-if="chart.list.length <= 31 || i % 3 === 0" :x="i * (chart.w + 4) + chart.w / 2" y="165" font-size="9" text-anchor="middle" fill="currentColor" opacity="0.5">{{ d.day.slice(5) }}</text>
            </g>
          </svg>
          <div class="hint">深色为高峰时段费用（北京时间工作日 9–12、14–18 点）</div>
        </div>
      </n-card>

      <n-card size="small">
        <div class="toolbar" style="margin-bottom: 6px">
          <n-radio-group v-model:value="detail" size="small">
            <n-radio-button value="group">分组统计</n-radio-button><n-radio-button value="turns">最近回合</n-radio-button>
          </n-radio-group>
          <n-radio-group v-if="detail === 'group'" v-model:value="by" size="small" @update:value="load">
            <n-radio-button value="conv">按会话</n-radio-button><n-radio-button value="model">按模型</n-radio-button><n-radio-button value="driver">按驱动</n-radio-button>
          </n-radio-group>
        </div>
        <n-data-table v-if="detail === 'group'" :columns="cols" :data="rows" size="small" :max-height="360" :scroll-x="640" :row-key="(r: any) => r.key" />
        <n-data-table v-else :columns="turnCols" :data="turns" size="small" :max-height="360" :scroll-x="760" :row-key="(r: any) => `${r.driver}${r.session}${r.turn}`" />
      </n-card>
    </template>

    <n-modal v-model:show="showPrices" preset="card" title="价目设置（元 / 百万 token，空闲时段价）" style="max-width: 640px">
      <n-text depth="3" style="font-size: 12px">models 里每个模型填 cacheHit（缓存命中）、cacheMiss（未命中）、cacheWrite（可选）、output（输出）。高峰价 = 空闲价 × peakMultiplier。保存后会按新价目重算全部历史记录。</n-text>
      <n-input v-model:value="pricesText" type="textarea" :autosize="{ minRows: 12, maxRows: 24 }" style="font-family: monospace; margin-top: 8px" />
      <template #footer><n-space justify="end"><n-button @click="showPrices = false">取消</n-button><n-button type="primary" @click="savePrices">保存并重算</n-button></n-space></template>
    </n-modal>
  </div>
</template>

<style scoped>
.sums { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.sum-top { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.sum-top b { font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; }
.grow { flex: 1; }
@media (max-width: 760px) { .sums { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
