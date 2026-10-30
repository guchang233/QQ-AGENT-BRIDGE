# 系统插件参考

> 本文件由 `npm run docs:gen` 自动生成，请勿手改。

系统插件随程序发布，位于 `src/system-plugins/`，可在控制台「插件」页开关与配置；标注「默认关闭」的需手动开启。

## 基础管理（`admin`）

/help 帮助菜单、/状态、管理员在 QQ 里管理插件与只读模式

**命令**

- `/help`（别名：/帮助 /菜单） — 查看命令列表
- `/状态`（别名：/status） — 查看运行状态
- `/插件 [列表|开|关|重载] <名称>` — 管理插件
- `/只读 [开|关]` — 切换 Agent 只读模式


**配置**

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `helpHeader` | string | `"可用命令（前缀 / 或 #；群里 @我 时可省略）："` | 帮助菜单标题 |

## 记忆（`memory`）

长期记忆：遗忘曲线、强化、合并去重、全文/语义索引

**命令**

- `/记住 <内容>` — 让机器人记住一件事
- `/规则 [列表|全局 <内容>|删除 <ID>|<内容>]` — 管理员设定规则（AI 必须遵守）
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
| `membersCanRemember` | bool | `false` | 允许普通群友用 /记住 写入记忆（否则仅管理员） |
| `agentPerHour` | int | `20` | Agent 每个范围每小时最多写入几条记忆 |
| `memberMaxChars` | int | `200` | 非管理员要求记住的内容最长字数 |

## 仿真与人格（`social`）

由 Agent 驱动（DeepSeek Harness 等）自主聊天：唤醒/潜水/沉睡、等人说完、主动发言、按会话绑定人格卡

**命令**

- `/仿真 [开|关|唤醒|重置|状态]` — 仿真开关与状态
- `/人格 [列表|<人格名>|默认]`（别名：/角色） — 查看/切换本会话人格

**Agent 工具**：`qq_set_wake`、`qq_social_state`、`qq_get_persona`

**配置**

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `driver` | select（dsh） | `"dsh"` | Agent 驱动 |
| `convs` | list | `[]` | 启用仿真的会话（group:群号 / private:QQ），留空 = 不启用 |
| `defaultRole` | string | `""` | 默认人格卡名（roles/ 目录下的文件名，不含 .md；留空 = 默认群友） |
| `roleBindings` | list | `[]` | 按会话绑定人格：会话=>人格名，如 group:123=>小鲸鱼 |
| `roleMaxChars` | int | `8000` | 人格卡注入上限（字） |
| `botNames` | list | `[]` | 你的别名（被叫到算"叫名字"，昵称与群名片自动包含） |
| `defaultMode` | select（diving/active） | `"diving"` | 默认模式：diving 潜水（被叫才醒）/ active 活跃 |
| `atMention` | bool | `true` | @我 / 回复我 时唤醒 |
| `nameMention` | bool | `true` | 提到名字时唤醒 |
| `question` | bool | `true` | 有人问问题时唤醒 |
| `poke` | bool | `true` | 被戳时唤醒 |
| `keywords` | list | `[]` | 关键词（命中即唤醒） |
| `probability` | float | `0.05` | 潜水时普通消息的随机唤醒概率 |
| `batchWindowSec` | int | `8` | 群聊批量窗口（秒）：收到触发后等一会儿再唤醒，把连续消息合并 |
| `directWindowSec` | float | `2` | 私聊 / @我 / 戳我 时的等待秒数（对方在等你回复，越短越快） |
| `typingIndicator` | bool | `true` | 私聊中 AI 思考与分条发送期间显示「对方正在输入…」 |
| `maxWakePerMinute` | int | `2` | 每会话每分钟最多唤醒次数 |
| `maxWakePerHour` | int | `20` | 每会话每小时最多唤醒次数 |
| `noActionLimit` | int | `3` | 连续多少轮什么都没做就恢复默认配置 |
| `replyCheckSec` | int | `45` | 发言后多久回来看看有没有人接（秒，0 = 不检查） |
| `sleepMinMinutes` | int | `5` | 沉睡下限（分钟） |
| `sleepMaxMinutes` | int | `180` | 沉睡上限（分钟） |
| `proactive` | bool | `true` | 群里安静时偶尔主动开话题 |
| `proactiveIdleMinutes` | int | `15` | 安静多久算"冷场"（分钟） |
| `proactiveCheckMinutes` | int | `45` | 平均多久检查一次（分钟） |
| `proactiveProbability` | float | `0.3` | 检查时主动开口的概率（深夜/刚说过话会自动降低） |
| `wakeMessageLimit` | int | `15` | 唤醒时附带的新消息条数上限 |
| `wakeMaxChars` | int | `6000` | 唤醒消息快照字数上限 |
| `withMemory` | bool | `true` | 唤醒时附带相关记忆（需记忆插件） |
| `forwardText` | bool | `false` | 兜底：Agent 本轮没调用发送工具时，把它的文字回复发出去（一般不建议） |

