# 言落 · 品牌与交互设计记录

> 基于 `doc/design/brand-preview.html` 品牌预览 + Apple Design 交互原则整理。
> 本文档 = 产品调性、颜色、字体、交互、动效的单一事实来源。

---

## 一、品牌调性

| 维度 | 定义 |
|------|------|
| **名称** | 言落（Yanluo） |
| **Tagline** | 开口有结果。 |
| **一句话** | 声音留在本机。说完有稿，说完能派。 |
| **不是什么** | 不是输入法，不是工作台，不是设置控制台 |
| **是什么** | 桌上那台会听你说话的工具 |
| **情绪** | 安静、精密、结果导向 — 像一台 field recorder，不是聊天玩具 |
| **参考系** | Superwhisper / Typeless = 热键粘贴；我们保留 HUD  literacy 但拒绝 Apple-blue 工具克隆 |

### 品牌风险决策（已确认）

| 决策 | 代价 | 收益 |
|------|------|------|
| 9 页 → 2 模式（出稿 / 派活） | 老用户重学路径 | 可卖的产品，不是开发者控制台 |
| 铜强调色 + 衬线字标 | 略不像原生 Mac 附赠 | 独立商品感， memorable |
| 暗色是品牌脸 | 跟 Apple 工具感拉开 | 营销与默认壳统一 |
| 中文名当主品牌 | 英文市场用拼音 | 不硬翻 ASR Workshop |

---

## 二、颜色系统

### 暗色（品牌脸，默认）

| Token | 值 | 用途 |
|-------|-----|------|
| `--bg` | `#0E0F12` | 主背景 |
| `--surface` | `#17191E` | 卡片/面板 |
| `--surface-2` | `#1E2128` | 次级卡片/输入框 |
| `--ink` | `#E8E6E3` | 主文字 |
| `--muted` | `#8B8A86` | 次要文字 |
| `--faint` | `#7A7978` | 时间戳/元数据（≥4.3:1） |
| `--line` | `rgba(232,230,227,0.08)` | 分隔线 |
| `--border` | `rgba(232,230,227,0.12)` | 边框 |
| `--copper` | `#C4784A` | **唯一强调色** — 录音灯、主 CTA、active tab 下划线 |
| `--copper-soft` | `rgba(196,120,74,0.16)` | 铜色软填充（active rail、primary card） |
| `--safe` | `#3D9B8F` | 成功/完成 |

### 浅色（暖纸，第一公民替代）

| Token | 值 | 用途 |
|-------|-----|------|
| `--bg` | `#F4F2EE` | 暖白纸 — 不是冷灰 `#E6E8ED`，不是纯白 |
| `--surface` | `#FFFFFF` | 卡片 |
| `--surface-2` | `#F8F6F2` | 次级卡片 |
| `--ink` | `#1C1A17` | 暖近黑 |
| `--muted` | `#5F5952` | 次要文字 |
| `--faint` | `#6E6860` | 时间戳/元数据 |
| `--line` | `rgba(28,26,23,0.13)` | 分隔线 |
| `--border` | `rgba(28,26,23,0.18)` | 边框 |
| `--accent` | `#D9722E` | **亮橙** — 仅主 CTA  solid fill + 录音灯 + active tab 2px 下划线 |
| `--accent-soft` | `rgba(217,114,46,0.11)` | 暖橙软填充 — 不是 peach pastel |
| `--accent-text` | `#A0561F` | 深铜 — 小字铜色文本 on paper（≥4.5:1） |

### 强调色纪律

- 亮橙 `#D9722E` = solid CTA fill + 录音灯 + active-tab 2px 下划线。**永不**大面积填充、小字、或第二持久强调面。
- 铜色 `#C4784A`（暗）/ `#A0561F`（浅小字）= 品牌强调、链接、active 状态。
- 成功/警告/危险保持清晰语义，远离纯 Apple system blue。

---

## 三、字体系统

