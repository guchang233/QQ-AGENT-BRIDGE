<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type Simulation } from 'd3-force';
import { NButton, NInput, NPopconfirm, NSelect, NSwitch, NTag, useMessage, useThemeVars } from 'naive-ui';
import { api } from '../api';

interface GNode { id: string; type: 'memory' | 'person' | 'topic'; label: string; degree: number; kind?: string; scope?: string; trust?: string; expired?: boolean; importance?: number; x: number; y: number; fx?: number | null; fy?: number | null; vx?: number; vy?: number }
interface GEdge { source: any; target: any; rel: string }

const msg = useMessage();
const theme = useThemeVars();
const box = ref<HTMLDivElement>();
const canvas = ref<HTMLCanvasElement>();
const nodes = ref<GNode[]>([]);
const edges = ref<GEdge[]>([]);
const total = ref(0);
const truncated = ref(false);
const scope = ref<string | null>(null);
const scopes = ref<{ label: string; value: string }[]>([]);
const search = ref('');
const showExpired = ref(false);
const showOrphans = ref(true);
const center = ref('');
const detail = ref<any>(null);
const selected = ref('');
const aliasDraft = ref('');
const mergeInto = ref<string | null>(null);
const replaceBy = ref<number | null>(null);

const KIND: Record<string, string> = { fact: '事实', preference: '偏好', event: '事件', relation: '关系', task: '待办', note: '笔记', rule: '管理员规则' };
const TRUST: Record<string, string> = { owner: '管理员确认', self: 'AI 观察', imported: '导入', member: '群友自述' };
const COLOR = { person: '#12b7f5', topic: '#8a63d2', memory: '#8a8f98', rule: '#f0a020', expired: '#d03050' };

const nodeColor = (n: GNode) => (n.type === 'memory' ? (n.expired ? COLOR.expired : n.kind === 'rule' ? COLOR.rule : COLOR.memory) : COLOR[n.type]);
const radius = (n: GNode) => (n.type === 'memory' ? 3 : 5) + Math.sqrt(n.degree) * (n.type === 'memory' ? 0.8 : 1.8);

// ---------------- 视图变换
let view = { x: 0, y: 0, k: 1 };
let width = 0, height = 0;
const dpr = () => window.devicePixelRatio || 1;
const toWorld = (sx: number, sy: number) => ({ x: (sx - view.x) / view.k, y: (sy - view.y) / view.k });

let sim: Simulation<GNode, GEdge> | null = null;
let frame = 0;
let hover: GNode | null = null;
let neighbors = new Map<string, Set<string>>();
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const matched = computed(() => {
  const q = search.value.trim().toLowerCase();
  return q ? new Set(nodes.value.filter((n) => n.label.toLowerCase().includes(q)).map((n) => n.id)) : null;
});

function schedule() { if (!frame) frame = requestAnimationFrame(() => { frame = 0; draw(); }); }

