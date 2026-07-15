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

- **Display / wordmark:** Instrument Serif — brand moments only (「言落」, home poster headline).
- **Body / UI:** Satoshi (preferred) or DM Sans (fallback) — product chrome, lists, buttons.
- **Data / tables:** Same UI face with `font-variant-numeric: tabular-nums`.
- **Code / hotkeys / timestamps:** IBM Plex Mono.
- **Loading:** Google Fonts / Fontshare for Instrument Serif + IBM Plex Mono + DM Sans; self-host Satoshi if licensed. Do **not** use SF Pro / system-ui as the brand face (system fallback only).
- **Blacklist as primary:** Inter, Roboto, Space Grotesk, purple-gradient SaaS stacks.

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

- **Approach:** Restrained — one accent (copper), cool neutrals.
- **Primary accent (copper):** `#C4784A` — recording light / only primary CTA.
- **Accent soft:** `rgba(196, 120, 74, 0.16)`
- **Brand dark (default brand face):**
  - Background `#0E0F12`
  - Surface `#17191E` / `#1E2128`
  - Ink `#E8E6E3`
  - Muted `#8B8A86`
  - Line `rgba(232, 230, 227, 0.08)`
- **Light app mode:**
  - Paper `#F3F4F6` (cool — not cream `#F4F1EA`)
  - Ink `#12141A`
  - Same copper accent
- **Semantic:** keep clear success/warning/danger; retune away from pure Apple system blue as accent. Focus ring follows copper, not `#007AFF`.
- **Dark mode strategy:** Dark is the brand face; light is a first-class alternate, not an afterthought. Reduce decorative saturation; keep copper readable on both.

## Spacing

- **Base unit:** 4px
- **Density:** Comfortable tool density — tight lists OK; focus zone (transcript / job) needs air.
- **Scale:** 2xs 2 · xs 4 · sm 8 · md 16 · lg 24 · xl 32 · 2xl 48 · 3xl 64

## Layout

- **Approach:** Hybrid — poster composition on home; grid-disciplined inside 出稿 / 派活 / 设置.
- **Shell:** Narrow icon rail (3 destinations) — **not** a wide labeled sidebar of feature groups.
- **Max content width:** ~720–880px for reading/results; full width for job timelines when needed.
- **Radius:** sm 6 · md 10 · lg 14 · capsule 9999 (HUD only).
- **Jobs hierarchy:** One primary job per screen; config via header secondary; never config cemetery under scroll.

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

- [ ] Replace accent `#007AFF` → copper `#C4784A` in `theme.css` (light + dark)
- [ ] Load Instrument Serif + DM Sans/Satoshi + IBM Plex Mono; set `--font-display` / `--font-sans` / `--font-mono`
- [ ] Retire user-facing string `ASR Workshop` → `言落` / `Yanluo` (window title, tray, sidebar, overview, plist display name plan)
- [ ] Bundle id plan: leave `com.template…` for a dedicated packaging pass (don't half-rename signing)

### P1 — Kill workbench nav

- [ ] Collapse sidebar groups → narrow rail: 稿 · 派 · 设
- [ ] Home = poster two destinations (no install wall as the brand story; install is a gate state only)
- [ ] Merge 转写 / ASR / 历史 into **出稿** with mutual-exclusive modes
- [ ] Move 翻译 out of nav (⇧Fn + in-出稿 target)
- [ ] Move LLM + 词库 into 设置 sections
- [ ] Agent page rename/chrome → **派活**; keep job-list-first

### P2 — Surfaces

- [ ] Restyle HUD capsule to copper recording light + new type
- [ ] 出稿 results-first viewer inherits brand type/spacing
- [ ] 派活 conversational surface: bright enough to read, few borders (keep agent.css intent)
- [ ] Settings: one accent CTA; no equal-weight tab circus

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

## Artifacts

- Brand HTML preview: `~/.gstack/projects/asrrrr/designs/yanluo-20260715/brand-preview.html`
- Cursor canvas: `canvases/yanluo-brand.canvas.tsx` (workspace)