| 角色 | 字体 | 用途 | 字重 | 特殊处理 |
|------|------|------|------|----------|
| **Display / 字标** | Instrument Serif (Latin) + Noto Serif SC (CJK) | 品牌时刻、页面标题（言落、出稿、设置） | 400 | `letter-spacing: -0.02em`，`line-height: 1.05` |
| **UI / 正文** | Satoshi (Latin) + Noto Sans SC (CJK) | 产品 chrome、列表、按钮 | 400/500/600 | `letter-spacing: 0`（body），`-0.01em`（section） |
| **Data / 表格** | 同 UI + `font-variant-numeric: tabular-nums` | 数字、统计 | 400 | — |
| **Code / 热键 / 时间戳** | IBM Plex Mono | 热键提示、session id、时间戳 | 400/500 | `letter-spacing: +0.01em`（小号 mono 可读性） |

### 字号阶梯

| Token | 大小 | 用途 |
|-------|------|------|
| `--text-display` | 1.875–2.75rem | 首页海报、品牌 |
| `--text-section` | 1.0625rem | 区块标题 |
| `--text-body` | 0.9375rem | 正文 |
| `--text-ui` | 0.875rem | 控件 |
| `--text-meta` | 0.75rem | 次要 |
| `--text-micro` | 0.6875rem | 热键 chip |

### 排版规则（Apple Design）

- **Tracking 随尺寸变化** — 大 display 用 `-0.02em`，正文近 `0`，小号 mono 用 `+0.01em`。**绝不**全局固定 letter-spacing。
- **Leading 随尺寸反比** — 大标题紧（`1.05`），正文松（`1.5`）。
- **字重建立层级** — 不是只靠字号。标题 600，正文 400，强调 500。
- **尊重用户字号设置** — 布局用 `rem`/`em`，不用固定 px。

---

## 四、交互设计原则（Apple Design）

### 4.1 响应 — 消灭延迟

| 规则 | 实现 |
|------|------|
| **pointer-down 反馈，非 release** | 所有可交互元素 `:active` / `data-[pressed=true]` 即时响应 |
| ** press scale** | 按钮 `scale(0.97)`，卡片 `scale(0.985)`，列表行 `scale(0.99)`，chip `scale(0.96)` |
| **transition 时长** | `100ms ease-out` — 快到来得及感知，快到不拖泥带水 |
| **连续反馈** | 拖拽/滑动/抽屉全程 1:1 跟手，非手势结束才动画 |

```css
.button:active {
  transform: scale(0.97);
  transition: transform 100ms ease-out;
}
```

### 4.2 直接操作 — 1:1 追踪

- 拖拽时元素 glued to finger，尊重抓取偏移量。
- 用 `setPointerCapture` 持续追踪，即使 pointer 移出元素边界。
- 记录最近几个 `pointermove` 的位置+时间戳，用于释放时计算速度。

### 4.3 可中断性 — 最重要的原则

| 规则 | 实现 |
|------|------|
| **动画可被随时抓取和反转** | 用户能在动画进行中抓住元素并反向操作 |
| **从当前屏幕值开始动画** | 中断时读取元素 live transform，从该值开始新动画 |
| **手势驱动不用 CSS transition/@keyframes** | 它们无法平滑中途抓取。用 spring，默认从当前值开始 |
| **反转时混合速度，不硬切** | 替换动画会造成速度不连续（"brick wall"）。Spring 库应携带速度重定向 |
| **2D 运动分解为独立 X/Y spring** | 单 spring 在 2D 距离上会在 X/Y 速度不同时失步 |

### 4.4 行为优于动画 — 用 Spring

> "把动画看作你和对象之间的对话，不是界面规定的剧本。"

| 参数 | 含义 | 默认值 |
|------|------|--------|
| **Damping ratio** | 控制 overshoot。`1.0` = 临界阻尼，无弹跳，平滑 settle。`< 1.0` = 过冲震荡 | 大部分 UI 用 `1.0` |
| **Response** | 多快到达目标，秒。越低越敏捷。**不是 duration** — spring 无固定时长 | `0.3–0.4` |

**Apple  shipped 值：**

| 交互 | Damping | Response |
|------|---------|----------|
| 移动/重定位（PiP） | `1.0` | `0.4` |
| 旋转 | `0.8` | `0.4` |
| 抽屉/面板 | `0.8` | `0.3` |

