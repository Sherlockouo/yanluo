# Local-first 架构 — 言落 (Yanluo)

> 源自 Linear 式 local-first（[skill](https://performance.dev/how-is-linear-so-fast-a-technical-breakdown)）。适配本仓库 **Tauri 桌面 + 本地 ASR/LLM**，非纯 Web SaaS。
>
> 做功能前必读；会话约束见 `.cursor/rules/local-first.mdc`。

## 一句话

**UI 读本地真相；网络/IPC 是后台同步。先渲染、再核对。动画只动合成层。**

## 本仓库的「本地真相」

| 数据 | 本地源 | UI 应如何读 |
|------|--------|-------------|
| 配置 | `config` 文件 + `app-context` | 同步读 React state；保存可乐观更新再 `invoke` |
| 历史 | `history.json` + context | 列表/详情不挡在 IPC 完成前；刷新后台 |
| 录音/部分结果 | 事件 + HUD | 事件驱动本地 state，不轮询 |
| 模型状态 | 本机路径 / 加载标志 | 状态位本地；下载进度事件叠加 |
| LLM API | 远程 | **只**影响纠错/翻译结果；浏览配置与历史不依赖它 |

IndexedDB 不是必须——桌面端文件 + 内存 store 已是 local-first。原则相同：**不要为读本地数据转圈**。

## 核心原则（映射到本项目）

1. **消除不必要的等待**  
   热路径：按键 → HUD → 粘贴。配置页打开不得先 `await` 一串无关 IPC。

2. **本地先写，后台同步**  
   `updateConfig` 立即改 UI；`saveConfig` / `invoke` 随后。失败再 toast + 回滚。

3. **先渲染，再校验**  
   有缓存的模型状态/历史就先画；后台 `get_model_status` / `loadHistory` 校正。

4. **动画只合成属性**  
   仅 `transform` / `opacity`。禁止动画 `height`/`width`/`margin`/`top`。  
   短时长：常交互 ≤180ms；偶发 ≤250ms。`AnimatePresence` **禁止**包 `<Outlet />`。  
   **模式/Tab 切换：enter-only**（同 `PageShell`）。禁止 `AnimatePresence mode="sync"` 让旧面板留在文档流里和新面板叠放（残影/闪动）。

5. **键盘优先**  
   Fn / ⇧Fn / Esc 是一等公民；UI 快捷入口服务热键，不取代热键。

6. **少代码、可拆分**  
   重页（转写 viewer、设置）避免拖垮首屏；路由级保持轻量挂载（重 IPC 丢 `rAF`/idle）。

## 功能设计检查清单

做任何功能前过一遍：

- [ ] 首屏是否依赖网络或可延后的 IPC？能延后则延后。
- [ ] 用户操作是否先更新本地 state？
- [ ] 是否引入了「为读本地数据」的 spinner？
- [ ] 动效是否只用 opacity/transform？是否包了 Outlet？
- [ ] 失败路径是否本地可回滚、可感知？

## 反模式

- 进页同步连环 `invoke` 阻塞首绘（转写页 ytdlp / drag 必须延后）。
- 等 LLM HTTP 返回才允许看历史/改 Prompt。
- `mode="wait"` + Outlet、opacity 从 0 起的整页闪白。
- 动画 `height: auto` 做展开（改 opacity/y）。

## 与流式 ASR 文档关系

流式/VAD/KV 权威仍是 [`design-streaming-asr-vad.md`](./design-streaming-asr-vad.md) + roadmap。  
本文管 **产品层体感与数据流**；两者同时遵守。