function draw() {
  const ctx = canvas.value?.getContext('2d');
  if (!ctx) return;
  const ratio = dpr();
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.translate(view.x, view.y);
  ctx.scale(view.k, view.k);
  const focusId = hover?.id ?? selected.value;
  const near = focusId ? neighbors.get(focusId) ?? new Set<string>() : null;
  const lit = (id: string) => !near || id === focusId || near.has(id);

  ctx.lineWidth = 1 / view.k;
  for (const e of edges.value) {
    const active = !!focusId && (e.source.id === focusId || e.target.id === focusId);
    ctx.globalAlpha = near ? (active ? 0.9 : 0.06) : 0.35;
    ctx.strokeStyle = active ? nodeColor(e.source.id === focusId ? e.target : e.source) : theme.value.textColor3;
    ctx.setLineDash(e.rel === 'supersedes' ? [3 / view.k, 3 / view.k] : []);
    ctx.beginPath();
    ctx.moveTo(e.source.x, e.source.y);
    ctx.lineTo(e.target.x, e.target.y);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  const hits = matched.value;
  for (const n of nodes.value) {
    const dim = (near && !lit(n.id)) || (hits && !hits.has(n.id));
    ctx.globalAlpha = dim ? 0.15 : n.expired ? 0.55 : 1;
    ctx.fillStyle = nodeColor(n);
    ctx.beginPath();
    ctx.arc(n.x, n.y, radius(n), 0, Math.PI * 2);
    ctx.fill();
    if (n.id === selected.value || hits?.has(n.id)) {
      ctx.strokeStyle = theme.value.textColor1;
      ctx.lineWidth = 1.5 / view.k;
      ctx.stroke();
      ctx.lineWidth = 1 / view.k;
    }
  }

  // 标签：实体常显；记忆在放大或被高亮时才显示，否则满屏文字看不清结构
  ctx.fillStyle = theme.value.textColor1;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const n of nodes.value) {
    const emphasized = !!near && lit(n.id);
    // 一个人连着很多记忆时标签会叠在一起，这些内容右侧面板里都有，放大后再逐条显示
    const show = n.id === focusId || hits?.has(n.id) || (n.type !== 'memory' && (emphasized || view.k > 0.55)) || view.k > 1.6;
    if (!show) continue;
    ctx.globalAlpha = near && !emphasized ? 0.15 : n.type === 'memory' ? 0.8 : 1;
    ctx.font = `${n.type === 'memory' ? 10 : 12}px sans-serif`;
    const scale = Math.max(1, 1 / view.k);
    ctx.save();
    ctx.translate(n.x, n.y + radius(n) + 3);
    ctx.scale(scale, scale);
    ctx.fillText(n.label.length > 16 ? `${n.label.slice(0, 16)}…` : n.label, 0, 0);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

function fit() {
  if (!nodes.value.length || !width) return;
  const xs = nodes.value.map((n) => n.x), ys = nodes.value.map((n) => n.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const k = Math.min(1.6, 0.9 * Math.min(width / Math.max(x1 - x0, 1), height / Math.max(y1 - y0, 1)));
  view = { k, x: width / 2 - (k * (x0 + x1)) / 2, y: height / 2 - (k * (y0 + y1)) / 2 };
  schedule();
}

function startSimulation(data: { nodes: GNode[]; edges: GEdge[] }) {
  sim?.stop();
  const degree = new Map<string, number>();
  for (const e of data.edges) { degree.set(e.source, 1); degree.set(e.target, 1); }
  const list = showOrphans.value ? data.nodes : data.nodes.filter((n) => degree.has(n.id));
  const ids = new Set(list.map((n) => n.id));
  const links = data.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  neighbors = new Map(list.map((n) => [n.id, new Set<string>()]));
  for (const e of links) { neighbors.get(e.source)!.add(e.target); neighbors.get(e.target)!.add(e.source); }
  nodes.value = list;
  edges.value = links;
  sim = forceSimulation<GNode, GEdge>(list)
    .force('charge', forceManyBody<GNode>().strength(-70).distanceMax(320))
    .force('link', forceLink<GNode, GEdge>(links).id((n) => n.id).distance(46).strength(0.5))
    .force('collide', forceCollide<GNode>().radius((n) => radius(n) + 3))
    .force('center', forceCenter(0, 0))
    .on('tick', schedule);
  if (reduceMotion()) { sim.stop(); sim.tick(300); fit(); return; }
  sim.on('end', fit);
  // 先静默跑一段，避免一打开全部节点从中心炸开
  sim.tick(60);
  fit();
}

async function load() {
  const qs = new URLSearchParams({ expired: showExpired.value ? '1' : '0' });
  if (scope.value) qs.set('scope', scope.value);
  if (center.value) { qs.set('center', center.value); qs.set('depth', '2'); }
  try {
    const r = await api(`/api/p/memory/graph?${qs}`);
    total.value = r.total; truncated.value = r.truncated;
    startSimulation(r);
  } catch (e: any) { msg.error(e.status === 404 ? '记忆插件未启用' : e.message); }
}

async function select(id: string) {
  selected.value = id;
  aliasDraft.value = ''; mergeInto.value = null; replaceBy.value = null;
  schedule();
  if (!id) { detail.value = null; return; }
  const num = id.slice(1);
  const d = await api(`/api/p/memory/${id[0] === 'm' ? 'items' : 'entities'}/${num}`).catch(() => null);
  detail.value = d && { ...d, nodeId: id };
}

// ---------------- 指针交互
const pointers = new Map<number, { x: number; y: number }>();
let dragging: GNode | null = null;
let panning = false;
let moved = 0;
let pinch = 0;

const pos = (e: PointerEvent | WheelEvent) => { const r = canvas.value!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
function hitTest(sx: number, sy: number) {
  const p = toWorld(sx, sy);
  let best: GNode | null = null; let bestD = Infinity;
  for (const n of nodes.value) {
    const d = Math.hypot(n.x - p.x, n.y - p.y);
    if (d < Math.max(radius(n) + 3, 8 / view.k) && d < bestD) { best = n; bestD = d; }
  }
  return best;
}
function onDown(e: PointerEvent) {
  canvas.value!.setPointerCapture(e.pointerId);
  const p = pos(e);
  pointers.set(e.pointerId, p);
  moved = 0;
  if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); dragging = null; panning = false; return; }
  dragging = hitTest(p.x, p.y);
  panning = !dragging;
  if (dragging) { dragging.fx = dragging.x; dragging.fy = dragging.y; sim?.alphaTarget(0.2).restart(); }
}
function onMove(e: PointerEvent) {
  const p = pos(e);
  const last = pointers.get(e.pointerId);
  if (pointers.size === 2 && last) {
    pointers.set(e.pointerId, p);
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, dist / (pinch || dist));
    pinch = dist;
    return;
  }
  if (last) {
    moved += Math.abs(p.x - last.x) + Math.abs(p.y - last.y);
    pointers.set(e.pointerId, p);
    if (dragging) { const w = toWorld(p.x, p.y); dragging.fx = w.x; dragging.fy = w.y; schedule(); return; }
    if (panning) { view.x += p.x - last.x; view.y += p.y - last.y; schedule(); return; }
  }
  const h = hitTest(p.x, p.y);
  if (h !== hover) { hover = h; canvas.value!.style.cursor = h ? 'pointer' : 'grab'; schedule(); }
}
function onUp(e: PointerEvent) {
  pointers.delete(e.pointerId);
  if (dragging) { dragging.fx = null; dragging.fy = null; sim?.alphaTarget(0); }
  if (moved < 5 && pointers.size === 0) { const p = pos(e); const h = hitTest(p.x, p.y); select(h?.id ?? ''); }
  dragging = null; panning = false;
}
function zoomAt(sx: number, sy: number, factor: number) {
  const k = Math.min(5, Math.max(0.15, view.k * factor));
  const w = toWorld(sx, sy);
  view = { k, x: sx - w.x * k, y: sy - w.y * k };
  schedule();
}
function onWheel(e: WheelEvent) { e.preventDefault(); const p = pos(e); zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0015)); }
function onDblClick(e: MouseEvent) {
  const r = canvas.value!.getBoundingClientRect();
  const h = hitTest(e.clientX - r.left, e.clientY - r.top);
  if (h) { center.value = h.id; load(); }
}