**Web 映射（Framer Motion）：** `bounce` + `duration` 近似 Apple `damping` + `response`。

```js
// 临界阻尼默认（无过冲）
animate(el, { y: 0 }, { type: 'spring', bounce: 0, duration: 0.4 });

// 动量交互 — 轻微弹跳，仅因为之前有 flick
animate(el, { y: target }, { type: 'spring', bounce: 0.2, duration: 0.4 });
```

**言落规则：**
- 大部分 UI spring 用 `bounce: 0`（临界阻尼）— 优雅不分散注意力。
- 仅当手势本身携带动量（flick、throw、drag release）时加 `bounce: 0.2`。
- **Route/nav 不用 spring** — 保持 tween，避免 main-thread jank。

### 4.5 速度交接 — 拖拽与动画的接缝

- 手势结束时，动画必须以手指的**精确速度**继续，无缝衔接。
- 某些 spring API 需要**相对速度**：`gestureVelocity / (targetValue - currentValue)`。
- Framer Motion / Motion 直接接受绝对 px/s（`velocity` 选项）。

### 4.6 动量投影 — 动画到手势要去的地方

> "小输入，大输出。"

不要从**释放点**吸附到最近边界。用速度**投影静止位置**，再吸附到投影点最近的 target。

```js
// decelerationRate ≈ 0.998 正常滚动感；0.99 更敏捷
function project(initialVelocity, decelerationRate = 0.998) {
  return (initialVelocity / 1000) * decelerationRate / (1 - decelerationRate);
}

const projectedEndpoint = currentPosition + project(releaseVelocity);
const target = nearestSnapPoint(projectedEndpoint);
animateSpringTo(target, { velocity: releaseVelocity });
```

### 4.7 空间一致性 — 对称路径，锚定起源

| 规则 | 实现 |
|------|------|
| **进入和退出同路径** | 从右侧滑入的面板必须从右侧滑出 |
| **锚定交互到触发源** | 菜单/popover/sheet 从触发它的元素起源 — `transform-origin` 设为触发器 |
| **可逆过渡镜像 easing** | 去程和回程用 inverse cubic-bézier |

### 4.8 手势方向暗示

中间帧应暗示最终状态 — 不是盲目插值。Control Center 模块"朝手指方向生长"。

### 4.9 橡皮筋 — 软边界

边界处渐进抵抗，非硬停。硬停读作"冻结"；连续抵抗读作"响应，但没有了"。

```js
function rubberband(overshoot, dimension, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}
```

### 4.10 手势设计细节

| 手势 | 规则 |
|------|------|
| **Tap** | touch-down 即时高亮，touch-up 提交。~10px hysteresis。允许拖走取消再拖回 |
| **Drag/swipe** | ~10px 移动阈值后才 commit 方向，然后 1:1 追踪 |
| **并行检测** | 从第一次移动并行检测所有可能手势，意图明确后取消 losers |
| **最小化歧义延迟** | double-tap 检测会延迟 single tap；仅在真正存在 double-tap 时付出此代价 |

### 4.11 帧级平滑

- 每帧位置变化低于感知阈值，避免 strobing。
- 快速运动时，轻微 **motion blur / stretch** 编码速度，比硬 sharp streak 读感更好。
- 只动画 compositor-friendly 属性 — `transform` 和 `opacity`。运动 imminent 时用 `will-change` 提示。

### 4.12 材质与深度 — 半透明传达层级

| 规则 | 实现 |
|------|------|
| **导航/工具栏/面板用半透明层** | `backdrop-filter: blur()` + 半透明背景，内容在下滚动 |
| **材质重量编码层级** | 深色/重材质分离结构区（sidebar）；浅色/亮材质吸引交互元素（按钮） |
| **永不堆叠浅色半透明层** | 可读性崩溃 |
| **更大表面读作更厚** | 更强 blur + 更深 shadow |
| **滚动边缘效果，非硬分隔线** | sticky header 下用 blur/gradient mask fade，非 1px border |
| **材质化，非仅 fade** | glass/blur 表面 enter/exit 时同时动画 blur radius 和 scale |

