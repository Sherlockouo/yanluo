# Design System — 言落 (Yanluo)

> Authority for brand, visual, and IA. Companion rules:
> [`architecture-local-first.md`](./architecture-local-first.md) · [`Sell-it.md`](./Sell-it.md).
>
> **Jobs 原则**（原 design-jobs.md 已并入本文）: 一屏一个主任务；配置收敛到页头/设置，不垫底；减法优先；布局即说明。
>
> Repo root mirror: [`../../DESIGN.md`](../../DESIGN.md).

## Product Context

- **What this is:** Mac-first local voice product. Speak → get a manuscript (**出稿**) or dispatch an agent job (**派活**). Not a dictation IME, not a developer workbench.
- **Who it's for:** People who run meetings/interviews/long dictation and want a draft on the desk; people who summon Claude/Codex/Pi by voice; privacy-sensitive content that must stay on-device.
- **Space/industry:** Voice → text / local ASR (peers: Superwhisper, Typeless, MacWhisper) — differentiated by long-session draft + agent dispatch, not short-message typing.
- **Project type:** Desktop app (Tauri) + system HUD capsule.
- **Memorable thing:** 开口有结果 — words fall into a draft or a job.

## Brand

| Field | Value |
|-------|--------|
| **Name (ZH)** | 言落 |
| **Name (EN / bundle)** | Yanluo |
| **Tagline** | 开口有结果。 |
| **One-liner (sell)** | 你的声音留在本机。开口出稿，开口派活。 |
| **Former names (retire)** | ASR Workshop · asr-workshop (user-facing) · Workshop / 工作台 narrative |
| **Alts considered** | 台本 · Cue |

### Say / Never say

**Say:** 声音不出电脑 · 说完有稿 · 说完能派 · 中英夹着说也尽量不瞎改 · 一次买断/自己的工具

**Never:** ASR Workshop · 工作台 · 流式/切段/MLX/本地推理 as marketing · 赋能/全链路 · 比 Typeless 更便宜 · 业界领先识别率

## Aesthetic Direction

- **Direction:** Quiet instrument (field recorder / desk tool) — spare, precious, results-first.
- **Decoration level:** Intentional — hairline borders, soft frost on HUD only; no glass soup in main shell.
- **Mood:** Serious tool you paid for, not a chat toy and not a settings console.
- **Reference / anti-reference:** Superwhisper/Typeless = hotkey paste; we keep HUD literacy but refuse Apple-blue utility clone and refuse 8-item workbench nav.

## Typography

- **Display / wordmark:** Instrument Serif (Latin) + Noto Serif SC (CJK) — brand moments / page titles only (「言落」, 出稿, 设置). Weight 400, not bold block.
- **Body / UI:** Satoshi (Latin, Fontshare) + Noto Sans SC (CJK) — product chrome, lists, buttons. Prefer over system PingFang as primary.
- **Data / tables:** Same UI face with `font-variant-numeric: tabular-nums`.
- **Code / hotkeys / timestamps:** IBM Plex Mono.
- **Loading:** Fontshare Satoshi; Google Fonts for Instrument Serif + Noto Sans/Serif SC + IBM Plex Mono. Do **not** use SF Pro / system-ui as the brand face (system fallback only).
- **Blacklist as primary:** Inter, Roboto, Space Grotesk, DM Sans (retired), purple-gradient SaaS stacks.

### Scale

| Token | Size | Use |
|-------|------|-----|
| `--text-display` | 1.875–2.75rem | Home poster, brand |
| `--text-section` | 1.0625rem | Section titles |
| `--text-body` | 0.9375rem | Body |
| `--text-ui` | 0.875rem | Controls |
| `--text-meta` | 0.75rem | Secondary |
| `--text-micro` | 0.6875rem | Hotkey chips |

## Color

- **Approach:** Restrained — one accent, warm neutrals on light / cool neutrals on dark.
- **Dark accent (copper):** `#C4784A` — recording light / only primary CTA on the brand face.
- **Brand dark (default brand face):**
  - Background `#0E0F12`
  - Surface `#17191E` / `#1E2128`
  - Ink `#E8E6E3`
  - Muted `#8B8A86`
  - Line `rgba(232, 230, 227, 0.08)`
