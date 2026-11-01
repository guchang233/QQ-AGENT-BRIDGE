<script setup lang="ts">
import { computed, h, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter, RouterView } from 'vue-router';
import {
  NConfigProvider, NMessageProvider, NDialogProvider, NNotificationProvider, NLayout, NLayoutSider, NLayoutHeader, NLayoutContent,
  NMenu, NBadge, NTag, NSpace, NButton, NSpin, NIcon, darkTheme, zhCN, dateZhCN, useOsTheme, type MenuOption, type GlobalThemeOverrides,
} from 'naive-ui';
import {
  SpeedometerOutline, ChatbubblesOutline, PlanetOutline, HappyOutline, HardwareChipOutline, ListOutline, ExtensionPuzzleOutline,
  TerminalOutline, BookOutline, DocumentTextOutline, SettingsOutline, MoonOutline, SunnyOutline, LogOutOutline, PeopleOutline, StatsChartOutline, PulseOutline,
} from '@vicons/ionicons5';
import { state, checkSession, api, isNarrow } from './api';
import Login from './components/Login.vue';
import ApprovalWatcher from './components/ApprovalWatcher.vue';
import StatusPill from './components/StatusPill.vue';

const os = useOsTheme();
const dark = ref(localStorage.getItem('qab-theme') ? localStorage.getItem('qab-theme') === 'dark' : os.value === 'dark');
watch(dark, (v) => localStorage.setItem('qab-theme', v ? 'dark' : 'light'));
const theme = computed(() => (dark.value ? darkTheme : null));
// 让浏览器自带的部分（滚动条、页面底色）跟随主题，切换和加载时不闪白
watch(dark, (v) => { document.documentElement.style.colorScheme = v ? 'dark' : 'light'; document.body.style.background = v ? 'rgb(16, 16, 20)' : '#fff'; }, { immediate: true });
const overrides: GlobalThemeOverrides = {
  common: { primaryColor: '#12b7f5', primaryColorHover: '#3cc6f7', primaryColorPressed: '#0b9fd6', primaryColorSuppl: '#12b7f5',
    fontSize: '13px', fontSizeMedium: '13px', fontSizeSmall: '12px', fontSizeTiny: '12px', heightMedium: '30px', heightSmall: '26px', heightTiny: '22px' },
  Card: { paddingSmall: '10px 12px 12px', titleFontSizeSmall: '13px', titleFontWeight: '600' },
  DataTable: { thPaddingSmall: '6px 10px', tdPaddingSmall: '5px 10px', fontSizeSmall: '12px' },
  Menu: { itemHeight: '32px', groupTextColor: 'rgba(128, 128, 128, .9)' },
  Form: { feedbackHeightMedium: '10px', feedbackHeightSmall: '8px', labelHeightMedium: '30px' },
};

const route = useRoute();
const router = useRouter();
const collapsed = ref(window.innerWidth < 900);
let wasWide = window.innerWidth >= 900;
window.addEventListener('resize', () => { const wide = window.innerWidth >= 900; if (wide !== wasWide) collapsed.value = !wide; wasWide = wide; });
watch(() => route.meta.title, (t) => { document.title = t ? `${t} · QQ-Agent Bridge` : 'QQ-Agent Bridge'; }, { immediate: true });
const siderMini = computed(() => (isNarrow.value ? 52 : 64));
const icon = (c: any) => () => h(NIcon, null, { default: () => h(c) });
const menu = computed<MenuOption[]>(() => [
  { type: 'group', label: '概览', key: 'g0', children: [
    { label: '仪表盘', key: '/dashboard', icon: icon(SpeedometerOutline) },
    { label: '动态', key: '/activity', icon: icon(PulseOutline) },
  ] },
  { type: 'group', label: 'QQ', key: 'g1', children: [
    { label: '聊天', key: '/chat', icon: icon(ChatbubblesOutline) },
    { label: 'QQ空间', key: '/qzone', icon: icon(PlanetOutline) },
    { label: '表情包', key: '/stickers', icon: icon(HappyOutline) },
  ] },
  { type: 'group', label: 'AI', key: 'g2', children: [
    { label: () => h(NBadge, { value: state.approvals.length, offset: [14, 0] }, { default: () => 'Agent 接入' }), key: '/agent', icon: icon(HardwareChipOutline) },
    { label: '仿真与人格', key: '/social', icon: icon(PeopleOutline) },
    { label: '记忆', key: '/memory', icon: icon(BookOutline) },
    { label: '用量', key: '/usage', icon: icon(StatsChartOutline) },
  ] },
  { type: 'group', label: '系统', key: 'g3', children: [
    { label: '插件', key: '/plugins', icon: icon(ExtensionPuzzleOutline) },
    { label: '调用审计', key: '/audit', icon: icon(ListOutline) },
    { label: '动作调试台', key: '/actions', icon: icon(TerminalOutline) },
    { label: '日志', key: '/logs', icon: icon(DocumentTextOutline) },
    { label: '设置', key: '/settings', icon: icon(SettingsOutline) },
  ] },
]);
const active = computed(() => '/' + (route.path.split('/')[1] ?? ''));
onMounted(() => checkSession().catch(() => { state.checked = true; }));
async function logout() { await api('/api/logout', { method: 'POST' }); location.reload(); }
</script>

