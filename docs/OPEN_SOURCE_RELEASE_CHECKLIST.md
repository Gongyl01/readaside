# Open-source release checklist

这份清单用于把当前本地目录发布为 GitHub 仓库。完成代码验收不代表已经替维护者执行远程创建或发布。

## Before creating the repository

- [x] 确认公开名称、描述和仓库标识：`ReadAside` / `readaside`。
- [x] 采用 MIT License，版权主体写为 `ReadAside contributors`。
- [x] 确认 README、截图和测试样例不包含私人页面、账号、公司名称或本机路径。
- [x] 运行 `npm ci`、`npm run package`，并检查生成的 zip 内容。
- [x] `npm audit --omit=dev` 未发现已知生产依赖漏洞。
- [ ] 在 Chrome 中加载发布目录，使用一个可撤销的测试 Key 做完整人工验收。

## GitHub repository settings

- [ ] 创建公开仓库 `readaside`，不要勾选自动生成 README/LICENSE，避免首次提交冲突。
- [ ] 默认分支使用 `main`，推送前检查首个提交范围。
- [ ] 开启 GitHub Actions，并要求 CI 通过后才能合并。
- [ ] 开启 Dependabot alerts、secret scanning 和 private vulnerability reporting。
- [ ] 在仓库 About 中设置简介、主题标签和截图。

## First release

- [ ] 给通过验收的提交打 `v0.8.0` 标签。
- [ ] 创建 GitHub Release，附上 `release/readaside-0.8.0.zip` 和 Changelog 摘要。
- [ ] 从 Release 重新下载压缩包，解压并在干净的 Chrome Profile 中加载一次。
- [ ] 发布后再次确认压缩包不含 `node_modules`、测试、Key、日志或环境文件。

## Not part of the first release

- Chrome Web Store 上架、用户登录、云同步、多模型适配和遥测均不属于首个 GitHub 开源版本。
