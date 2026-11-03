<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { NCard, NForm, NFormItem, NInput, NInputNumber, NSwitch, NButton, NSpace, NDynamicTags, NRadioGroup, NRadio, NText, NAlert, NSpin, NProgress, NTag, NTabs, NTabPane, useMessage, useThemeVars } from 'naive-ui';
import { api, onPush, isNarrow, state } from '../api';

const msg = useMessage();
const advQQ = ref(false);
const advUpd = ref(false);
const scan = ref<any>(null);
const testing = ref(false);
const using = ref('');
const connResult = ref<any>(null);
async function testConn() {
  testing.value = true; connResult.value = null;
  try { scan.value = await api('/api/wizard/snowluma', { body: { home: cfg.value?.onebot.snowlumaHome ?? '' } }); } catch (e: any) { msg.error(e.message); } finally { testing.value = false; }
}
async function useAccount(uin: string) {
  using.value = uin;
  try { connResult.value = await api('/api/wizard/snowluma/use', { body: { home: scan.value.home, uin } }); await load(); } catch (e: any) { msg.error(e.message); } finally { using.value = ''; }
}
async function rerunWizard() {
  await api('/api/wizard/restart', { method: 'POST' });
  state.status = { ...(state.status ?? {}), wizard: 'pending' };
}
const theme = useThemeVars();
const cfg = ref<any>(null);
const accounts = ref<string[]>([]);
const saving = ref(false);

const tab = ref('basic');
const saved = ref('');
const dirty = computed(() => !!cfg.value && JSON.stringify(cfg.value) !== saved.value);
async function load() { const r = await api('/api/config'); cfg.value = r.config; saved.value = JSON.stringify(r.config); accounts.value = r.snowlumaAccounts; }
async function save() {
  saving.value = true;
  try { await api('/api/config', { method: 'PUT', body: cfg.value }); msg.success('已保存'); load(); }
  catch (e: any) { msg.error(e.message); } finally { saving.value = false; }
}
onMounted(load);

// ---------------- 版本与更新
const upd = ref<any>(null);
const checking = ref(false);
const showNotes = ref(false);
async function loadUpd() { upd.value = await api('/api/update').catch(() => null); }
async function checkUpd() {
  checking.value = true;
  try { upd.value = await api('/api/update/check', { body: {} }); if (upd.value.error) msg.error(upd.value.error); else msg.success(upd.value.hasUpdate ? `发现新版本 v${upd.value.latest}` : '已是最新版本'); }
  catch (e: any) { msg.error(e.message); } finally { checking.value = false; }
}
async function installUpd() { try { await api('/api/update/install', { body: {} }); } catch (e: any) { msg.error(e.message); } }
async function cancelUpd() { upd.value = await api('/api/update/cancel', { body: {} }); }
const off = onPush((type, st) => { if (type === 'update') upd.value = st; });
onMounted(loadUpd);
onUnmounted(() => off?.());
const fmtSize = (n: number) => (n ? `${(n / 1048576).toFixed(1)} MB` : '');
</script>