<template>
  <n-config-provider :theme="theme" :theme-overrides="overrides" :locale="zhCN" :date-locale="dateZhCN">
    <n-message-provider>
      <n-notification-provider>
        <n-dialog-provider>
          <div v-if="!state.checked" class="center"><n-spin /></div>
          <Login v-else-if="!state.authed" />
          <n-layout v-else has-sider style="height: 100vh">
            <n-layout-sider bordered collapse-mode="width" :collapsed-width="siderMini" :width="176" :collapsed="collapsed" :native-scrollbar="false" :show-trigger="!isNarrow" @collapse="collapsed = true" @expand="collapsed = false">
              <div class="brand" @click="router.push('/dashboard')">🐧<span v-if="!collapsed"> QQ-Agent Bridge</span></div>
              <n-menu :value="active" :options="menu" :collapsed="collapsed" :collapsed-width="siderMini" @update:value="(k: string) => router.push(k)" />
            </n-layout-sider>
            <n-layout>
              <n-layout-header bordered class="header">
                <div class="title">{{ route.meta.title }}</div>
                <n-space align="center">
                  <span v-if="state.status?.self" class="self">{{ state.status.self.nickname }}（{{ state.status.self.userId }}）</span>
                  <StatusPill />
                  <n-tag v-if="state.status?.readOnly" type="warning" size="small" round>只读模式</n-tag>
                  <n-button quaternary circle size="small" :title="dark ? '切换到浅色' : '切换到深色'" :aria-label="dark ? '切换到浅色' : '切换到深色'" @click="dark = !dark"><template #icon><n-icon :component="dark ? SunnyOutline : MoonOutline" /></template></n-button>
                  <n-button quaternary circle size="small" title="退出登录" aria-label="退出登录" @click="logout"><template #icon><n-icon :component="LogOutOutline" /></template></n-button>
                </n-space>
              </n-layout-header>
              <n-layout-content class="content" :native-scrollbar="false" :content-style="`padding: ${isNarrow ? 10 : 16}px; height: 100%;`">
                <div :class="route.path.startsWith('/chat') || route.path.startsWith('/logs') ? 'page-full' : 'page-wrap'"><RouterView /></div>
              </n-layout-content>
            </n-layout>
            <ApprovalWatcher />
          </n-layout>
        </n-dialog-provider>
      </n-notification-provider>
    </n-message-provider>
  </n-config-provider>
</template>

<style>
html, body, #app { margin: 0; height: 100%; font-family: -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif; }
.center { display: flex; height: 100vh; align-items: center; justify-content: center; }
.brand { height: 44px; display: flex; align-items: center; justify-content: center; font-weight: 600; font-size: 15px; cursor: pointer; white-space: nowrap; overflow: hidden; }
.header { height: 44px; box-sizing: border-box; display: flex; align-items: center; justify-content: space-between; padding: 0 16px; }
.header .title { font-size: 14px; font-weight: 600; white-space: nowrap; }
.header .self { font-size: 12px; opacity: .7; }
.content { height: calc(100vh - 45px); }

/* 通用版式：区块之间拉开，区块内部收紧 */
.page-wrap { max-width: 1320px; margin: 0 auto; }
.page { display: flex; flex-direction: column; gap: 10px; }
.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; }
.toolbar .grow { flex: 1; }
.hint { font-size: 12px; opacity: .6; }
.switch-hint { margin-left: 8px; font-size: 12px; opacity: .6; }
.ministats { font-variant-numeric: tabular-nums; }
.kv { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 3px 12px; margin: 0; font-size: 12px; }
.kv dt { opacity: .6; }
.kv dd { margin: 0; overflow-wrap: anywhere; }
.form-2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 20px; }
.form-2 .full { grid-column: 1 / -1; }
.form-2 .n-input-number { width: 100%; }
.n-form-item.n-form-item--left-labelled .n-form-item-label { font-size: 12px; }

/* 机器人状态配色（仪表盘与顶栏共用） */
.st-offline { --c: #8a8f98; }
.st-idle { --c: #18a058; }
.st-receiving { --c: #2080f0; }
.st-thinking { --c: #8a63d2; }
.st-sending { --c: #0e9f9f; }
.st-connecting { --c: #f0a020; }
.bot-dot { flex: none; display: inline-block; width: 12px; height: 12px; border-radius: 50%; background: var(--c); }
.st-receiving .bot-dot, .st-thinking .bot-dot, .st-sending .bot-dot, .st-connecting .bot-dot { animation: bot-pulse 1.1s ease-in-out infinite; }
@keyframes bot-pulse { 50% { opacity: .3; transform: scale(.75); } }
@media (prefers-reduced-motion: reduce) { .bot-dot { animation: none !important; } }
code { overflow-wrap: anywhere; }
@media (max-width: 640px) {
  .header { padding: 0 10px; }
  .header .self { display: none; }
  .form-2 { grid-template-columns: minmax(0, 1fr); }
  /* 卡片标题和右侧操作放不下时换行，别把标题挤成竖条 */
  .n-card.n-card > .n-card-header { flex-wrap: wrap; gap: 8px; }
  .n-card.n-card > .n-card-header .n-card-header__main { flex: 1 1 100%; }
  .n-card.n-card > .n-card-header .n-card-header__extra { margin-left: 0; }
}
</style>
