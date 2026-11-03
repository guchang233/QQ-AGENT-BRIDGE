<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { NButton, NInput, NSelect, NRadioGroup, NRadio, NCheckbox, NDynamicTags, NSpin, NAlert, NCollapseTransition, useMessage } from 'naive-ui';
import { api, state } from '../api';
import { useDshModels } from '../dshModels';
import ReplyFlow from './ReplyFlow.vue';

/**
 * 首次设置向导（设好密码之后）：连接 QQ → 接入 AI → 管理员与回复范围 → 试一试。
 * 每一步都显示真实检测结果；能自动读的不让用户手填。
 */
const msg = useMessage();
const STEPS = ['连接 QQ', '接入 AI', '在哪里回复', '试一试'];
const step = ref(0);

// ---------------------------------------------------------------- 1 连接 QQ
const sl = ref<any>(null);
const slHome = ref('');
const scanning = ref(false);
const using = ref('');
const conn = ref<any>(null);
const manual = ref(false);
const mform = ref({ wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3000', accessToken: '', httpToken: '' });
async function scan(home = '') {
  scanning.value = true;
  try { sl.value = await api('/api/wizard/snowluma', { body: { home } }); slHome.value = sl.value.home; } catch (e: any) { msg.error(e.message); } finally { scanning.value = false; }
}
async function useAccount(uin: string) {
  using.value = uin;
  try { conn.value = await api('/api/wizard/snowluma/use', { body: { home: sl.value.home, uin } }); if (!conn.value.ok) msg.error(`没连上：${conn.value.error}`); }
  catch (e: any) { msg.error(e.message); } finally { using.value = ''; }
}
async function useManual() {
  using.value = 'manual';
  try { conn.value = await api('/api/wizard/onebot/manual', { body: mform.value }); if (!conn.value.ok) msg.error(`没连上：${conn.value.error}`); }
  catch (e: any) { msg.error(e.message); } finally { using.value = ''; }
}
const connected = computed(() => !!conn.value?.ok || (state.status?.connection === 'open' && !!state.status?.self));
const self = computed(() => conn.value?.self ?? state.status?.self);

// ---------------------------------------------------------------- 2 接入 AI
const dsh = ref<any>(null);
const checking = ref(false);
const installing = ref(false);
const installResult = ref<any>(null);
const mf = ref<any>({ provider: '', model: '', reasoningEffort: 'high' });
const models = useDshModels(mf);
async function checkDsh() {
  checking.value = true;
  try {
    dsh.value = await api('/api/wizard/dsh');
    mf.value = { ...dsh.value.model };
    if (dsh.value.running) models.load();
  } catch (e: any) { msg.error(e.message); } finally { checking.value = false; }
}
async function installDsh() {
  installing.value = true;
  try { installResult.value = await api('/api/drivers/dsh/install', { method: 'POST' }); await checkDsh(); }
  catch (e: any) { msg.error(e.message); } finally { installing.value = false; }
}
async function saveModel() {
  try { await api('/api/drivers/dsh/config', { method: 'PUT', body: { provider: mf.value.provider, model: mf.value.model, reasoningEffort: mf.value.reasoningEffort } }); return true; }
  catch (e: any) { msg.error(e.message); return false; }
}
const dshChecks = computed(() => dsh.value ? [
  { ok: dsh.value.installed, label: '已安装 DeepSeek Harness', fix: '先安装 DeepSeek Harness 桌面版并打开一次' },
  { ok: dsh.value.loggedIn, label: '已在 DSH 里登录', fix: '在 DSH 里登录账号（或配置好模型服务商）' },
  { ok: dsh.value.running, label: 'DSH 正在运行', fix: '打开 DSH，然后点「重新检测」' },
  { ok: dsh.value.connected, label: '已接入 QAB', fix: '点下面的「一键接入」' },
] : []);
const dshReady = computed(() => dsh.value?.connected && dsh.value?.running);
const skippedAi = ref(false);

// ---------------------------------------------------------------- 3 在哪里回复
const owners = ref<string[]>([]);
const mode = ref<'all' | 'allowlist'>('all');
const convs = ref<any[]>([]);
const picked = ref<string[]>([]);
// 从「全部启用」改成「只启用勾选的」：从空白开始勾，不要默认全勾上
watch(mode, (m, old) => { if (m === 'allowlist' && old === 'all') picked.value = []; });
const q = ref('');
async function loadBasics() {
  const st = state.status ?? {};
  try {
    const cfg = await api('/api/config');
    owners.value = cfg.config.owners ?? [];
    mode.value = cfg.config.access.mode;
  } catch { /* 用默认 */ }
  try { convs.value = await api('/api/p/social/convs'); picked.value = convs.value.filter((c) => c.enabled).map((c) => c.conv); } catch { convs.value = []; }
  void st;
}
const shownConvs = computed(() => {
  const k = q.value.trim().toLowerCase();
  return convs.value.filter((c) => !k || `${c.name} ${c.conv}`.toLowerCase().includes(k)).slice(0, 200);
});
const toggle = (conv: string, on: boolean) => { picked.value = on ? [...new Set([...picked.value, conv])] : picked.value.filter((x) => x !== conv); };
async function saveBasics() {
  try { await api('/api/wizard/basics', { body: { owners: owners.value, mode: mode.value, enabled: picked.value } }); return true; }
  catch (e: any) { msg.error(e.message); return false; }
}

// ---------------------------------------------------------------- 4 试一试
async function finish() {
  await api('/api/wizard/done', { method: 'POST' });
  state.status = { ...(state.status ?? {}), wizard: 'done' };
}

// ---------------------------------------------------------------- 翻页
async function next() {
  if (step.value === 1) skippedAi.value = !dshReady.value;
  if (step.value === 1 && dshReady.value && models.catalog.value?.ok && !(await saveModel())) return;
  if (step.value === 2 && !(await saveBasics())) return;
  step.value++;
  enter();
}
function enter() {
  if (step.value === 0 && !sl.value) scan();
  if (step.value === 1 && !dsh.value) checkDsh();
  if (step.value === 2) loadBasics();
}
onMounted(enter);
</script>

<template>
  <div class="wrap">
    <div class="box">
      <header class="top">
        <b>🐧 设置 QQ-Agent Bridge</b>
        <a class="skip" @click="finish">跳过向导</a>
      </header>
      <ol class="bar">
        <li v-for="(s, i) in STEPS" :key="s" :class="{ on: i === step, done: i < step }" @click="i < step && (step = i)">
          <span class="n">{{ i < step ? (i === 1 && skippedAi ? '–' : '✓') : i + 1 }}</span>{{ s }}{{ i === 1 && skippedAi && i < step ? '（已跳过）' : '' }}
        </li>
      </ol>

      <!-- 1 连接 QQ -->
      <section v-if="step === 0" class="body">
        <p class="lead">QAB 通过 SnowLuma 收发 QQ 消息。下面是在这台电脑上找到的 SnowLuma 和它登录的账号。</p>
        <n-spin :show="scanning">
          <div v-if="sl && !sl.valid" class="card warn">
            没找到 SnowLuma。{{ sl.running ? '它在运行，但' : '' }}请填写 SnowLuma 所在的文件夹（里面有 config 文件夹）：
            <div class="row"><n-input v-model:value="slHome" placeholder="例如 D:\SnowLuma" /><n-button @click="scan(slHome)">查找</n-button></div>
          </div>
          <template v-else-if="sl">
            <div class="hint">SnowLuma：<code>{{ sl.home }}</code>{{ sl.running ? '（正在运行）' : '（没检测到在运行）' }} <a @click="scan()">重新检测</a></div>
            <div v-if="!sl.accounts.length" class="card warn">SnowLuma 里还没有登录的账号。先在 SnowLuma 里登录机器人的 QQ，再点「重新检测」。</div>
            <div v-for="a in sl.accounts" :key="a.uin" class="card acct">
              <div class="min0">
                <b>{{ a.nickname ? `${a.nickname}（${a.uin}）` : a.uin }}</b>
                <div class="checks">
                  <span :class="a.http?.ok ? 'ok' : 'bad'">HTTP {{ !a.http ? '未开启' : a.http.ok ? '可以连接' : a.http.error }}</span>
                  <span :class="a.ws?.ok ? 'ok' : 'bad'">WebSocket {{ !a.ws ? '未开启' : a.ws.ok ? '可以连接' : a.ws.error }}</span>
                </div>
                <div v-if="!a.http || !a.ws" class="hint">在 SnowLuma 的网页控制台里，给这个账号添加{{ !a.http && !a.ws ? ' HTTP 服务器和 WebSocket 服务器' : !a.http ? ' HTTP 服务器' : ' WebSocket 服务器（正向）' }}，保存后点「重新检测」。</div>
                <div v-else-if="!a.http.ok || !a.ws.ok" class="hint">{{ sl.running ? '端口连不上：确认这个账号在 SnowLuma 里已经上线。' : 'SnowLuma 没在运行，先把它打开。' }}</div>
              </div>
              <n-button type="primary" size="small" :disabled="!a.http || !a.ws" :loading="using === a.uin" @click="useAccount(a.uin)">用这个账号</n-button>
            </div>
          </template>
        </n-spin>
        <n-alert v-if="connected" type="success" :show-icon="false" class="gap">已连上 QQ：{{ self?.nickname }}（{{ self?.userId }}）。之后 QAB 启动时会自动连接、断线自动重连。</n-alert>
        <n-alert v-else-if="conn && !conn.ok" type="error" :show-icon="false" class="gap">没连上：{{ conn.error }}</n-alert>
        <a class="more" @click="manual = !manual">{{ manual ? '收起' : '不用 SnowLuma，手动填写地址' }}</a>
        <n-collapse-transition :show="manual">
          <div class="card">
            <div class="grid">
              <label>WebSocket 地址<n-input v-model:value="mform.wsUrl" /></label>
              <label>HTTP 地址<n-input v-model:value="mform.httpUrl" /></label>
              <label>Access Token<n-input v-model:value="mform.accessToken" type="password" show-password-on="click" placeholder="没有就留空" /></label>
              <label>HTTP Token<n-input v-model:value="mform.httpToken" type="password" show-password-on="click" placeholder="和上面一样就留空" /></label>
            </div>
            <n-button size="small" :loading="using === 'manual'" @click="useManual">连接</n-button>
          </div>
        </n-collapse-transition>
        <footer class="nav"><span /><n-button type="primary" :disabled="!connected" @click="next">下一步</n-button></footer>
      </section>

      <!-- 2 接入 AI -->
      <section v-if="step === 1" class="body">
        <p class="lead">回复由 DeepSeek Harness（DSH）里的 AI 完成。QAB 会在 DSH 里注册工具和预设，不会改动你在 DSH 里的其他会话。</p>
        <n-spin :show="checking">
          <ul class="list">
            <li v-for="c in dshChecks" :key="c.label" :class="c.ok ? 'ok' : 'bad'">
              <span class="mark">{{ c.ok ? '✓' : '✗' }}</span>{{ c.label }}<span v-if="!c.ok" class="hint">　{{ c.fix }}</span>
            </li>
          </ul>
          <div class="row">
            <n-button size="small" @click="checkDsh">重新检测</n-button>
            <n-button v-if="dsh?.installed" size="small" type="primary" :loading="installing" @click="installDsh">{{ dsh?.connected ? '重新接入' : '一键接入' }}</n-button>
          </div>
          <n-alert v-if="installResult?.restartRequired" type="warning" :show-icon="false" class="gap">已写入 DSH 配置。请重启 DSH，然后点「重新检测」。</n-alert>
          <n-alert v-for="w in installResult?.warnings ?? []" :key="w" type="warning" :show-icon="false" class="gap">{{ w }}</n-alert>

          <div v-if="dshReady" class="card gap">
            <b>用哪个模型回复</b>
            <div v-if="models.catalog.value?.ok" class="grid">
              <label>服务商<n-select :value="mf.provider" :options="models.providerOptions.value" @update:value="models.pickProvider" /></label>
              <label>模型<n-select :value="mf.model" :options="models.modelOptions.value" filterable @update:value="models.pickModel" /></label>
              <label>思考强度<n-select v-model:value="mf.reasoningEffort" :options="models.effortOptions.value" /></label>
            </div>
            <div v-else class="hint">读不到 DSH 的模型列表，会用 DSH 的默认模型。之后可以在「AI 接入」里改。</div>
            <div v-if="models.invalid.value" class="hint bad">当前选的模型在 DSH 里不存在，请重新选择。</div>
          </div>
        </n-spin>
        <footer class="nav">
          <n-button @click="step--">上一步</n-button>
          <span class="grow" />
          <a v-if="!dshReady" class="skip" @click="next">先跳过（只用 MCP 客户端，机器人不会自己回复）</a>
          <n-button type="primary" :disabled="!dshReady || models.invalid.value" @click="next">下一步</n-button>
        </footer>
      </section>

      <!-- 3 在哪里回复 -->
      <section v-if="step === 2" class="body">
        <label class="field">
          <b>管理员 QQ</b>
          <span class="hint">只有管理员能用 QQ 里的管理指令（如 /仿真 关），AI 也只听管理员的要求。填你自己的 QQ 号，回车添加。</span>
          <n-dynamic-tags v-model:value="owners" />
        </label>
        <div class="field">
          <b>在哪些会话回复</b>
          <n-radio-group v-model:value="mode">
            <n-radio value="all">全部启用（之后可以单独关掉某个会话）</n-radio>
            <n-radio value="allowlist">只在勾选的会话里回复</n-radio>
          </n-radio-group>
          <span class="hint">没启用的会话，AI 不会回复，也看不到。管理员私聊始终启用。之后都可以在「回复与人格设置」里改。</span>
        </div>
        <div v-if="mode === 'allowlist'" class="card">
          <n-input v-model:value="q" size="small" placeholder="搜索群名、昵称或号码" clearable />
          <div class="convs">
            <n-checkbox v-for="c in shownConvs" :key="c.conv" :checked="picked.includes(c.conv)" @update:checked="(v: boolean) => toggle(c.conv, v)">
              {{ c.name || c.conv }} <span class="hint">{{ c.conv.startsWith('group:') ? '群' : '私聊' }} {{ c.conv.split(':')[1] }}</span>
            </n-checkbox>
            <div v-if="!shownConvs.length" class="hint">没有找到会话</div>
          </div>
          <div class="hint">已勾选 {{ picked.length }} 个</div>
        </div>
        <footer class="nav"><n-button @click="step--">上一步</n-button><span class="grow" /><n-button type="primary" @click="next">下一步</n-button></footer>
      </section>

      <!-- 4 试一试 -->
      <section v-if="step === 3" class="body">
        <p class="lead">设置好了。现在用另一个 QQ 号{{ mode === 'all' ? '在任意一个群里 @ 机器人，或者私聊它' : '在勾选的群里 @ 机器人，或者私聊它' }}，下面会实时显示它怎么处理；卡在哪一步会写明原因。</p>
        <ReplyFlow :running="state.status?.agent?.running ?? []" :offline="state.status?.connection !== 'open'" :driver-problem="(state.status?.agent?.problems ?? []).map((p: any) => `${p.label}：${p.detail}`).join('；')" :limit="3" />
        <footer class="nav"><n-button @click="step--">上一步</n-button><span class="grow" /><n-button type="primary" @click="finish">完成，进入控制台</n-button></footer>
      </section>
    </div>
  </div>
</template>

<style scoped>
.wrap { min-height: 100vh; display: flex; justify-content: center; padding: 32px 16px; box-sizing: border-box; background: linear-gradient(135deg, rgba(18,183,245,.12), rgba(18,183,245,0)); }
.box { width: 100%; max-width: 720px; display: flex; flex-direction: column; gap: 14px; }
.top { display: flex; align-items: center; justify-content: space-between; font-size: 16px; }
a { color: #12b7f5; cursor: pointer; }
.skip { font-size: 12px; opacity: .75; }
.bar { display: flex; gap: 6px; margin: 0; padding: 0; list-style: none; }
.bar li { flex: 1; display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-radius: 8px; font-size: 13px; background: rgba(128,128,128,.08); opacity: .6; }
.bar li.on { opacity: 1; background: rgba(18,183,245,.14); font-weight: 600; }
.bar li.done { opacity: .9; cursor: pointer; }
.n { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 50%; font-size: 12px; background: rgba(128,128,128,.2); }
.on .n { background: #12b7f5; color: #fff; }
.done .n { background: #18a058; color: #fff; }
.body { display: flex; flex-direction: column; gap: 10px; padding: 16px; border-radius: 10px; background: var(--card, rgba(128,128,128,.05)); border: 1px solid rgba(128,128,128,.16); }
.lead { margin: 0; font-size: 13.5px; line-height: 1.6; }
.hint { font-size: 12px; opacity: .65; line-height: 1.5; }
.card { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: 8px; border: 1px solid rgba(128,128,128,.18); }
.card.warn { border-color: rgba(240,160,32,.5); font-size: 13px; }
.acct { flex-direction: row; align-items: center; gap: 12px; }
.min0 { flex: 1; min-width: 0; }
.checks { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 4px 0; font-size: 12.5px; }
.ok { color: #18a058; }
.bad { color: #d03050; }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 8px 12px; }
.grid label { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; }
.more { font-size: 12.5px; }
.gap { margin-top: 4px; }
.list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; font-size: 13.5px; }
.mark { display: inline-block; width: 18px; font-weight: 700; }
.field { display: flex; flex-direction: column; gap: 6px; }
.convs { display: flex; flex-direction: column; gap: 4px; max-height: 260px; overflow: auto; }
.nav { display: flex; align-items: center; gap: 10px; margin-top: 4px; }
.grow { flex: 1; }
@media (max-width: 640px) { .bar li { font-size: 0; justify-content: center; } .bar li .n { font-size: 12px; } .acct { flex-direction: column; align-items: stretch; } }
</style>
