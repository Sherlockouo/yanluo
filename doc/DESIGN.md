# Design System — 言落 (Yanluo)

> Authority for brand, visual, and IA. Jobs/local-first rules still apply:
> [`design-jobs.md`](./design-jobs.md) · [`architecture-local-first.md`](./architecture-local-first.md) · [`Sell-it.md`](./Sell-it.md).
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
- **Light app mode (warm paper + bright orange — v3, replaces cool-slate/#B56A3F):**
  - Paper `#F4F2EE` (warm near-white — not cool slate `#E6E8ED`, not flat white)
  - Surface (cards) `#FFFFFF` / secondary `#F8F6F2`
  - Ink `#1C1A17` (warm near-black) · Muted `#6E6862`
  - **Accent = bright orange `#D9722E`** — CTA solid fill with white text; only primary action.
  - **Accent text `#A0561F`** — deeper copper for small copper text on paper (≥4.5:1). Never use bright `#D9722E` for small text on light.
  - Soft fill = warm orange wash `rgba(217,114,46,0.11)`, not peach pastel; hairline borders over drop shadows.
  - Rail mark: ink block on light (inverse of copper pill).
- **Why v3:** cold slate + deep copper read dirty/muddy; warmed + brightened paper with a purer orange keeps the accent alive, not brown. Design contract: `asr-cli/doc/design/v2/yanluo-ui.html` (settings/HUD) + `asr-cli/doc/design/v2/draft-a.html` (出稿 editorial).
- **Semantic:** keep clear success/warning/danger; retune away from pure Apple system blue as accent. Focus ring follows the accent, not `#007AFF`.
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
- **Radius:** sm 6 · md 10 · lg 14 · capsule 9999 (HUD only).
- **Jobs hierarchy:** One primary job per screen; config via header secondary; never config cemetery under scroll.

### 出稿 — editorial masthead (contract: `design/v2/draft-a.html`)

- **Masthead** = mono kicker (engine · 状态) → large serif `出稿` → **quiet mode switch** on the baseline (`文件 实时 翻译 历史`; active = ink + 2px copper underline) → mono subline (`Fn 出稿 · ⇧Fn 翻译 · 语言`). **Sticky** to top of `.app-content`, opaque paper bg (no blur/gradient), content scrolls under.
- **No fat tab strip / segmented pill** for modes. Secondary switches (本地文件/网络链接, 音频/视频) reuse the same understated slash-typography (`.tswitch`).
- **Records = manuscript index:** mono-meta rows on hairlines (`.rec` / `.rlist`), copper tag, delete on hover. Result view carries a slim header row (`转写记录 · N` ⋯ `＋新转写`), never a lonely full-width band. Empty states = editorial dashed dropzone (`.dropzone`).
- **Config lives in a quiet `模型▾` / `配置▾` link**, revealed inline (SoftCollapse) — never a detached status band duplicating the kicker.

### 设置 — macOS-style two-pane

- Left source list (`.setnav`, ~250px) + right detail (`.setbody`, fills width). Serif section heading atop the detail pane.
- **Secondary tabs** (配置/纠错学习/词库 · 快捷键/权限) = quiet underline text on a hairline (`.set-subtabs`), copper active — **not** a boxed segmented control.
- Per-tab, results/primary first, advanced collapsed: 识别 = 引擎/型号/对齐 + `模型目录与高级参数` fold; 润色 = 服务商 list rows (view/edit/set-current/reset) + `自定义` slot; 派活 = 3 fixed built-in agents (Claude/Codex/Pi), no free-form add.

## Motion

- **Approach:** Intentional minimal-functional (matches local-first rules).
- **Only:** `opacity` + `transform`. Never layout props.
- **Duration:** micro 80ms · short ≤220ms · no showy stagger.
- **Pages / modes:** enter-only; never `AnimatePresence mode="sync"` / `mode="wait"` on `<Outlet />`.
- **HUD:** subtle bar pulse while listening; confirm state clear, not theatrical.

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
- [ ] Update `doc/design-jobs.md` title references
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

- Brand HTML preview: `~/.gstack/projects/asrrrr/designs/yanluo-20260715/brand-preview.html`
- Cursor canvas: `canvases/yanluo-brand.canvas.tsx` (workspace)
