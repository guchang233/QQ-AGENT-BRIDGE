<script setup lang="ts">
import { computed, h, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter, RouterView } from 'vue-router';
import {
  NConfigProvider, NMessageProvider, NDialogProvider, NNotificationProvider, NLayout, NLayoutSider, NLayoutHeader, NLayoutContent,
  NMenu, NBadge, NTag, NSpace, NButton, NSpin, NIcon, darkTheme, zhCN, dateZhCN, useOsTheme, type MenuOption, type GlobalThemeOverrides,
} from 'naive-ui';
import {
  SpeedometerOutline, ChatbubblesOutline, PlanetOutline, HappyOutline, HardwareChipOutline, ListOutline, ExtensionPuzzleOutline,
  TerminalOutline, BookOutline, DocumentTextOutline, SettingsOutline, MoonOutline, SunnyOutline, LogOutOutline, PeopleOutline, StatsChartOutline,
} from '@vicons/ionicons5';
import { state, checkSession, api } from './api';
import Login from './components/Login.vue';
import ApprovalWatcher from './components/ApprovalWatcher.vue';

const os = useOsTheme();
const dark = ref(localStorage.getItem('qab-theme') ? localStorage.getItem('qab-theme') === 'dark' : os.value === 'dark');
watch(dark, (v) => localStorage.setItem('qab-theme', v ? 'dark' : 'light'));
const theme = computed(() => (dark.value ? darkTheme : null));
const overrides: GlobalThemeOverrides = { common: { primaryColor: '#12b7f5', primaryColorHover: '#3cc6f7', primaryColorPressed: '#0b9fd6', primaryColorSuppl: '#12b7f5' } };

const route = useRoute();
const router = useRouter();
const collapsed = ref(window.innerWidth < 900);
const icon = (c: any) => () => h(NIcon, null, { default: () => h(c) });
const menu = computed<MenuOption[]>(() => [
  { label: '仪表盘', key: '/dashboard', icon: icon(SpeedometerOutline) },
  { label: '聊天', key: '/chat', icon: icon(ChatbubblesOutline) },
  { label: 'QQ空间', key: '/qzone', icon: icon(PlanetOutline) },
  { label: '表情包', key: '/stickers', icon: icon(HappyOutline) },
  { type: 'divider', key: 'd1' },
  { label: () => h(NBadge, { value: state.approvals.length, offset: [14, 0] }, { default: () => 'Agent 接入' }), key: '/agent', icon: icon(HardwareChipOutline) },
  { label: '仿真与人格', key: '/social', icon: icon(PeopleOutline) },
  { label: '用量', key: '/usage', icon: icon(StatsChartOutline) },
  { label: '调用审计', key: '/audit', icon: icon(ListOutline) },
  { label: '插件', key: '/plugins', icon: icon(ExtensionPuzzleOutline) },
  { label: '动作调试台', key: '/actions', icon: icon(TerminalOutline) },
  { label: '记忆', key: '/memory', icon: icon(BookOutline) },
  { type: 'divider', key: 'd2' },
  { label: '日志', key: '/logs', icon: icon(DocumentTextOutline) },
  { label: '设置', key: '/settings', icon: icon(SettingsOutline) },
]);
const active = computed(() => '/' + (route.path.split('/')[1] ?? ''));
const connTag = computed(() => {
  const c = state.status?.connection;
  return c === 'open' ? { type: 'success' as const, text: '已连接' } : c === 'connecting' ? { type: 'warning' as const, text: '连接中' } : { type: 'error' as const, text: '未连接' };
});

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
            <n-layout-sider bordered collapse-mode="width" :collapsed-width="64" :width="200" :collapsed="collapsed" show-trigger @collapse="collapsed = true" @expand="collapsed = false">
              <div class="brand" @click="router.push('/dashboard')">🐧<span v-if="!collapsed"> QQ-Agent Bridge</span></div>
              <n-menu :value="active" :options="menu" :collapsed="collapsed" :collapsed-width="64" @update:value="(k: string) => router.push(k)" />
            </n-layout-sider>
            <n-layout>
              <n-layout-header bordered class="header">
                <div class="title">{{ route.meta.title }}</div>
                <n-space align="center">
                  <span v-if="state.status?.self" class="self">{{ state.status.self.nickname }}（{{ state.status.self.userId }}）</span>
                  <n-tag :type="connTag.type" size="small" round>{{ connTag.text }}</n-tag>
                  <n-tag v-if="state.status?.readOnly" type="warning" size="small" round>只读模式</n-tag>
                  <n-button quaternary circle size="small" @click="dark = !dark"><template #icon><n-icon :component="dark ? SunnyOutline : MoonOutline" /></template></n-button>
                  <n-button quaternary circle size="small" title="退出登录" @click="logout"><template #icon><n-icon :component="LogOutOutline" /></template></n-button>
                </n-space>
              </n-layout-header>
              <n-layout-content class="content" :native-scrollbar="false" content-style="padding: 16px; height: 100%;">
                <RouterView />
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
.brand { height: 52px; display: flex; align-items: center; justify-content: center; font-weight: 600; font-size: 15px; cursor: pointer; white-space: nowrap; overflow: hidden; }
.header { height: 52px; display: flex; align-items: center; justify-content: space-between; padding: 0 16px; }
.header .title { font-size: 16px; font-weight: 600; }
.header .self { font-size: 13px; opacity: .75; }
.content { height: calc(100vh - 53px); }
@media (max-width: 640px) { .header .self { display: none; } }
</style>