## 请示管理员（`ask-admin`）

AI 拿不准时私聊请示管理员；管理员在 QQ 里回复「同意/拒绝」，结果自动写入记忆并通知 AI

**命令**

- `/请示` — 查看待处理的请示

**Agent 工具**：`qq_ask_admin`

**配置**

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `maxPendingPerUser` | int | `2` | 同一个人同时最多几条待处理请示 |
| `maxPerConvHour` | int | `5` | 每个会话每小时最多请示几次 |
| `expireHours` | int | `24` | 多少小时没答复就过期 |

## 冒泡（`bubble`） · 默认关闭

随机时间出来冒个泡、活跃一会儿，然后自动潜水

**命令**

- `/冒泡 [群号]` — 立刻在本会话（或指定群号）冒个泡
- `/潜水 [群号]` — 结束冒泡，回去潜水


**配置**

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `convs` | list | `[]` | 冒泡的会话（group:群号）；留空 = 所有启用了仿真的群 |
| `style` | select（auto/ai/template） | `"auto"` | auto：启用仿真的会话由 AI 说，否则用预设语句 / ai：只用 AI / template：只用预设语句 |
| `minIntervalMinutes` | int | `120` | 两次冒泡最短间隔（分钟） |
| `maxIntervalMinutes` | int | `600` | 两次冒泡最长间隔（分钟），实际在两者间完全随机 |
| `minStayMinutes` | int | `5` | 冒泡后最少活跃多久（分钟） |
| `maxStayMinutes` | int | `25` | 冒泡后最多活跃多久（分钟），到点自动潜水 |
| `quietHours` | string | `"0-8"` | 这些时段不冒泡（小时，如 0-8 或 23-7，多段用逗号） |
| `skipIfSpokeMinutes` | int | `30` | 最近这么多分钟内说过话就不冒泡（本来就在线） |
| `farewell` | float | `0.3` | 潜水时说一句再走的概率 |
| `templates` | list | `["冒个泡","潜水久了 出来透口气","有人吗","来了来了","大家都在忙啥","(探头)"]` | 预设冒泡语句（template 模式用） |
| `farewellTemplates` | list | `["潜了","先溜了","继续潜水去了"]` | 预设潜水语句 |

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

按规则自动同意/拒绝好友申请与加群请求，并私聊通知管理员



**配置**

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `friend` | select（manual/approve/reject/keyword） | `"manual"` | 好友申请：manual 人工 / approve 全部同意 / reject 全部拒绝 / keyword 附言含关键词则同意 |
| `friendKeywords` | list | `[]` | 好友申请同意关键词 |
| `groupJoin` | select（manual/approve/keyword） | `"manual"` | 他人申请加入我管理的群 |
| `groupJoinKeywords` | list | `[]` | 加群申请同意关键词 |
| `groupInvite` | select（manual/owner/approve/reject） | `"owner"` | 被邀请入群：owner 仅管理员邀请时同意 |
| `notifyOwner` | bool | `true` | 私聊通知管理员处理结果 |

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

## 联网搜索（`websearch`）

让 Agent 查梗、查热点、查事实：DeepSeek 联网搜索（与 DSH 同源）+ Bing 回退 + 安全网页抓取

**命令**

- `/搜索 <关键词>`（别名：/search） — 联网搜索

**Agent 工具**：`qq_web_search`、`qq_web_fetch`

**配置**

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `provider` | select（auto/deepseek/bing） | `"auto"` | auto：先 DeepSeek，失败回退 Bing |
| `apiKey` | secret | `""` | DeepSeek API Key（留空则读环境变量或 DSH 已保存的 Key） |
| `apiKeyEnv` | string | `"DEEPSEEK_API_KEY"` | 环境变量名 / DSH 凭据名 |
| `baseUrl` | string | `"https://api.deepseek.com/anthropic/v1"` | DeepSeek Anthropic 兼容端点 |
| `model` | string | `"deepseek-v4-flash"` | 搜索用模型 |
| `maxResults` | int | `8` | 每次最多返回结果数 |
| `perHour` | int | `30` | 每小时最多搜索/抓取次数（防止滥用与费用失控） |
| `fetchMaxChars` | int | `8000` | 网页抓取返回的最大字数 |

## 入群欢迎（`welcome`） · 默认关闭

新成员入群欢迎、成员退群提示（可按群配置）



**配置**

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `welcome` | text | `"欢迎 {at} 加入本群！[face:鼓掌] 有问题可以随时问～"` | 欢迎语（{at} {name} {qq} {group}，支持内联标记） |
| `farewell` | text | `""` | 退群提示（留空不发送） |
| `groups` | list | `[]` | 生效的群号（留空 = 所有允许的群） |
| `delaySec` | int | `3` | 延迟发送秒数（等新人加载完） |
