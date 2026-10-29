# 系统插件参考

> 本文件由 `npm run docs:gen` 自动生成，请勿手改。

系统插件随程序发布，位于 `src/system-plugins/`，可在控制台「插件」页开关与配置；标注「默认关闭」的需手动开启。

## 基础管理（`admin`）

/help 帮助菜单、/状态、主人在 QQ 里管理插件与只读模式

**命令**

- `/help`（别名：/帮助 /菜单） — 查看命令列表
- `/状态`（别名：/status） — 查看运行状态
- `/插件 [列表|开|关|重载] <名称>` — 管理插件
- `/只读 [开|关]` — 切换 Agent 只读模式


**配置**

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `helpHeader` | string | `"可用命令（前缀 / 或 #，私聊和 @我 时可省略）："` | 帮助菜单标题 |

## 刷屏防护（`guard`） · 默认关闭

检测刷屏与重复消息，自动警告、撤回或禁言



**配置**

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `windowSec` | int | `10` | 统计窗口（秒） |
| `maxMessages` | int | `8` | 窗口内最多消息数 |
| `maxRepeats` | int | `4` | 连续重复相同内容的上限 |
| `action` | select（warn/recall/ban） | `"warn"` | 触发后：warn 警告 / recall 撤回 / ban 禁言 |
| `banMinutes` | int | `10` | 禁言时长（分钟） |
| `groups` | list | `[]` | 生效的群（留空 = 所有允许的群） |
| `whitelist` | list | `[]` | 豁免的 QQ |

## 关键词回复（`keyword-reply`） · 默认关闭

消息包含关键词时自动回复



**配置**

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `rules` | list | `["早安=>早上好呀[face:太阳]","晚安=>晚安，好梦[face:月亮]"]` | 规则：关键词=>回复（回复支持内联标记；关键词以 re: 开头表示正则） |
| `exact` | bool | `false` | 整句完全匹配（否则包含即触发） |
| `cooldownSec` | int | `30` | 同一会话同一规则的冷却秒数 |
| `groupsOnly` | bool | `false` | 仅群聊生效 |

## 记忆（`memory`）

长期记忆：遗忘曲线、强化、合并去重、全文/语义索引

**命令**

- `/记住 <内容>` — 让机器人记住一件事
- `/回忆 [关键词]` — 检索记忆
- `/忘记 <ID>` — 归档一条记忆

**Agent 工具**：`qq_memory_remember`、`qq_memory_recall`、`qq_memory_context`、`qq_memory_update`、`qq_memory_index`

**配置**

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `forgetting` | bool | `true` | 启用遗忘曲线（关闭后所有记忆永久保持） |
| `baseStabilityDays` | float | `3` | 基础稳定度（天）：重要度 3 的记忆约 12 天后保持率降到 37% |
| `growth` | float | `1.5` | 强化系数：越接近遗忘时被回忆，稳定度增长越多 |
| `forgetThreshold` | float | `0.05` | 保持率低于此值视为遗忘（不再参与回忆，定期归档） |
| `sweepCron` | string | `"30 4 * * *"` | 整理（归档已遗忘记忆）的 cron 时间 |
| `dedupThreshold` | float | `0.75` | 相似度高于此值的新记忆合并到旧记忆 |
| `wRelevance` | float | `0.6` | 排序权重：相关度 |
| `wRetention` | float | `0.25` | 排序权重：保持率 |
| `wImportance` | float | `0.15` | 排序权重：重要度 |
| `embedEnabled` | bool | `false` | 启用向量语义检索（需 OpenAI 兼容 embeddings 接口） |
| `embedBaseUrl` | string | `"https://api.openai.com/v1"` |  |
| `embedApiKey` | secret | `""` |  |
| `embedModel` | string | `"text-embedding-3-small"` |  |
| `membersCanRemember` | bool | `false` | 允许普通群友用 /记住 写入记忆（否则仅主人） |

## 消息互通（`relay`） · 默认关闭

在群与群（或群与私聊）之间转发消息



**配置**

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `routes` | list | `[]` | 规则，每行一条：来源=>目标，双向用 <=>。例：group:111=>group:222　group:111<=>group:333 |
| `format` | string | `"[{from}] {name}："` | 前缀模板：{from} 来源会话名 {name} 发送者 |
| `includeMedia` | bool | `true` | 转发图片等媒体（否则仅文本） |

## 复读机（`repeater`） · 默认关闭

群里连续多人发同一句话时跟着复读一次



**配置**

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `threshold` | int | `3` | 连续多少人发送相同内容后复读 |
| `probability` | float | `1` | 达到阈值后复读的概率 0~1 |

## 请求自动处理（`requests`） · 默认关闭

按规则自动同意/拒绝好友申请与加群请求，并私聊通知主人



**配置**

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `friend` | select（manual/approve/reject/keyword） | `"manual"` | 好友申请：manual 人工 / approve 全部同意 / reject 全部拒绝 / keyword 附言含关键词则同意 |
| `friendKeywords` | list | `[]` | 好友申请同意关键词 |
| `groupJoin` | select（manual/approve/keyword） | `"manual"` | 他人申请加入我管理的群 |
| `groupJoinKeywords` | list | `[]` | 加群申请同意关键词 |
| `groupInvite` | select（manual/owner/approve/reject） | `"owner"` | 被邀请入群：owner 仅主人邀请时同意 |
| `notifyOwner` | bool | `true` | 私聊通知主人处理结果 |

