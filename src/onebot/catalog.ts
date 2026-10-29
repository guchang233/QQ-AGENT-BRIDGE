import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Tier } from '../config.ts';

export interface ActionInfo {
  name: string;
  readOnly: boolean;
  summary: string;
  params: string[];
  tier: Tier;
  category: string;
}

const raw: Omit<ActionInfo, 'tier' | 'category'>[] = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'actions.json'), 'utf8'),
);

/** 涉及凭证、账号存续或不可逆后果的动作：默认需审批。 */
const DANGER = new Set([
  'get_cookies', 'get_credentials', 'get_clientkey', 'get_csrf_token', 'get_rkey', 'get_rkey_server', 'request_decrypt_key',
  'send_packet', 'bot_exit', 'set_restart', 'clean_cache', 'clean_stream_temp_file',
  'delete_friend', 'set_group_leave', 'set_group_kick', 'set_group_kick_members',
  'set_qq_avatar', 'set_qq_profile', 'set_qzone_ban', 'set_group_add_option', 'set_group_search',
  'set_group_robot_add_option', 'set_group_member_permissions', 'set_group_new_member_history_visibility',
  'set_group_member_invite_policy', 'click_inline_keyboard_button',
]);

/** 普通交互：发消息、表情、戳一戳、空间互动、上传下载、已读等。 */
const SEND_PATTERNS = [
  /^send_/, /^forward_/, /^upload_forward_msg$/, /^upload_foward_msg$/, /poke$/, /^delete_msg$/,
  /^set_msg_emoji_like$/, /^set_group_reaction$/, /^mark_/, /^_mark_all_as_read$/, /^set_input_status$/,
  /qzone/, /^add_custom_face$/, /^modify_custom_face$/, /^move_custom_face_to_front$/, /^delete_custom_face$/,
  /^download_/, /^upload_file_stream$/, /^upload_private_file$/, /^upload_group_file$/, /^get_ai_record$/,
  /^set_group_sign$/, /^upload_(image|video)_to_qun_album$/, /^do_group_album_comment$/, /album_media_like$/,
  /flash/, /fileset/, /^get_share_link$/, /^send_like$/, /^create_collection$/,
];

function classify(a: Omit<ActionInfo, 'tier' | 'category'>): Tier {
  if (DANGER.has(a.name)) return 'danger';
  if (a.name === 'set_qzone_msg_right' || a.name === 'set_qzone_profile') return 'manage';
  if (SEND_PATTERNS.some((r) => r.test(a.name))) return 'send';
  if (a.readOnly) return 'read';
  return 'manage';
}

function categorize(name: string): string {
  if (/qzone/.test(name)) return 'QQ空间';
  if (/album/.test(name)) return '群相册';
  if (/face|emoji|reaction/.test(name)) return '表情';
  if (/poke|send_like|profile_like/.test(name)) return '互动';
  if (/file|flash|stream|download|upload_private|fileset/.test(name)) return '文件';
  if (/forward|msg|record|image|ocr|ptt|ark|_read/.test(name)) return '消息';
  if (/group/.test(name)) return '群';
  if (/friend|stranger|user|contact|category/.test(name)) return '好友';
  if (/status|login|version|cookie|credential|csrf|rkey|clientkey|restart|exit|cache|packet|decrypt|online/.test(name)) return '系统';
  if (/avatar|profile|longnick|nick/.test(name)) return '资料';
  return '其他';
}

export const ACTIONS: ActionInfo[] = raw.map((a) => ({ ...a, tier: classify(a), category: categorize(a.name) }));
const BY_NAME = new Map(ACTIONS.map((a) => [a.name, a]));

export function getAction(name: string): ActionInfo | undefined {
  return BY_NAME.get(name);
}

/** 未知 action 一律按 danger 处理（目录外的动作可能是新增的敏感接口）。 */
export function actionTier(name: string): Tier {
  return BY_NAME.get(name)?.tier ?? 'danger';
}

export function searchActions(query = '', category?: string, limit = 50): ActionInfo[] {
  const q = query.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  return ACTIONS.filter((a) => (!category || a.category === category)
    && words.every((w) => a.name.toLowerCase().includes(w) || a.summary.toLowerCase().includes(w) || a.category.includes(w)))
    .slice(0, limit);
}

export const TIER_ORDER: Record<Tier, number> = { read: 0, send: 1, manage: 2, danger: 3 };