function jumpToMatch() {
  const id = matched.value && [...matched.value][0];
  const n = id && nodes.value.find((x) => x.id === id);
  if (!n) return;
  view = { ...view, x: width / 2 - n.x * view.k, y: height / 2 - n.y * view.k };
  select(n.id);
}

// ---------------- 操作
async function run(path: string, body: unknown, done: string, method = 'POST') {
  try { await api(`/api/p/memory/${path}`, { method, body }); msg.success(done); await load(); await select(selected.value); } catch (e: any) { msg.error(e.message); }
}
const plain = (t: string) => t.replace(/\[\[|\]\]/g, '');
const memoryId = computed(() => detail.value?.memory?.id);
const entityOptions = computed(() => nodes.value.filter((n) => n.type !== 'memory' && n.id !== selected.value).map((n) => ({ label: n.label, value: n.id })));
const replaceOptions = computed(() => (detail.value?.related ?? []).filter((m: any) => !m.expired).map((m: any) => ({ label: `#${m.id} ${m.content.slice(0, 24)}`, value: m.id })));
const clearCenter = () => { center.value = ''; load(); };
async function remove() {
  try { await api(`/api/p/memory/items/${memoryId.value}`, { method: 'DELETE' }); msg.success('已删除'); selected.value = ''; detail.value = null; await load(); } catch (e: any) { msg.error(e.message); }
}
async function mergeEntity() {
  const id = detail.value.id;
  try {
    const r = await api(`/api/p/memory/entities/${id}/merge`, { body: { into: Number(mergeInto.value!.slice(1)) } });
    msg.success('已合并'); await load(); await select(`e${r.id}`);
  } catch (e: any) { msg.error(e.message); }
}

// ---------------- 尺寸
let observer: ResizeObserver | undefined;
function resize() {
  const el = box.value, c = canvas.value;
  if (!el || !c) return;
  width = el.clientWidth; height = el.clientHeight;
  c.width = width * dpr(); c.height = height * dpr();
  schedule();
}
onMounted(async () => {
  observer = new ResizeObserver(resize);
  observer.observe(box.value!);
  resize();
  const ov = await api('/api/p/memory/overview').catch(() => null);
  scopes.value = (ov?.byScope ?? []).map((s: any) => ({ label: `${s.scope}（${s.n}）`, value: s.scope }));
  load();
});
onBeforeUnmount(() => { sim?.stop(); observer?.disconnect(); cancelAnimationFrame(frame); });
watch([scope, showExpired, showOrphans], () => { selected.value = ''; detail.value = null; load(); });
watch(search, schedule);
</script>