## 定时与提醒（`scheduler`）

定时消息、提醒、周期任务（Agent 与群友都可使用）

**命令**

- `/提醒 <时间> <内容>`（别名：/remind） — 设置提醒
- `/提醒列表` — 查看本会话的提醒
- `/取消提醒 <ID>` — 取消提醒

**Agent 工具**：`qq_schedule`、`qq_schedule_list`、`qq_schedule_cancel`

**配置**

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `membersCanUse` | bool | `true` | 允许普通成员使用 /提醒 |
| `maxJobsPerUser` | int | `10` | 每人最多同时存在的提醒数 |

## 群聊统计（`stats`）

发言排行、活跃时段、日报（基于本地记录）

**命令**

- `/统计 [天数]`（别名：/日报） — 群聊统计

**Agent 工具**：`qq_group_stats`

**配置**

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `dailyReport` | bool | `false` | 每天定时在群里发日报 |
| `reportCron` | string | `"0 23 * * *"` | 日报时间（cron） |
| `reportGroups` | list | `[]` | 发日报的群号 |

## 表情包（`stickers`）

表情包收藏、认知笔记、同步 QQ 收藏表情、自动收藏与发送

**命令**

- `/表情包 [关键词]`（别名：/stickers） — 查看表情包库
- `/存表情 [备注]`（别名：/收藏表情） — 收藏图片为表情包（回复图片消息使用）
- `/发表情 <ID或关键词>` — 发送表情包
- `/同步表情` — 同步 QQ 收藏表情

**Agent 工具**：`qq_list_stickers`、`qq_collect_sticker`、`qq_sticker_note`、`qq_send_sticker`、`qq_sync_qq_favorites`

**配置**

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `syncQQFavorites` | bool | `true` | 连接后自动同步 QQ 账号的收藏表情到本地库 |
| `syncMax` | int | `200` | 同步时最多拉取的收藏表情数量 |
| `syncIntervalMin` | int | `360` | 定期同步间隔（分钟，0 = 只在启动时同步） |
| `autoCollect` | bool | `false` | 自动收藏群友发送的表情（图片表情 / 大表情） |
| `autoCollectPerHour` | int | `10` | 自动收藏每小时上限 |
| `addToQQFavorites` | bool | `false` | 收藏时同时加入 QQ 账号的收藏表情 |
| `previewMax` | int | `8` | qq_list_stickers 预览时最多附带的图片数 |

## 语音（`voice`）

文字转语音发送（Edge TTS / 自定义 TTS）与语音转文字

**命令**

- `/说 <文本>`（别名：/tts） — 把文字转成语音发出
- `/音色 [语言前缀，如 zh-CN]`（别名：/voices） — 列出 Edge TTS 音色
- `/转文字` — 把语音转成文字（回复语音使用）

**Agent 工具**：`qq_speak`、`qq_transcribe`、`qq_tts_voices`

**配置**

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `ttsProvider` | select（edge/openai/http/command） | `"edge"` | TTS 引擎 |
| `edgeVoice` | string | `"zh-CN-XiaoxiaoNeural"` | Edge 音色（如 zh-CN-XiaoyiNeural、zh-CN-YunxiNeural，用 /音色 查看） |
| `edgeRate` | string | `"+0%"` | Edge 语速（如 +10%、-20%） |
| `edgePitch` | string | `"+0Hz"` | Edge 音调（如 +5Hz） |
| `edgeVolume` | string | `"+0%"` | Edge 音量 |
| `openaiBaseUrl` | string | `"https://api.openai.com/v1"` | OpenAI 兼容 TTS 地址 |
| `openaiApiKey` | secret | `""` | OpenAI 兼容 TTS 的 API Key |
| `openaiModel` | string | `"gpt-4o-mini-tts"` | TTS 模型 |
| `openaiVoice` | string | `"alloy"` | TTS 音色 |
| `httpUrl` | string | `""` | 自定义 HTTP TTS：GET 地址模板，可用 {text} {voice}，返回音频 |
| `command` | string | `""` | 本地命令模板：可用 {out}（输出文件）{voice}；文本通过 stdin 传入。例：piper --model zh.onnx --output_file {out} |
| `maxChars` | int | `300` | 单条语音最多字数 |
| `sttProvider` | select（qq/openai/off） | `"qq"` | 语音转文字引擎 |
| `sttBaseUrl` | string | `"https://api.openai.com/v1"` | OpenAI 兼容转写地址 |
| `sttApiKey` | secret | `""` | 转写 API Key |
| `sttModel` | string | `"whisper-1"` | 转写模型 |
| `autoTranscribe` | bool | `true` | 收到语音自动转写并附在消息后 |

## 入群欢迎（`welcome`） · 默认关闭

新成员入群欢迎、成员退群提示（可按群配置）



**配置**

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `welcome` | text | `"欢迎 {at} 加入本群！[face:鼓掌] 有问题可以随时问～"` | 欢迎语（{at} {name} {qq} {group}，支持内联标记） |
| `farewell` | text | `""` | 退群提示（留空不发送） |
| `groups` | list | `[]` | 生效的群号（留空 = 所有允许的群） |
| `delaySec` | int | `3` | 延迟发送秒数（等新人加载完） |