```css
.toolbar {
  background: rgba(255, 255, 255, 0.6);
  backdrop-filter: blur(20px) saturate(180%);
  border-top: 1px solid rgba(255, 255, 255, 0.4); /* 亮顶边 = 光打在材质上 */
}
```

**言落规则：** 主 shell 背景 flat。HUD 胶囊用 `backdrop-filter: blur(20px) saturate(180%)` + 半透明背景。

### 4.13 多模态反馈 — 动 + 声 + 触

1. **因果** — 明显什么导致了反馈。在实际因果事件触发（toggle 翻转、item snap home）。
2. **和谐** — 视觉、声音、触觉必须在**同一帧**触发。延迟破坏 illusion。
3. **效用** — 仅在值得的地方加反馈。保留给有意义时刻（成功、错误、提交、snap）。

### 4.14 减少动态与无障碍

| 信号 | 响应 |
|------|------|
| `prefers-reduced-motion: reduce` | 用短 opacity **cross-fade** 替代 slide/spring/parallax。去掉 elastic/overshoot。保留帮助理解的 opacity/color 变化 |
| `prefers-reduced-transparency: reduce` | 半透明表面更霜/实：提高背景 opacity，去掉 blur |
| `prefers-contrast: more` | 近实背景 + 定义清晰的对比边框 |

```css
@media (prefers-reduced-motion: reduce) {
  .sheet { transition: opacity 200ms ease; transform: none !important; }
}
@media (prefers-reduced-transparency: reduce) {
  .toolbar { background: white; backdrop-filter: none; }
}
```

---

## 五、动效规格（言落）

### 全局规则

| 规则 | 值 |
|------|-----|
| **只动** | `opacity` + `transform`。**永不** layout props |
| **时长** | micro 80ms · short ≤220ms · 无炫技 stagger |
| **页面/模式** | enter-only；**永不** `AnimatePresence mode="sync"` / `mode="wait"` on `<Outlet />` |
| **HUD** | 监听时 subtle bar pulse；confirm 状态清晰，不 theatrical |

### Spring 配置

```ts
// motion.ts
export const springUI = { type: "spring", bounce: 0, duration: 0.2 } as const;
// — 用于卡片、面板、popover 等 UI 元素。临界阻尼，可中断，无 overshoot。
// — **Route/nav 不用 spring**，保持 tween。
```

### 页面进入

```ts
// PageShell
initial={reduce ? false : { opacity: 0.92, y: 12, scale: 0.995 }}
animate={{ opacity: 1, y: 0, scale: 1 }}
transition={{ duration: duration.normal, ease: easeOut }}
```

### 列表行进入（capped stagger）

```ts
// Reveal — 前 4 项，每项延迟 ≤40ms，之后同最后项
const delay = reduce ? 0 : Math.min(Math.max(index, 0), 3) * 0.04;
initial={{ opacity: 0.92, y: 6 }}
animate={{ opacity: 1, y: 0 }}
```

### Popover / 面板（镜像 enter/exit）

```ts
// 从触发源进入，从同一路径退出
initial={{ opacity: 0, x: 20 }}
animate={{ opacity: 1, x: 0 }}
exit={{ opacity: 0, x: 20 }}
transition={springUI}
```

### HUD 胶囊

```css
.hud-capsule {
  background: rgba(23, 25, 30, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 999px;
  backdrop-filter: blur(20px) saturate(180%);
}

.hud-brand-bar {
  width: 3px;
  border-radius: 999px;
  background: var(--accent);
  opacity: 0.5;
  transform-origin: bottom;
  animation: hud-bar-pulse 1.1s ease-in-out infinite;
}
/* 5 bars, heights: 6px, 14px, 20px, 12px, 8px */
/* animation-delay: 0s, 0.1s, 0.2s, 0.15s, 0.05s */
```

### 按压反馈

```css
/* 按钮 */
.button:active,
.button[data-pressed="true"] {
  transform: scale(0.97);
  transition: transform 100ms ease-out;
}

/* 卡片 */
.panel:active,
.surface-card:active {
  transform: scale(0.985);
  transition: transform 100ms ease-out;
}

/* 列表行 */
.rec:active,
.ritem:not(.is-open):active,
.agent-job-row:active {
  transform: scale(0.99);
  transition: transform 100ms ease-out;
}

/* Chip */
.agent-reply-chip:active,
.hud-agent-chip:active {
  transform: scale(0.96);
  transition: transform 100ms ease-out;
}
```

