# 参与贡献

感谢你愿意让 QQ-Agent Bridge 变得更好！无论是修 bug、补文档、写插件还是提建议，都非常欢迎。

## 开发环境

```bash
npm install
npm run build          # 构建控制台
npm run demo           # 用 Mock QQ 启动完整系统：http://127.0.0.1:3299（密码 demo1234）
npm run dev            # 连真实协议端，文件变化自动重启
npm run console:dev    # 控制台前端热更新（Vite，:5173，代理到 3210）
npm run check          # 类型检查 + 全部测试（提交前必跑）
npm run docs:gen       # 修改了工具或系统插件后重新生成参考文档
```

不需要真实 QQ 账号就能开发绝大部分功能：`test/mock-onebot.ts` 模拟协议端。

## 贡献什么

- **插件**：通用、实用的功能优先做成插件。通用性很强、几乎人人需要的可以提议成为系统插件（`src/system-plugins/`）。
- **MCP 工具**：新增核心工具前先想想能否用插件 `ctx.tool()` 实现。工具名以 `qq_` 开头、描述写清"做什么/何时用/返回什么"、参数都要 `.describe()`。
- **协议端适配**：不同 OneBot 实现的返回结构差异，在对应调用处做宽松解析。
- **AstrBot 兼容**：补齐 `astrbot_shim/` 中缺失的 API，并在 `astrbot_shim/examples` 与 `test/astrbot.test.ts` 中加用例。
- **控制台**：`console/src/views/`，Vue 3 + Naive UI。
- **文档与翻译**。

## 约定

- **代码风格**：TypeScript strict，2 空格，单引号；跟随周围代码的写法与注释密度。注释用中文，解释"为什么"而不是"做什么"。
- **提交信息**：`类型: 简述`，类型如 `feat` `fix` `docs` `refactor` `test` `chore`。
- **测试**：修 bug 先写能复现的测试；新功能附带测试（端到端用 Mock OneBot，纯逻辑写单元测试）。
- **兼容性**：`src/plugins/api.ts`、`src/sdk.ts`、MCP 工具名/参数、配置结构是公共契约。破坏性变更需要在 PR 中说明并更新 `CHANGELOG.md` 的迁移说明。
- **安全**：涉及权限、文件访问、发送的改动请在 PR 中说明对 [安全模型](docs/security.md) 的影响。
- **依赖**：尽量不引入原生模块（保持 Windows 开箱即用）；新增依赖请说明理由。

## 提交 PR

1. Fork 并新建分支
2. 修改 + 测试，`npm run check` 通过
3. 如改动了工具或系统插件：`npm run docs:gen`
4. 更新 `CHANGELOG.md` 的 Unreleased 段
5. 提交 PR，按模板填写

## 发布流程（维护者）

1. 汇总 `CHANGELOG.md` Unreleased → 新版本号（语义化版本）
2. 更新 `package.json` 版本
3. 打 tag `vX.Y.Z`，GitHub Actions 会跑检查

## 行为准则

参与本项目即表示同意遵守 [行为准则](CODE_OF_CONDUCT.md)。
