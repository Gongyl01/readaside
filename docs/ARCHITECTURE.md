# ReadAside architecture

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
       └─ current text selection
                  ↓
Side panel memory
  ├─ page + diagnostics
  ├─ selection
  └─ bounded conversation history
                  ↓ chrome.runtime Port
Manifest V3 service worker
  ├─ reads API Key from chrome.storage.local
  ├─ builds DeepSeek request
  └─ streams answer / citations / structured errors
                  ↓
          api.deepseek.com
```

页面提取函数以纯函数形式传给 `chrome.scripting.executeScript`，不会把 API Key 或扩展状态注入目标网页。网页文本被当作不可信数据放进模型上下文，模型输出先经过 Markdown 解析，再经 DOMPurify 白名单清洗和 KaTeX 渲染。

## State boundaries

| Data | Location | Lifetime |
| --- | --- | --- |
| API Key | `chrome.storage.local` | Until explicit clear/uninstall |
| Page and selection | Side panel JavaScript memory | Until clear, reread/change page, or panel close |
| Conversation | Side panel JavaScript memory, max 40 messages | Until clear/page change/panel close |
| Active request controller | Service worker memory | Until completion, cancellation, or port disconnect |

Only the last 12 conversation messages are sent in a request, even though the UI retains up to 40 for the current panel session.

## Permission model

The extension has fixed host access only to DeepSeek and `file:///*`. Ordinary HTTP(S) origins are optional permissions requested on the first page-read action. Chrome still controls protected pages, cross-origin frame access, local-file access and Web Store restrictions.

## Known technical limits

- Closed Shadow DOM cannot be traversed.
- Canvas text and images require OCR or multimodal processing and are only diagnosed.
- Virtual lists expose only currently rendered DOM nodes.
- Very long page/selection content is truncated to 80,000/20,000 characters.
- The current AI provider contract is DeepSeek-specific, including Web Search event parsing.