### 滚动边缘 fade

```css
.agent-chat-timeline,
.setnav,
.transcript-scroll {
  mask-image: linear-gradient(
    to bottom,
    transparent 0,
    #000 12px,
    #000 calc(100% - 16px),
    transparent 100%
  );
}
```

---

## 六、信息架构

### 主层级（可卖的产品）

| 模式 | Job | 热键 |
|------|-----|------|
| **出稿** | 现场 draft + 文件/URL 转写 + 历史 | Fn · ⇧Fn 翻译 |
| **派活** | Agent 任务列表 + 召唤 | Fn+Space |
| **设置** | 引擎、LLM 润色、词库、热键、权限、更新 | — |

### 旧路由映射

| 旧 | 新 |
|----|----|
| `/` overview feature grid | 首页海报：出稿 / 派活 |
| `/transcribe` `/asr` `/history` `/translate` | **出稿** 内部模式（翻译 = ⇧Fn，非 nav） |
| `/agent` `/agent/:id` | **派活** |
| `/llm` `/vocabulary` + deep ASR/LLM | **设置** |
| `/settings` | **设置**（吸收能力页） |

### HUD

系统级产品脸。Confirm-before-paste；edit → learn。胶囊内无 modals/previews。

---

## 七、出稿 — 编辑式 masthead

- **Masthead** = mono kicker（引擎 · 状态）→ 大衬线 `出稿` → **安静模式切换** on baseline（`文件 实时 翻译 历史`；active = ink + 2px 铜下划线）→ mono 副标题（`Fn 出稿 · ⇧Fn 翻译 · 语言`）。**Sticky** 到 `.app-content` 顶部，不透明纸背景（无 blur/gradient），内容在下滚动。
- **无胖 tab strip / segmented pill**。次级切换（本地文件/网络链接，音频/视频）复用同样 understated slash-typography（`.tswitch`）。
- **记录 = 手稿索引**：mono-meta 行 on hairlines（`.rec` / `.rlist`），铜 tag，hover 删除。结果视图带 slim header row（`转写记录 · N` ⋯ `＋新转写`），永不孤立全宽 band。空状态 = 编辑式 dashed dropzone（`.dropzone`）。
- **配置藏在安静 `模型▾` / `配置▾` 链接**，inline 展开（SoftCollapse）— 永不 detached status band 重复 kicker。

---

## 八、设置 — macOS 双栏

- 左 source list（`.setnav`，~250px）+ 右 detail（`.setbody`，填宽）。Serif 区块标题 atop detail pane。
- **次级 tabs**（配置/纠错学习/词库 · 快捷键/权限）= quiet underline text on hairline（`.set-subtabs`），铜 active — **非** boxed segmented control。
- 每 tab，结果/主功能优先，高级折叠：识别 = 引擎/型号/对齐 + `模型目录与高级参数` fold；润色 = 服务商 list rows + `自定义` slot；派活 = 3 fixed built-in agents（Claude/Codex/Pi），无自由添加。

---

## 九、派活 — 会话式表面

- 亮到可读，少边框（保留 agent.css intent）。
- 任务列表优先，非配置优先。
- Agent detail：chat-like timeline（user bubble right，assistant left，tool centered gray），composer 清晰分离，status pill badge，attachment preview slide-in。

---

## 十、验证清单

- [ ] 首页 / 出稿 / 派活 / 设置 3 秒测试
- [ ] 无 dual equal columns；无 config 在 scrollable results 下
- [ ] Motion: opacity/transform only；enter-only mode switch
- [ ] Light + dark 都可读，铜 accent
- [ ] 所有可交互元素 pointer-down 即时反馈
- [ ] Popover/panel enter/exit 同路径
- [ ] Spring 仅用于 UI 元素，route/nav 保持 tween
- [ ] `prefers-reduced-motion` 下 cross-fade 替代 slide/spring
