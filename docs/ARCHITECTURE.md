# ReadAside architecture

> 本文描述 `0.11.0` 当前架构。后续迁移顺序见[可追溯上下文引擎实施路线图](./TRACEABLE_CONTEXT_ENGINE_ROADMAP.md)。

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
  └─ all structured blocks within 16,000 raw chars,
     otherwise a 16,000-character retrieval budget
                  ↓ chrome.runtime Port
Manifest V3 service worker
  ├─ reads API Key from chrome.storage.local
  ├─ builds DeepSeek request
  └─ streams answer / web citations / hidden evidence / structured errors
                  ↓
          api.deepseek.com
                  ↓ streamed answer + hidden evidence tool call
Side panel evidence resolver
  ├─ renders the clean answer and web sources
  ├─ validates block ID + verbatim unique quote against the sent snapshot
  └─ on user click routes to frame/root, scrolls and temporarily highlights a Range
```

页面提取函数以纯函数形式传给 `chrome.scripting.executeScript`，不会把 API Key 或扩展状态注入目标网页。网页文本被当作不可信数据放进模型上下文，模型输出先经过 Markdown 解析，再经 DOMPurify 白名单清洗和 KaTeX 渲染。

`0.10.1` 会在每次读取时生成 `readaside/page-document/v1`：顶层页面和可访问 iframe 中的标题、正文、列表、表格、代码和引用等内容被归一化为内容块，开放式 Shadow DOM 记录独立来源路径。`nav` 与 `navigation`、`menu`、`toolbar`、`tablist` 等 DOM/ARIA 导航结构中的列表项只从结构化块中排除，兼容文本仍原样保留；纯标点列表项继续作为最小内容兜底过滤。每个块只在当前 capture 内获得 `B0001` 形式的编号，不承诺跨刷新稳定。locator 同时保存结构路径、Shadow 路径和 `exact/prefix/suffix` 文本锚点，为后续原文定位保留多种信号。

原生、无合并单元格的 `<table>` 会在表格内容块中额外保存 rows/cells 与 `th/td` 语义。自动上下文选择该块时才将结构化数据序列化为 Markdown，侧栏预览则使用安全创建的原生表格元素。若表格块没有 rows/cells，但纯文本符合 GFM 管道表格结构，预览层会临时恢复行列以正确展示，不改写 `PageDocument`。其他 `rowspan`、`colspan`、嵌套表格或不规则行列仍使用块的纯文本；“结合全文”始终直接使用 `PageDocument.text`。

结构化内容块的 capture 内编号代表页面顺序。完整结构化预览和“本次采用”预览都按该编号显示；本地检索可以内部使用相关性顺序，但不应让用户看到正文、表格与引用穿插错位。

默认“自动选择”是请求模式。完整兼容文本不超过 16,000 字符且存在结构化块时，发送全部带内部块号的结构化内容，不按当前问题缩减；选区仍以独立字段发送并由提示词声明优先参考。更长页面才会在本地根据当前问题、当前选区和最近两条用户问题为内容块评分，固定命中选区的块，并最多选择两个词法种子。复合问题按分句分配种子；每个种子补充所属标题和一个同文档层、同标题路径的正文邻块。组装后的块级页面上下文最多 16,000 字符；缺少结构化块或无法安全选择时，`effectiveMode` 回退为完整文本。用户也可以主动切换“结合全文”，直接使用 `PageDocument.text`，作为不提供原文定位的兼容路径。

只有本次采用的块正文及其编号、类型、标题路径和来源标签会进入模型页面上下文。DOM 结构路径、Shadow 路径和文本定位锚点只存在侧栏内存中，不发送给模型。块级请求声明 `readaside/evidence-report/v1` 和允许证据块白名单，并提供 `report_page_evidence` 工具；模型的用户可见文本不得包含内部块号，完成回答后可通过工具参数提交最多三条 `blockId + exactQuote + supports`。DeepSeek Web Search 继续使用外部链接或数字脚注，不能进入页面高亮证据。

侧栏为每次块级请求保存未发送给模型的本地证据目标快照，包含完整块文本、frame、结构路径、Shadow 路径和文本锚点。工具返回后，校验器只接受本次白名单内、在对应块中逐字存在且只出现一次的原文；未知块号、模型改写和重复歧义均不生成定位按钮。通过校验时，回答下方只显示“查看原文依据”，不会展示内部编号或整段证据卡片。

用户点击按钮后，侧栏先确认当前活动标签页仍是采集页面，再按保存的 `frameId` 注入独立 resolver。resolver 依次解析开放式 Shadow DOM host 路径和结构路径，在候选元素中建立文本 `Range`；结构路径失效时，只在原文能够唯一确定且上下文评分不冲突时回退。命中后滚动到视口中部并使用 CSS Custom Highlight 临时标记核心短句，不支持时使用不接管鼠标事件的覆盖层；五秒后自动清除，再次定位会替换旧高亮。页面变化、frame 消失、封闭 Shadow DOM、原文缺失和重复歧义都返回结构化失败原因。证据定位始终是附加能力：模型没有调用工具、返回未通过校验或页面已变化时，经过清洗的原始 Markdown 回答仍正常显示。

## State boundaries

| Data | Location | Lifetime |
| --- | --- | --- |
| API Key | `chrome.storage.local` | Until explicit clear/uninstall |
| Page, structured blocks, context plan, local evidence targets and selection | Side panel JavaScript memory | Until clear, reread/change page, or panel close |
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
- 结构路径在页面刷新或重排后可能失效；只有原句能够安全恢复时才会回退定位。
- 重复原句缺少唯一上下文时不会显示定位按钮；系统优先避免高亮错误位置。
- “结合全文”使用无块号兼容文本，因此不会生成可校验的原文定位按钮。
