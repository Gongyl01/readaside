# Security policy

## Supported versions

安全修复优先应用于当前 `0.8.x` 版本。早期原型版本不承诺继续维护。

## Reporting a vulnerability

请优先使用 GitHub 仓库 Security 页面中的 **Private vulnerability reporting** 私下提交。公开仓库创建后，维护者应先开启该功能。

如果私密报告尚未启用，请只创建一个不包含复现细节、API Key、页面内容或个人信息的 Issue，用于请求安全联系方式。不要公开可利用步骤或真实凭证。

报告建议包含：

- 受影响版本和 Chrome 版本；
- 问题影响及最小复现步骤；
- 是否涉及页面数据、API Key、权限扩大或远程代码执行；
- 可行的缓解建议（如有）。

## Scope

优先关注 API Key 泄露、未授权页面读取、权限绕过、消息注入、危险链接、HTML/Markdown 注入以及依赖供应链风险。DeepSeek 服务本身的可用性或模型回答质量不属于本项目安全漏洞。

