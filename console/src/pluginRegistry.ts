import { defineAsyncComponent, type Component } from 'vue';
import {
  AlarmOutline, BarChartOutline, BookOutline, ChatboxEllipsesOutline, ConstructOutline, ExtensionPuzzleOutline, GitCompareOutline, GlobeOutline, HandRightOutline,
  HappyOutline, HelpCircleOutline, MicOutline, PeopleOutline, PersonAddOutline, RepeatOutline, ShieldCheckmarkOutline, WaterOutline,
} from '@vicons/ionicons5';

/**
 * 插件在控制台里的展示信息。
 *
 * 插件不占侧栏，统一从「插件」列表进入详情页：
 *  - 配置页：所有插件都有，由 definePlugin 的 config 声明自动生成，不用写界面；
 *  - 自带页面：内置插件在 pages 里登记，显示为详情页的标签页。
 */
export interface PluginPage { key: string; label: string; component: Component }
export interface PluginMeta { icon: Component; category: string; pages?: PluginPage[] }

const page = (key: string, label: string, load: () => Promise<any>): PluginPage => ({ key, label, component: defineAsyncComponent(load) });

export const CATEGORIES: { key: string; label: string; color: string }[] = [
  { key: 'ai', label: 'AI 能力', color: '#12b7f5' },
  { key: 'chat', label: '聊天互动', color: '#18a058' },
  { key: 'group', label: '群管理', color: '#f0a020' },
  { key: 'tool', label: '效率工具', color: '#8a63d2' },
  { key: 'other', label: '其他', color: '#8a8f98' },
];

const PLUGINS: Record<string, PluginMeta> = {
  social: { icon: PeopleOutline, category: 'ai', pages: [page('convs', '会话与人格', () => import('./views/Social.vue'))] },
  memory: { icon: BookOutline, category: 'ai', pages: [
    page('graph', '关联网络', () => import('./components/MemoryGraph.vue')),
    page('items', '记忆列表', () => import('./views/Memory.vue')),
  ] },
  'ask-admin': { icon: HelpCircleOutline, category: 'ai' },
  bubble: { icon: WaterOutline, category: 'ai' },
  websearch: { icon: GlobeOutline, category: 'ai' },
  stickers: { icon: HappyOutline, category: 'chat', pages: [page('library', '表情包库', () => import('./views/Stickers.vue'))] },
  voice: { icon: MicOutline, category: 'chat' },
  'keyword-reply': { icon: ChatboxEllipsesOutline, category: 'chat' },
  repeater: { icon: RepeatOutline, category: 'chat' },
  welcome: { icon: HandRightOutline, category: 'chat' },
  admin: { icon: ConstructOutline, category: 'group' },
  guard: { icon: ShieldCheckmarkOutline, category: 'group' },
  requests: { icon: PersonAddOutline, category: 'group' },
  relay: { icon: GitCompareOutline, category: 'group' },
  scheduler: { icon: AlarmOutline, category: 'tool' },
  stats: { icon: BarChartOutline, category: 'tool' },
};

export const metaOf = (name: string): PluginMeta => PLUGINS[name] ?? { icon: ExtensionPuzzleOutline, category: 'other' };
export const colorOf = (name: string) => CATEGORIES.find((c) => c.key === metaOf(name).category)?.color ?? '#8a8f98';