<template>
  <div class="graph-page">
    <div class="toolbar">
      <n-input v-model:value="search" size="small" placeholder="搜索节点，回车定位" clearable style="width: 180px" @keyup.enter="jumpToMatch" />
      <n-select v-model:value="scope" size="small" clearable placeholder="全部范围" :options="scopes" style="width: 200px" />
      <span class="hint">已失效</span><n-switch v-model:value="showExpired" size="small" />
      <span class="hint">孤立节点</span><n-switch v-model:value="showOrphans" size="small" />
      <n-button v-if="center" size="tiny" @click="clearCenter">返回全部</n-button>
      <span class="grow" />
      <span class="hint">{{ truncated ? `显示 ${nodes.length} / ${total} 个节点（按连接数）` : `${nodes.length} 个节点` }}</span>
      <n-button size="tiny" quaternary @click="fit">适应窗口</n-button>
    </div>

    <div class="stage">
      <div ref="box" class="canvas-box">
        <canvas ref="canvas" aria-label="记忆关联网络" @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp" @wheel="onWheel" @dblclick="onDblClick" />
        <div v-if="!nodes.length" class="empty hint">还没有记忆。Agent 写入时用 [[小红]] 这样的双链，这里就会连起来。</div>
        <div class="legend hint">
          <span><i style="background: #12b7f5" />人物</span><span><i style="background: #8a63d2" />话题</span><span><i style="background: #8a8f98" />记忆</span>
          <span><i style="background: #f0a020" />规则</span><span v-if="showExpired"><i style="background: #d03050" />已失效</span>
          <span>双击节点只看它的关联</span>
        </div>
      </div>

      <aside class="panel">
        <div v-if="!detail" class="hint">点一个节点，查看内容和反向链接。</div>

        <template v-else-if="detail.memory">
          <div class="tags">
            <n-tag size="tiny" :bordered="false">{{ KIND[detail.memory.kind] ?? detail.memory.kind }}</n-tag>
            <n-tag v-if="detail.memory.attr" size="tiny" :bordered="false" type="info">{{ detail.memory.attr }}</n-tag>
            <n-tag v-if="detail.memory.expired" size="tiny" :bordered="false" type="error">已失效</n-tag>
            <n-tag v-if="detail.memory.pinned" size="tiny" :bordered="false" type="warning">钉住</n-tag>
          </div>
          <p class="body-text">{{ plain(detail.memory.content) }}</p>
          <dl class="kv">
            <dt>范围</dt><dd>{{ detail.memory.scope }}</dd>
            <dt>来源</dt><dd>{{ TRUST[detail.memory.trust] ?? detail.memory.trust }}</dd>
            <dt>保持率</dt><dd>{{ Math.round(detail.memory.retention * 100) }}%</dd>
          </dl>
          <div v-if="detail.entities.length" class="sec"><h4>连着</h4>
            <a v-for="e in detail.entities" :key="e.id" class="chip" @click="select(`e${e.id}`)">{{ e.name }}</a>
          </div>
          <div v-if="detail.supersededBy" class="sec"><h4>已被替代为</h4>
            <a class="row" @click="select(`m${detail.supersededBy.id}`)">{{ detail.supersededBy.content }}</a>
          </div>
          <div v-if="detail.replaced.length" class="sec"><h4>替代了</h4>
            <a v-for="m in detail.replaced" :key="m.id" class="row" @click="select(`m${m.id}`)">{{ m.content }}</a>
          </div>
          <div v-if="detail.related.length" class="sec"><h4>相关记忆 {{ detail.related.length }}</h4>
            <a v-for="m in detail.related" :key="m.id" class="row" :class="{ gone: m.expired }" @click="select(`m${m.id}`)">{{ m.content }}</a>
          </div>
          <div class="sec actions">
            <n-select v-if="replaceOptions.length && !detail.memory.expired" v-model:value="replaceBy" size="tiny" placeholder="标记被哪条替代" :options="replaceOptions" />
            <n-button v-if="replaceBy" size="tiny" @click="run(`items/${memoryId}/supersede`, { by: replaceBy }, '已标记替代')">确认替代</n-button>
            <n-button v-if="detail.memory.expired" size="tiny" @click="run(`items/${memoryId}/restore`, {}, '已恢复')">恢复为有效</n-button>
            <n-button size="tiny" @click="center = selected; load()">只看关联</n-button>
            <n-button size="tiny" @click="run(`items/${memoryId}/archive`, { archived: !detail.memory.archived }, detail.memory.archived ? '已恢复' : '已归档')">{{ detail.memory.archived ? '恢复' : '归档' }}</n-button>
            <n-popconfirm @positive-click="remove"><template #trigger><n-button size="tiny" quaternary type="error">删除</n-button></template>彻底删除这条记忆？</n-popconfirm>
          </div>
        </template>

        <template v-else>
          <div class="tags"><n-tag size="tiny" :bordered="false" :type="detail.kind === 'person' ? 'info' : 'default'">{{ detail.kind === 'person' ? '人物' : '话题' }}</n-tag></div>
          <p class="body-text"><b>{{ detail.name }}</b></p>
          <dl class="kv">
            <template v-if="detail.key.startsWith('qq:')"><dt>QQ</dt><dd>{{ detail.key.slice(3) }}</dd></template>
            <template v-if="detail.aliases.length"><dt>别名</dt><dd>{{ detail.aliases.join('、') }}</dd></template>
          </dl>
          <div class="sec"><h4>反向链接 {{ detail.memories.length }}</h4>
            <div v-if="!detail.memories.length" class="hint">没有相连的记忆</div>
            <a v-for="m in detail.memories" :key="m.id" class="row" :class="{ gone: m.expired }" @click="select(`m${m.id}`)">{{ plain(m.content) }}</a>
          </div>
          <div class="sec actions">
            <n-input v-model:value="aliasDraft" size="tiny" placeholder="加一个别名" @keyup.enter="aliasDraft && run(`entities/${detail.id}/alias`, { alias: aliasDraft }, '已添加别名')" />
            <n-button v-if="aliasDraft" size="tiny" @click="run(`entities/${detail.id}/alias`, { alias: aliasDraft }, '已添加别名')">添加</n-button>
            <n-select v-model:value="mergeInto" size="tiny" filterable placeholder="和另一个实体合并" :options="entityOptions" />
            <n-popconfirm v-if="mergeInto" @positive-click="mergeEntity"><template #trigger><n-button size="tiny">合并</n-button></template>两个实体合并后不能拆开，确定？</n-popconfirm>
            <n-button size="tiny" @click="center = selected; load()">只看关联</n-button>
          </div>
        </template>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.graph-page { display: flex; flex-direction: column; gap: 8px; height: calc(100vh - 205px); min-height: 420px; }
