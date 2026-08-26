# Contributing to ReadAside

感谢你愿意改进 ReadAside。当前项目坚持本地优先、BYOK、最小权限和小步交付。

## 开始前

1. 确认 Issue 中的问题和期望行为；较大的权限、持久化、服务商或输入契约变更先讨论设计。
2. 使用 Node.js 20 或更高版本运行 `npm ci`。
3. 修改前阅读 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) 和 [PRIVACY.md](./PRIVACY.md)。

## 本地验证

```bash
npm run build
npm run verify
```

涉及界面时，还应在 Chrome 侧栏宽度下人工检查浅色/深色模式、长文本、错误提示和中文输入法。

## Pull request 要求

- 一次 PR 聚焦一个问题，并说明 In / Out 和验证结果。
- 新行为应补测试；修复 Bug 时优先添加可以复现问题的测试。
- 不提交 API Key、真实私密网页、浏览器配置、`node_modules` 或本机绝对路径。
- 不新增远程脚本或 CDN；运行时依赖必须本地打包并补充许可证说明。
- 新权限必须解释用途和为什么不能使用更小范围的权限。
- 付费 API 请求不应静默自动重试。

提交贡献即表示你同意按项目的 [MIT License](./LICENSE) 发布该贡献。

