# ReadAside architecture

> 本文描述 `0.10.0` 当前架构。后续迁移顺序见[可追溯上下文引擎实施路线图](./TRACEABLE_CONTEXT_ENGINE_ROADMAP.md)。

## Design goals

- **On demand**：只在用户点击读取时注入提取函数。
- **Local first**：不建设中间服务器，不持久化页面和对话。
- **BYOK**：请求直接使用用户自己的 DeepSeek Key。
- **Inspectability**：展示模型实际收到的页面文字和读取限制。
- **Safe retry**：流式请求失败不自动重复计费，由用户确认重试。

## Runtime flow

```text
Current tab
  └─ chrome.scripting.executeScript (after user click)
       ├─ page / accessible iframe / open Shadow DOM text
       ├─ typed ContentBlock[] + heading path + locator hints
       └─ current text selection
                  ↓
Side panel memory
  ├─ PageDocument (compatibility text + structured blocks)
  ├─ capture-local block IDs + diagnostics
  ├─ selection
  └─ bounded conversation history
                  ↓
Local context planner
  ├─ query + recent user questions
  ├─ lexical scoring + selection pinning
  ├─ heading / neighbor expansion
  └─ 16,000-character budget or full-text fallback
                  ↓ chrome.runtime Port
Manifest V3 service worker
  ├─ reads API Key from chrome.storage.local
  ├─ builds DeepSeek request
  └─ streams answer / citations / structured errors
                  ↓
          api.deepseek.com
                  ↓ streamed answer
Side panel evidence renderer
  ├─ parses [Bxxxx] outside code and links
  ├─ validates against the exact sent-block snapshot
  └─ renders safe markers + evidence cards + web sources
```

页面提取函数以纯函数形式传给 `chrome.scripting.executeScript`，不会把 API Key 或扩展状态注入目标网页。网页文本被当作不可信数据放进模型上下文，模型输出先经过 Markdown 解析，再经 DOMPurify 白名单清洗和 KaTeX 渲染。

`0.10.0` 会在每次读取时生成 `readaside/page-document/v1`：顶层页面和可访问 iframe 中的标题、正文、列表、表格、代码和引用等内容被归一化为内容块，开放式 Shadow DOM 记录独立来源路径。导航、分页器、工具栏和交互控件中的低信息标点列表项只从结构化块中排除，兼容文本仍原样保留。每个块只在当前 capture 内获得 `B0001` 形式的编号，不承诺跨刷新稳定。locator 同时保存结构路径、Shadow 路径和 `exact/prefix/suffix` 文本锚点，为后续原文定位保留多种信号。

原生、无合并单元格的 `<table>` 会在表格内容块中额外保存 rows/cells 与 `th/td` 语义。自动上下文选择该块时才将结构化数据序列化为 Markdown，侧栏预览则使用安全创建的原生表格元素。检测到 `rowspan`、`colspan`、嵌套表格或不规则行列时，不生成 rows/cells，继续使用块的纯文本；“结合全文”始终直接使用 `PageDocument.text`。

默认“自动选择”是请求模式，不等同于每次都使用块级上下文。ReadAside 会在本地根据当前问题、当前选区和最近两条用户问题为内容块评分，固定命中选区的块，并最多选择两个词法种子。复合问题按分句分配种子；每个种子补充所属标题和一个同文档层、同标题路径的正文邻块。组装后的块级页面上下文最多 16,000 字符；不超过 2,000 字符的短页面、缺少结构化块或无法安全选择时，实际模式 `effectiveMode` 会回退为完整文本。用户也可以主动切换“结合全文”，直接使用 `PageDocument.text`。

只有本次选中的块正文及其编号、类型、标题路径和来源标签会进入模型页面上下文。DOM 结构路径、Shadow 路径、文本定位锚点和完整检索候选仍只存在侧栏内存中。自动检索请求同时声明 `readaside/block-citation/v1` 和允许引用的块号白名单，要求模型对来自网页的关键事实使用 `[B0001]` 形式的引用；DeepSeek Web Search 继续使用外部链接或数字脚注。

侧栏为每次块级请求保存精简的已发送块证据快照。回答渲染时，引用解析器忽略围栏代码、行内代码和 Markdown 链接，校验器只接受本次快照中的编号。有效标记可以跳到同一回答下方的证据卡片；页面存在但本次未发送的编号和页面中不存在的编号会显示为不可点击警告，不会模糊匹配到其他段落。证据增强属于附加渲染层：证据卡片只代表“模型实际返回并通过校验的引用”，不是自动模式启用状态；没有引用或增强层失败时，经过清洗的原始 Markdown 回答仍正常显示。由于完整兼容文本没有块头，“自动保留全文”和“结合全文”都不启用块引用协议。

## State boundaries

| Data | Location | Lifetime |
| --- | --- | --- |
| API Key | `chrome.storage.local` | Until explicit clear/uninstall |
| Page, structured blocks, context plan, request evidence snapshot and selection | Side panel JavaScript memory | Until clear, reread/change page, or panel close |
| Conversation | Side panel JavaScript memory, max 40 messages | Until clear/page change/panel close |
| Active request controller | Service worker memory | Until completion, cancellation, or port disconnect |

Only the last 12 conversation messages are sent in a request, even though the UI retains up to 40 for the current panel session.

## Permission model

The extension has fixed host access only to DeepSeek and `file:///*`. Ordinary HTTP(S) origins are optional permissions requested on the first page-read action. Chrome still controls protected pages, cross-origin frame access, local-file access and Web Store restrictions.

## Known technical limits

- Closed Shadow DOM cannot be traversed.
- Canvas text and images require OCR or multimodal processing and are only diagnosed.
- Virtual lists expose only currently rendered DOM nodes.
- CSS Grid、Canvas 和虚拟滚动模拟表格不会按表格解析；带 `rowspan` 或 `colspan` 的原生表格暂时回退为纯文本。
- Very long page/selection content is truncated to 80,000/20,000 characters.
- The current AI provider contract is DeepSeek-specific, including Web Search event parsing.
- 当前有效块引用只跳到侧栏证据卡片；回到网页原文、滚动和临时高亮属于 M4，尚未实现。
- “结合全文”使用无块号兼容文本，因此不会生成可校验的网页证据卡片。