.grow { flex: 1; }
.stage { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 10px; }
.canvas-box { position: relative; min-height: 0; overflow: hidden; border: 1px solid rgba(128,128,128,.2); border-radius: 8px; }
canvas { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; cursor: grab; }
.empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 16px; text-align: center; pointer-events: none; }
.legend { position: absolute; left: 10px; bottom: 8px; display: flex; flex-wrap: wrap; gap: 2px 10px; pointer-events: none; }
.legend i { display: inline-block; width: 8px; height: 8px; margin-right: 4px; border-radius: 50%; }
.panel { min-height: 0; overflow: auto; padding: 10px 12px; border: 1px solid rgba(128,128,128,.2); border-radius: 8px; font-size: 12.5px; }
.tags { display: flex; flex-wrap: wrap; gap: 4px; }
.body-text { margin: 6px 0; font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; white-space: pre-wrap; }
.sec { margin-top: 10px; }
.sec h4 { margin: 0 0 4px; font-size: 12px; font-weight: 600; opacity: .7; }
.row { display: block; padding: 3px 4px; border-radius: 4px; color: inherit; cursor: pointer; overflow-wrap: anywhere; }
.row:hover { background: rgba(128,128,128,.12); }
.row.gone { opacity: .5; text-decoration: line-through; }
.chip { display: inline-block; margin: 0 4px 4px 0; padding: 1px 7px; border-radius: 10px; background: rgba(18,183,245,.14); cursor: pointer; }
.actions { display: flex; flex-direction: column; gap: 6px; }
@media (max-width: 860px) {
  .graph-page { height: auto; }
  .stage { grid-template-columns: minmax(0, 1fr); }
  .canvas-box { height: 58vh; }
  .panel { max-height: none; }
}
</style>
