# ReadAside

ReadAside 是一个隐私边界清晰的 Chrome 侧栏阅读助手：按需读取当前网页或选中文字，再使用你自己的 DeepSeek API Key 解释、总结和连续追问。

> 当前状态：`active · beta`　当前版本：`0.8.0`　许可证：[MIT](./LICENSE)

<p align="center">
  <img
    src="./docs/screenshots/readaside-hero.png"
    alt="ReadAside：在当前网页旁边读取、核对和提问"
    width="960"
  />
</p>

## 为什么做它

阅读博客、文档或日志时，复制内容到另一个聊天窗口会打断思路，也很难确认 AI 实际看到了什么。ReadAside 把“读取—核对—提问—追问”放在当前标签页旁边，并把提取结果、截断情况和失败原因明确展示出来。

它适合希望本地自用、愿意自备 API Key，并且重视可检查数据流的 Chrome 用户。

## 已有能力

- 点击后才读取页面；普通网站权限在首次使用时由 Chrome 单独询问。
- 合并顶层页面、可访问 iframe 和开放式 Shadow DOM 的可见文字，不维护网站专用适配器。
- 支持 Chrome 打开的本地 HTML、TXT、JSON、Markdown 文件；不支持 PDF。
- 预览实际发送给模型的页面文本，并显示截断、文档层、Shadow DOM 和 Canvas 诊断。
- 读取网页选区，问答时优先参考选区并保留整页上下文。
- DeepSeek 流式问答、按需联网搜索、引用、GFM、表格、脚注、代码和 KaTeX 公式。
- 中文输入法组合输入期间，Enter 只确认候选词，不会误发送。
- 针对 Key、余额、限流、网络、服务端和空回答显示不同建议；失败请求可手动一键重发。
- 对话只保存在当前侧栏内存中，最多 20 轮；关闭侧栏或点击清除后释放。API Key 单独保存在 `chrome.storage.local`。

## 安装已构建版本

无需 Node.js：

1. 下载仓库源码或 Release 压缩包并解压。
2. 在 Chrome 打开 `chrome://extensions`。
3. 开启“开发者模式”，点击“加载已解压的扩展程序”。
4. 选择包含 `manifest.json` 的 ReadAside 目录。
5. 点击扩展图标打开侧栏，在设置中保存并测试个人 DeepSeek API Key。

如果直接使用源码仓库，`dist/` 已提交，可以直接加载，不必先构建。

## 基本使用

1. 打开普通网页，点击“读取当前页”，首次使用时允许网站访问。
2. 展开“读取内容预览与诊断”，确认需要的内容已经读取。
3. 输入问题并发送；`Shift + Enter` 换行。
4. 若只解释一段，先在网页中选中文字，再点击“读取选中文字”。

切换标签页后重新点击“读取当前页”。Chrome 内置页面、Chrome Web Store、关闭式 Shadow DOM、Canvas 文字和虚拟列表中尚未渲染的内容受浏览器或页面实现限制，无法完整读取。

### 本地文件

在扩展详情页开启“允许访问文件网址”，然后使用 Chrome 打开 `.html`、`.htm`、`.txt`、`.json`、`.md` 或 `.markdown` 文件。文件内容也会在提问时发送给 DeepSeek，不要读取不希望上传的敏感资料。

## 数据与隐私

- 项目没有自建服务器、账号系统、遥测或分析服务。
- API 请求由扩展后台直接发送到 `https://api.deepseek.com`。
- 只有提问时，当前页面标题、URL、已提取正文、选区、最近 12 条对话和问题才会发送给 DeepSeek。
- API Key 只保存在本机 Chrome 扩展存储中，但该存储不是系统钥匙串。
- 模型按需调用 DeepSeek Web Search 时，问题和相关上下文会由 DeepSeek 用于完成搜索。

完整说明见 [PRIVACY.md](./PRIVACY.md)。不要在 Issue、截图或日志中提交 API Key、网页私密内容或 Chrome 配置目录。

## 从源码开发

需要 Node.js 20 或更高版本：

```bash
npm ci
npm run build
npm run verify
```

生成可分发压缩包：

```bash
npm run package
```

产物位于 `release/readaside-0.8.0.zip`，不会包含 `node_modules`、测试文件、环境文件或本机配置。

## 结构

```text
background.mjs        # Key 管理、DeepSeek 请求、流式事件
sidepanel.*           # 侧栏界面和会话状态
lib/                  # 提取、预览、输入、请求和渲染逻辑
dist/                 # 本地打包的 Markdown 渲染器与 KaTeX 字体
test/                 # Node 单元测试和视觉验收页
scripts/              # 仓库检查和发布打包
docs/                 # 架构、截图与发布清单
```

更多设计说明见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)，后续功能计划见 [DEVELOPMENT_PLAN.md](./DEVELOPMENT_PLAN.md)。

## 当前不做

- 用户登录、云同步、自建代理服务器和多人共享。
- 多模型/多服务商切换、自动操作网页和后台常驻抓取。
- PDF、图片、视频、Canvas OCR、关闭式 Shadow DOM 和完整虚拟列表采集。
- 自动重试付费模型请求；失败后必须由用户点击确认。

## 参与项目

提交前请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md) 和 [SECURITY.md](./SECURITY.md)。运行 `npm run verify`，并确保没有提交 Key、隐私网页内容或仅适用于个人机器的路径。

第三方组件及其许可证见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