<template>
  <n-spin :show="!cfg">
    <div v-if="cfg" class="settings">
      <n-tabs v-model:value="tab" type="line" size="small" :placement="isNarrow ? 'top' : 'left'" :pane-style="isNarrow ? '' : 'padding-left: 16px'">






        <n-tab-pane name="basic" tab="基本">
          <div class="section"><h3>机器人启动</h3>
            <n-form :label-placement="isNarrow ? 'top' : 'left'" label-width="120">
              <n-form-item label="启动时自动连接"><n-switch v-model:value="cfg.bot.autoConnect" /><span class="switch-hint">关闭时只有在仪表盘点启动才连接 QQ</span></n-form-item>
              <n-form-item label="断开后自动重连"><n-switch v-model:value="cfg.bot.autoReconnect" /><span class="switch-hint">关闭时 SnowLuma 断开后机器人就停止</span></n-form-item>
            </n-form>
          </div>
          <div class="section"><h3>管理员</h3>
            <n-form :label-placement="isNarrow ? 'top' : 'left'" label-width="120">
              <n-form-item label="管理员 QQ"><n-dynamic-tags v-model:value="cfg.owners" /></n-form-item>
              <n-form-item label="对管理员的称呼"><n-input v-model:value="cfg.ownerTitle" placeholder="管理员 / 主人 / 老板…" style="width: 200px" /></n-form-item>
            </n-form>
          </div>
          <div class="section"><h3>设置向导</h3>
            <p class="hint">重新走一遍首次设置：连接 QQ、接入 AI、选择在哪里回复。已有的设置会作为默认值，不会被清空。</p>
            <n-button size="small" @click="rerunWizard">重新运行设置向导</n-button>
          </div>
        </n-tab-pane>

        <n-tab-pane name="qq" tab="QQ 连接">
          <div class="section">
            <n-form :label-placement="isNarrow ? 'top' : 'left'" label-width="120">
              <n-form-item label="SnowLuma 目录"><n-input v-model:value="cfg.onebot.snowlumaHome" placeholder="SnowLuma 所在的文件夹（里面有 config 文件夹）" /></n-form-item>
            </n-form>
            <n-space :size="6" style="margin-bottom: 8px">
              <n-button size="small" :loading="testing" @click="testConn">测试连接</n-button>
              <span class="switch-hint">检查 SnowLuma 里每个账号的 HTTP、WebSocket 服务能不能连上</span>
            </n-space>
            <div v-for="a in scan?.accounts ?? []" :key="a.uin" class="acct">
              <b>{{ a.nickname ? `${a.nickname}（${a.uin}）` : a.uin }}</b>
              <span :class="a.http?.ok ? 'ok' : 'bad'">HTTP {{ !a.http ? '未开启' : a.http.ok ? '可以连接' : a.http.error }}</span>
              <span :class="a.ws?.ok ? 'ok' : 'bad'">WebSocket {{ !a.ws ? '未开启' : a.ws.ok ? '可以连接' : a.ws.error }}</span>
              <n-button v-if="a.http && a.ws" size="tiny" :loading="using === a.uin" @click="useAccount(a.uin)">用这个账号</n-button>
            </div>
            <n-alert v-if="scan && !scan.valid" type="warning" :show-icon="false">这个目录里没有 SnowLuma 的账号配置（config/onebot_*.json）。</n-alert>
            <n-alert v-if="connResult" :type="connResult.ok ? 'success' : 'error'" :show-icon="false" style="margin-top: 8px">{{ connResult.ok ? `已连上：${connResult.self.nickname}（${connResult.self.userId}）` : `没连上：${connResult.error}` }}</n-alert>
          </div>
          <button type="button" class="adv-toggle" @click="advQQ = !advQQ">{{ advQQ ? '▾' : '▸' }} 高级设置<span class="switch-hint">　手动填写地址和 token（不用 SnowLuma 时）、超时</span></button>
          <div v-if="advQQ" class="section">
            <n-form :label-placement="isNarrow ? 'top' : 'left'" label-width="120">
              <n-form-item label="自动发现"><n-switch v-model:value="cfg.onebot.autoDiscover" /><span class="switch-hint">从 SnowLuma 配置读取端口与 token，换号不用改</span></n-form-item>
            </n-form>
            <n-form class="form-2" :label-placement="isNarrow ? 'top' : 'left'" label-width="120">
              <n-form-item label="WS 地址"><n-input v-model:value="cfg.onebot.wsUrl" /></n-form-item>
              <n-form-item label="HTTP 地址"><n-input v-model:value="cfg.onebot.httpUrl" /></n-form-item>
              <n-form-item label="WS Token"><n-input v-model:value="cfg.onebot.accessToken" type="password" show-password-on="click" placeholder="留空 = 不修改" /></n-form-item>
              <n-form-item label="HTTP Token"><n-input v-model:value="cfg.onebot.httpToken" type="password" show-password-on="click" placeholder="和 WS 相同就留空" /></n-form-item>
              <n-form-item label="动作超时 (ms)"><n-input-number v-model:value="cfg.onebot.actionTimeoutMs" :min="1000" :step="1000" /></n-form-item>
            </n-form>
          </div>
        </n-tab-pane>

        <n-tab-pane name="update" :tab="upd?.hasUpdate ? '版本更新 ●' : '版本更新'">
          <div class="section">
            <div v-if="!upd" class="hint">当前运行方式不支持检查更新。</div>
            <n-space v-else vertical :size="8">
              <div>
                当前 <b>v{{ upd.current }}</b>
                <template v-if="upd.latest">，最新 <b>v{{ upd.latest }}</b>
                  <n-tag size="small" :type="upd.hasUpdate ? 'warning' : 'success'" :bordered="false" style="margin-left: 6px">{{ upd.hasUpdate ? '有新版本' : '已是最新' }}</n-tag>
                </template>
                <span v-if="upd.checkedAt" class="switch-hint">{{ new Date(upd.checkedAt).toLocaleString() }} 检查</span>
              </div>
              <n-alert v-if="upd.lastUpdate" type="success" :show-icon="false">已从 v{{ upd.lastUpdate.from }} 更新到 v{{ upd.lastUpdate.to }}</n-alert>
              <n-alert v-if="upd.lastFailure" type="error" :show-icon="false">上次更新失败：{{ upd.lastFailure }}</n-alert>
              <n-alert v-if="upd.phase === 'error' && upd.error" type="error" :show-icon="false">{{ upd.error }}</n-alert>
              <div v-if="upd.phase === 'downloading' || upd.phase === 'preparing'">
                <n-text>{{ upd.phase === 'downloading' ? `正在下载 ${upd.asset}（${fmtSize(upd.assetSize)}）` : '正在准备安装…' }}</n-text>
                <n-progress type="line" :percentage="upd.progress" :show-indicator="upd.phase === 'downloading'" />
              </div>
              <n-alert v-if="upd.phase === 'staged'" type="info" :show-icon="false">v{{ upd.stagedVersion }} 已下载好，{{ upd.supervised ? '正在重启以完成更新…' : '重新启动程序后自动安装（个人配置与数据不受影响）' }}</n-alert>
              <n-alert v-if="upd.hasUpdate && upd.installType !== 'package'" type="warning" :show-icon="false">{{ upd.hint }}</n-alert>
              <n-space :size="6">
                <n-button size="small" :loading="checking || upd.phase === 'checking'" @click="checkUpd">检查更新</n-button>
                <n-button v-if="upd.hasUpdate && upd.installType === 'package' && upd.phase !== 'staged'" size="small" type="primary" :loading="upd.phase === 'downloading' || upd.phase === 'preparing'" @click="installUpd">下载并更新到 v{{ upd.latest }}</n-button>
                <n-button v-if="upd.phase === 'staged'" size="small" @click="cancelUpd">取消更新</n-button>
                <n-button v-if="upd.notes" size="small" quaternary @click="showNotes = !showNotes">{{ showNotes ? '收起' : '更新内容' }}</n-button>
                <n-button v-if="upd.url" size="small" quaternary tag="a" :href="upd.url" target="_blank">发布页</n-button>
              </n-space>
              <pre v-if="showNotes" class="notes">{{ upd.notes }}</pre>
            </n-space>
          </div>
          <div v-if="cfg.update" class="section"><h3>更新方式</h3>
            <n-form :label-placement="isNarrow ? 'top' : 'left'" label-width="120">
              <n-form-item label="自动检查"><n-switch v-model:value="cfg.update.check" /><span class="switch-hint">每 {{ cfg.update.checkIntervalHours }} 小时</span></n-form-item>
              <n-form-item label="自动安装"><n-switch v-model:value="cfg.update.autoInstall" /><span class="switch-hint">发现新版本自动下载，由 start.bat 启动时随即重启</span></n-form-item>
            </n-form>
            <button type="button" class="adv-toggle" @click="advUpd = !advUpd">{{ advUpd ? '▾' : '▸' }} 高级设置<span class="switch-hint">　预发布版、通知、代理、下载加速</span></button>
            <n-form v-if="advUpd" :label-placement="isNarrow ? 'top' : 'left'" label-width="120">
              <n-form-item label="包含预发布版"><n-switch v-model:value="cfg.update.prerelease" /></n-form-item>
              <n-form-item label="通知管理员"><n-switch v-model:value="cfg.update.notifyOwner" /><span class="switch-hint">发现新版本时私聊管理员</span></n-form-item>
              <n-form-item label="代理"><n-input v-model:value="cfg.update.proxy" placeholder="留空读取 HTTPS_PROXY，如 http://127.0.0.1:7890" /></n-form-item>
              <n-form-item label="下载加速"><n-input v-model:value="cfg.update.mirror" placeholder="可选，如 https://ghfast.top/" /></n-form-item>
            </n-form>
          </div>
        </n-tab-pane>

        <n-tab-pane name="advanced" tab="高级">
          <p class="hint" style="margin-top: 0">这些一般不用动。改错了可能导致发不出消息或被风控。</p>
          <div class="section"><h3>发送上限</h3>
            <p class="hint">只约束 Agent 与插件，避免刷屏触发账号风控。</p>
            <n-form class="form-2" :label-placement="isNarrow ? 'top' : 'left'" label-width="130">
              <n-form-item label="全局每分钟"><n-input-number v-model:value="cfg.limits.sendPerMinute" :min="1" /></n-form-item>
              <n-form-item label="全局每小时"><n-input-number v-model:value="cfg.limits.sendPerHour" :min="1" /></n-form-item>
              <n-form-item label="单会话每分钟"><n-input-number v-model:value="cfg.limits.convPerMinute" :min="1" /></n-form-item>
              <n-form-item label="单条最大字数"><n-input-number v-model:value="cfg.limits.maxMessageChars" :min="10" /></n-form-item>
            </n-form>
          </div>
          <div class="section"><h3>分条间隔 (ms)</h3>
            <n-form class="form-2" :label-placement="isNarrow ? 'top' : 'left'" label-width="130">
              <n-form-item label="基础"><n-input-number v-model:value="cfg.limits.gapBaseMs" :min="0" :step="100" /></n-form-item>
              <n-form-item label="每字增加"><n-input-number v-model:value="cfg.limits.gapPerCharMs" :min="0" /></n-form-item>
              <n-form-item label="上限"><n-input-number v-model:value="cfg.limits.gapMaxMs" :min="0" :step="500" /></n-form-item>
            </n-form>
          </div>
          <div class="section"><h3>媒体</h3>
            <n-form :label-placement="isNarrow ? 'top' : 'left'" label-width="140">
              <n-form-item label="Agent 可读取的目录"><n-dynamic-tags v-model:value="cfg.media.uploadRoots" /></n-form-item>
            </n-form>
            <n-form class="form-2" :label-placement="isNarrow ? 'top' : 'left'" label-width="140">
              <n-form-item label="内联图片上限 (字节)"><n-input-number v-model:value="cfg.media.maxInlineImageBytes" :min="10240" :step="102400" /></n-form-item>
              <n-form-item label="下载上限 (字节)"><n-input-number v-model:value="cfg.media.maxDownloadBytes" :min="102400" :step="1048576" /></n-form-item>
            </n-form>
            <p class="hint">可读取目录为空时，Agent 可发送任意本地文件；建议限定到专门的素材目录。</p>
          </div>
          <div class="section"><h3>插件</h3>
            <n-form :label-placement="isNarrow ? 'top' : 'left'" label-width="140">
              <n-form-item label="命令前缀"><n-dynamic-tags v-model:value="cfg.plugins.commandPrefixes" /></n-form-item>
              <n-form-item label="AstrBot 兼容层"><n-switch v-model:value="cfg.plugins.astrbot.enabled" /><span class="switch-hint">需重启生效</span></n-form-item>
            </n-form>
            <n-form v-if="cfg.plugins.astrbot.enabled" class="form-2" :label-placement="isNarrow ? 'top' : 'left'" label-width="140">
              <n-form-item label="Python 路径"><n-input v-model:value="cfg.plugins.astrbot.python" /></n-form-item>
              <n-form-item label="AstrBot 插件目录"><n-input v-model:value="cfg.plugins.astrbot.dir" /></n-form-item>
            </n-form>
          </div>
          <div class="section"><h3>控制台</h3>
            <p class="hint">监听地址和端口修改后需重启。监听 0.0.0.0 会允许局域网访问，请设置强密码。</p>
            <n-form class="form-2" :label-placement="isNarrow ? 'top' : 'left'" label-width="120">
              <n-form-item label="监听地址"><n-input v-model:value="cfg.server.host" /></n-form-item>
              <n-form-item label="端口"><n-input-number v-model:value="cfg.server.port" :min="1" :max="65535" /></n-form-item>
              <n-form-item label="控制台密码"><n-input v-model:value="cfg.server.consolePassword" type="password" show-password-on="click" /></n-form-item>
            </n-form>
          </div>
        </n-tab-pane>
      </n-tabs>
      <div class="savebar" :style="{ background: theme.bodyColor }">
        <n-text :depth="dirty ? 1 : 3" style="flex: 1; font-size: 12px">{{ dirty ? '有未保存的修改' : '所有修改已保存' }}</n-text>
        <n-button size="small" :disabled="!dirty" @click="load">放弃修改</n-button>
        <n-button size="small" type="primary" :disabled="!dirty" :loading="saving" @click="save">保存全部设置</n-button>
      </div>
    </div>
  </n-spin>
</template>

<style scoped>
.settings { max-width: 900px; }
.section { padding-bottom: 8px; margin-bottom: 14px; border-bottom: 1px solid rgba(128,128,128,.14); }
.section:last-child { border-bottom: 0; margin-bottom: 0; }
.section h3 { margin: 0 0 8px; font-size: 13px; font-weight: 600; }
.section .hint { margin: 0 0 8px; }
.notes { white-space: pre-wrap; font-size: 12px; max-height: 300px; overflow: auto; margin: 0; }
/* 保存按钮始终可见 */
.savebar { position: sticky; bottom: 0; z-index: 2; margin-top: 12px; display: flex; align-items: center; gap: 8px; padding: 8px 0; border-top: 1px solid rgba(128,128,128,.2); }
.adv-toggle { display: block; margin: 4px 0 10px; padding: 4px 0; border: 0; background: none; color: inherit; font: inherit; font-size: 13px; cursor: pointer; }
.acct { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; padding: 6px 0; font-size: 13px; }
.ok { color: #18a058; }
.bad { color: #d03050; }
</style>
