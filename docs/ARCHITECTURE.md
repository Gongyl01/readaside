# ReadAside architecture

> 本文描述 `0.11.1` 当前架构。后续迁移顺序见[可追溯上下文引擎实施路线图](./TRACEABLE_CONTEXT_ENGINE_ROADMAP.md)。

## Design goals

- **On demand**：只在用户点击读取时注入提取函数。
- **Local first**：不建设中间服务器，不持久化页面和对话。
- **BYOK**：请求直接使用用户为所选模型服务提供的 Key。
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
  ├─ arXiv paragraph lookup, lexical scoring and selection pinning
  ├─ heading / neighbor expansion
  └─ all structured blocks within 16,000 raw chars,
     otherwise a 16,000-character retrieval budget
                  ↓ chrome.runtime Port
Manifest V3 service worker
  ├─ reads API Key from chrome.storage.local
  ├─ builds provider request
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

默认“自动选择”是请求模式。arXiv HTML 论文通过页面地址与 LaTeXML 文档结构识别。提取时记录摘要、引言的正文段落序号，同一段拆出的多个块共享序号。没有选区时，问题里的“开头第三段”“摘要第 1 段”等位置指代会优先选取目标段落、所属标题和同节邻段。标题和作者保存在采集快照中。论文检索使用当前章节标题评分，并在普通检索候选中排除论文标题和作者块。

其余自动请求在兼容文本不超过 16,000 字符且存在结构化块时发送全部结构化内容。更长页面才会在本地根据当前问题、当前选区和最近两条用户问题为内容块评分。选区以独立字段发送并优先固定命中块。词法检索为各分句分配种子，并为种子补充所属标题和一个同文档层、同标题路径的正文邻块。检索组装预算为 16,000 字符。缺少结构化块或无法安全选择时，`effectiveMode` 回退为完整文本。用户也可以主动切换“结合全文”，直接使用 `PageDocument.text`，作为不提供原文定位的兼容路径。

只有本次采用的块正文及其编号、类型、标题路径和来源标签会进入模型页面上下文。DOM 结构路径、Shadow 路径和文本定位锚点只存在侧栏内存中，不发送给模型。Anthropic 兼容的块级请求声明 `readaside/evidence-report/v1` 和允许证据块白名单，并提供 `report_page_evidence` 工具；模型的用户可见文本不得包含内部块号，完成回答后可通过工具参数提交最多三条 `blockId + exactQuote + supports`。OpenAI 兼容请求提供基本对话，不发送隐藏证据工具。DeepSeek Web Search 继续使用外部链接或数字脚注，不能进入页面高亮证据。

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

The extension has fixed host access only to DeepSeek and `file:///*`. Other API origins and ordinary HTTP(S) page origins use optional permissions requested when the user saves a service address or reads a page. Chrome still controls protected pages, cross-origin frame access, local-file access and Web Store restrictions.

## Known technical limits

- Closed Shadow DOM cannot be traversed.
- Canvas text and images require OCR or multimodal processing and are only diagnosed.
- Virtual lists expose only currently rendered DOM nodes.
- CSS Grid、Canvas 和虚拟滚动模拟表格不会按表格解析；带 `rowspan` 或 `colspan` 的原生表格暂时回退为纯文本。
- Very long page/selection content is truncated to 80,000/20,000 characters.
- DeepSeek retains its Web Search integration. Anthropic-compatible services use Messages streaming and may provide evidence through tool calls. OpenAI-compatible services use Chat Completions streaming for basic chat.
- 结构路径在页面刷新或重排后可能失效；只有原句能够安全恢复时才会回退定位。
- 重复原句缺少唯一上下文时不会显示定位按钮；系统优先避免高亮错误位置。
- “结合全文”使用无块号兼容文本，因此不会生成可校验的原文定位按钮。