- **Light app mode (clean warm-white + bright orange — v4, replaces warm-beige #F4F2EE):**
  - Paper `#F6F5F2` (clean warm-white — not beige `#f0ede6`, not cool slate `#E6E8ED`, not flat white)
  - Surface (cards) `#FFFFFF` / secondary `#FAF9F6` / inset wells `#EDEBE6` — three readable layers
  - Ink `#1C1A17` (warm near-black) · Muted `#6B6660` · Faint `#8E8983`
  - Border `rgba(30,28,25,0.15)` / separator `rgba(30,28,25,0.09)` — thin hairlines, no heavy frames
  - **Accent = bright orange `#D9722E`** — CTA solid fill with white text; recording light; only primary action.
  - **Accent text `#A0561F`** — deeper copper for small copper text on paper (≥4.5:1). Never use bright `#D9722E` for small text on light.
  - Soft fill = warm orange wash `rgba(217,114,46,0.10)`, not peach pastel; hairline borders + whisper of cool-neutral ambient shadow on cards.
  - Rail mark: ink block on light (inverse of copper pill).
- **Why v4:** 米黄底色大面积显脏、白卡浮在泥浆上；去黄降饱和后纸/卡/嵌三层清晰。Design contract: `asr-cli/doc/design/v3/theme.html` (双主题概念) + `asr-cli/doc/design/v3/` (页面稿).
- **Semantic:** keep clear success/warning/danger (light danger `#C24238`, success `#2F7A4C`, warning `#A66C12`); retune away from Apple system blue. Focus ring follows the accent, not `#007AFF`.
- **Dark mode strategy:** Dark is the brand face (copper `#C4784A`) and stays unchanged; light is a first-class alternate, not an afterthought.
- **App background is flat** (`var(--background)` both themes). No radial/decorative gradient on `.app-content` — a solid sticky masthead over a gradient leaves a visible layer seam. Keep surfaces flat; depth = hairlines, not glows.
- **Accent discipline:** bright `#D9722E` = solid CTA fill + recording light + active-tab 2px underline only. Never as a large fill, small text, or a second persistent accent surface.

## Spacing

- **Base unit:** 4px
- **Density:** Comfortable tool density — tight lists OK; focus zone (transcript / job) needs air.
- **Scale:** 2xs 2 · xs 4 · sm 8 · md 16 · lg 24 · xl 32 · 2xl 48 · 3xl 64

## Layout

- **Approach:** Hybrid — poster composition on home; grid-disciplined inside 出稿 / 派活 / 设置.
- **Shell:** Narrow icon rail (3 destinations) — **not** a wide labeled sidebar of feature groups.
- **Scroll:** `.app-content` is the single scroll region. **No nested scroll containers** (no `max-h + overflow` on result/record lists) — lists flow, the page scrolls.
- **Max content width:** ~720–880px for reading/results; full width for job timelines when needed. 设置 fills width (two-pane), left-aligned — not a centered narrow column.
- **Radius:** sm 8 · md 12 · lg 16 · xl 20 · capsule 999 (HUD/pills) — rounded, friendly; tokens `--radius-sm/md/lg/xl/pill`.
- **Jobs hierarchy:** One primary job per screen; config via header secondary; never config cemetery under scroll.

### 出稿 — editorial masthead (contract: `design/v2/draft-a.html`)

- **Masthead** = mono kicker (engine · 状态) → large serif `出稿` → **quiet mode switch** on the baseline (`文件 实时 翻译 历史`; active = ink + 2px copper underline) → mono subline (`Fn 出稿 · ⇧Fn 翻译 · 语言`). **Sticky** to top of `.app-content`, opaque paper bg (no blur/gradient), content scrolls under.
- **No fat tab strip / segmented pill** for modes. Secondary switches (本地文件/网络链接, 音频/视频) reuse the same understated slash-typography (`.tswitch`).
- **Records = manuscript index:** mono-meta rows on hairlines (`.rec` / `.rlist`), copper tag, delete on hover. Result view carries a slim header row (`转写记录 · N` ⋯ `＋新转写`), never a lonely full-width band. Empty states = editorial dashed dropzone (`.dropzone`).
- **Config lives in a quiet `模型▾` / `配置▾` link**, revealed inline (SoftCollapse) — never a detached status band duplicating the kicker.

### 设置 — macOS-style two-pane

- Left source list (`.setnav`, 240px) + right detail (`.setbody`, fills width). Serif section heading atop the detail pane. Form rows = hairline（左标签右控件，无盒）; 保存条 sticky 底部通栏。
- **Secondary tabs** (配置/纠错学习/词库 · 快捷键/权限) = quiet underline text on a hairline (`.set-subtabs`), copper active — **not** a boxed segmented control.
- Per-tab, results/primary first, advanced collapsed: 识别 = 引擎/型号/对齐 + `模型目录与高级参数` fold; 润色 = 服务商 list rows (view/edit/set-current/reset) + `自定义` slot; 派活 = 3 fixed built-in agents (Claude/Codex/Pi), no free-form add.

## Interaction & Motion（含 Apple Design 原则）

> 合并自原 `DESIGN-RECORD.md`（已并入，原文件删除）。

### 硬规则

- **只动** `opacity` + `transform`。Never layout props（width/height/top/left）。
- **时长：** micro 80ms · short ≤220ms · 无炫技 stagger。
- **Pages / modes:** enter-only；never `AnimatePresence mode="sync"` / `mode="wait"` on `<Outlet />`。
- **Route/nav/PageShell 保持 tween**；UI 元素（卡片/面板/popover/弹窗）可用 spring：`springUI = { type: "spring", bounce: 0, duration: 0.2 }`（临界阻尼、可中断、无 overshoot）。视觉享受点（modal 出现/落位）可到 `bounce: 0.2–0.25, duration: 0.3–0.35`。
- **HUD:** subtle bar pulse while listening；confirm state clear, not theatrical。

### 响应 — 消灭延迟

- **pointer-down 反馈，非 release。** 所有可交互元素 `:active` 即时响应：
  按钮 `scale(0.97)` · 卡片 `scale(0.985)` · 列表行 `scale(0.99)` · chip `scale(0.96)`，`transition: transform 100ms ease-out`，全部包 `prefers-reduced-motion` guard。
- 拖拽/滑动全程 1:1 跟手，非手势结束才动画；`setPointerCapture` + 抓取偏移。

### 可中断性与 spring

- 动画可被随时抓取和反转；中断时从当前屏幕值开始新动画（framer-motion spring 默认如此）。
- 手势驱动不用 CSS transition/@keyframes；反转时混合速度，不硬切。
- Damping `1.0`（临界）为默认；仅手势携带动量（flick/drag release）时 `~0.8`。

### 空间一致性

- **进入和退出同路径**（右侧滑入 → 右侧滑出）。
- popover/sheet 从触发源起源（`transform-origin` 设为触发器）。
- 可逆过渡镜像 easing。

### 材质与深度

- 主 shell 背景 flat；**仅 HUD 胶囊**用 `backdrop-filter: blur(20px) saturate(180%)` + 半透明背景。
- 永不堆叠浅色半透明层；更大表面 = 更强 blur + 更深 shadow。
- 滚动区域用 scroll-edge mask fade（`transparent 0 / #000 12px / #000 calc(100% - 16px) / transparent 100%`），不用硬分隔线。

### 减少动态

- `prefers-reduced-motion: reduce`：slide/spring → 短 opacity cross-fade；去掉 overshoot。
- `prefers-reduced-transparency`：半透明面 → 更实。
- `prefers-contrast: more`：近实背景 + 清晰对比边框。

### 关键规格

- 页面进入：PageShell `opacity 0.92→1, y 12→0, scale 0.995→1`，180ms tween。
- 列表行：Reveal capped stagger（前 4 行 ×40ms，opacity 0.92 + y 6）。
- 弹窗（转录详情等）：backdrop fade 180ms + panel spring（scale 0.95→1, y 24→0, bounce ≤0.2），exit 镜像。
- HUD 出现：圆点 ease-in → 左右弹开成胶囊（scale 0.35→1, springBounce）→ 音频条从左流入（x -8→0, delay 0.12s）。

## Information Architecture

### Primary (sellable product)

| Mode | Job | Hotkey |
|------|-----|--------|
| **出稿** | Live draft + file/URL transcript + history | Fn · ⇧Fn translate |
| **派活** | Agent job list + summon | Fn+Space |
| **设置** | Engine, LLM refine, vocab, hotkeys, permissions, updates | — |

### Map from old routes

| Old | New |
|-----|-----|
| `/` overview feature grid | Home poster: 出稿 / 派活 |
| `/transcribe` `/asr` `/history` `/translate` | **出稿** internal modes (translate = ⇧Fn, not nav) |
| `/agent` `/agent/:id` | **派活** |
| `/llm` `/vocabulary` + deep ASR/LLM | **设置** |
| `/settings` | **设置** (absorb capability pages) |

### HUD

System-wide product face. Confirm-before-paste; edit → learn. No modals/previews inside capsule.

## Implementation checklist (UI renew)

Ship in order. Each step should still pass Jobs 3-second test.

### P0 — Brand tokens

- [x] Replace accent `#007AFF` → copper `#C4784A` in `theme.css` (light + dark)
- [x] Load Instrument Serif + DM Sans/Satoshi + IBM Plex Mono; set `--font-display` / `--font-sans` / `--font-mono`
- [x] Retire user-facing string `ASR Workshop` → `言落` / `Yanluo` (window title, tray, sidebar, overview, plist display name plan)
- [x] Bundle id plan: leave `com.template…` for a dedicated packaging pass (don't half-rename signing) — defaults domain now `com.sherlockouo.yanluo` with legacy read fallback; data dir `Yanluo` with `ASR Workshop` migrate

### P1 — Kill workbench nav

- [x] Collapse sidebar groups → narrow rail: 稿 · 派 · 设
- [ ] Home = poster two destinations (no install wall as the brand story; install is a gate state only)
- [x] Merge 转写 / ASR / 历史 into **出稿** with mutual-exclusive modes (editorial masthead + quiet mode switch)
- [x] Move 翻译 out of nav (⇧Fn + in-出稿 target)
- [x] Move LLM + 词库 into 设置 sections
- [x] Agent page rename/chrome → **派活**; keep job-list-first

### P2 — Surfaces

- [x] Restyle HUD capsule to copper recording light + new type
- [x] 出稿 results-first viewer inherits brand type/spacing (editorial masthead + manuscript index)
- [ ] 派活 conversational surface: bright enough to read, few borders (keep agent.css intent)
- [x] Settings: one accent CTA; no equal-weight tab circus (two-pane + quiet underline subtabs)

### P3 — Copy / sell alignment

- [ ] Overview / empty states use Sell-it language (有稿 / 派活 / 本地), not engine jargon
- [ ] Update `doc/Sell-it.md` product name to 言落
- [ ] README product blurb (keep stack facts for devs; marketing voice separate)

### Verify

- [ ] 3-second test on home / 出稿 / 派活 / 设置
- [ ] No dual equal columns; no config under scrollable results
- [ ] Motion: opacity/transform only; enter-only mode switch
- [ ] Light + dark both readable with copper accent

## Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-07-15 | Dual-primary (出稿 + 派活), anti-workbench shell | User chose B capability set + “能卖的产品，不要工作台” |
| 2026-07-15 | Brand name **言落** / Yanluo | Speak → something lands (draft or job); not Workshop |
| 2026-07-15 | Copper accent + Instrument Serif wordmark + dark brand face | Leave Apple-blue utility clone; memorable product face |
| 2026-07-15 | IA collapse 9 pages → 3 rail destinations | Sellable product vs developer console |
| 2026-07-15 | Approved design-consultation A | Write DESIGN.md + renew checklist |
| 2026-07-16 | 出稿 editorial masthead (sticky, quiet slash mode switch, manuscript index) — retire tab-strip+pane | User: "tab栏+内容栏割裂，毫无设计感"; picked draft-a |
| 2026-07-16 | 设置 = macOS two-pane, fill width, quiet underline subtabs | User: 设置页要左对齐随宽度 flex; boxed pill bars ugly |
| 2026-07-16 | Flat app background (drop `.app-content` radial gradient) | Sticky masthead over gradient left a visible "red line" seam |
| 2026-07-16 | 派活 = 3 fixed built-in agents; 润色 = provider CRUD; 识别 slimmed | User feedback on v2 doc: no free-form agents, need provider mgmt, too many scattered config |

## Artifacts

- 双主题颜色概念 + 页面设计稿（HTML 可预览）: `asr-cli/doc/design/v3/`（先看 `theme.html` 与 `README.md`）
- Cursor canvas: `canvases/yanluo-brand.canvas.tsx` (workspace)
