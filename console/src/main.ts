import { createApp } from 'vue';
import { createRouter, createWebHashHistory } from 'vue-router';
import App from './App.vue';

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/dashboard' },
    { path: '/dashboard', component: () => import('./views/Dashboard.vue'), meta: { title: '仪表盘' } },
    { path: '/chat/:conv?', component: () => import('./views/Chat.vue'), meta: { title: '聊天' } },
    { path: '/qzone', component: () => import('./views/QZone.vue'), meta: { title: 'QQ空间' } },
    { path: '/stickers', component: () => import('./views/Stickers.vue'), meta: { title: '表情包' } },
    { path: '/agent', component: () => import('./views/Agent.vue'), meta: { title: 'Agent 接入' } },
    { path: '/social', component: () => import('./views/Social.vue'), meta: { title: '仿真与人格' } },
    { path: '/usage', component: () => import('./views/Usage.vue'), meta: { title: '用量' } },
    { path: '/audit', component: () => import('./views/Audit.vue'), meta: { title: '调用审计' } },
    { path: '/plugins', component: () => import('./views/Plugins.vue'), meta: { title: '插件' } },
    { path: '/actions', component: () => import('./views/Actions.vue'), meta: { title: '动作调试台' } },
    { path: '/memory', component: () => import('./views/Memory.vue'), meta: { title: '记忆' } },
    { path: '/logs', component: () => import('./views/Logs.vue'), meta: { title: '日志' } },
    { path: '/settings', component: () => import('./views/Settings.vue'), meta: { title: '设置' } },
  ],
});

// 控制台更新后旧页面加载不到新的分块：自动刷新一次
router.onError((err, to) => {
  if (/dynamically imported module|Importing a module script failed/i.test(String(err?.message)) && !sessionStorage.getItem('qab-reloaded')) {
    sessionStorage.setItem('qab-reloaded', '1');
    location.hash = to.fullPath;
    location.reload();
  }
});
router.afterEach(() => sessionStorage.removeItem('qab-reloaded'));

createApp(App).use(router).mount('#app');
