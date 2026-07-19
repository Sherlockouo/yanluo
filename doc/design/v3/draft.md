# 出稿 · 编辑式 masthead + 四模式

> 核心隐喻：手稿索引（manuscript index）。结果优先，配置藏进 quiet 链接。

## 布局

```
┌────────────────────────────────────────────────────────┐
│ 本机识别 · 已就绪                        转写记录 · 11 ＋新转写 │  ← mono kicker + 右上 quiet 链接
│                                                        │
│ 出稿                                     文件  实时  翻译  历史 │  ← 大衬线 56px + baseline 模式切换
│ ──────────────────────────────────────────────────────────── │
│ Fn 出稿 · ⇧Fn 翻译 · 自动检测语言                            │  ← mono 副行
│                                                        │
│  01  2026/7/16 22:36:07  [视频]  127.0s                  │  ← .ritem 手稿行
│      你看到大街上开法拉利的、开劳斯莱斯的，就是傻叔啊！…        │
│  ────────────────────────────────────────────────────   │
│  02  2026/7/16 14:38:24  [音频]  291.2s                  │
│      他来听我的演唱会，在十七岁的初恋第一次约会…              │
└────────────────────────────────────────────────────────┘
         ↑ masthead sticky，内容在其下滚动
```

## Masthead 规格

| 部位 | 规格 |
|------|------|
| kicker | mono 11px, accent-soft-foreground，左；右上 quiet 链接（`转写记录 · N` `＋新转写`） |
| 大标题 | Instrument Serif 56px, -0.02em, foreground |
| 模式切换 | Satoshi 15.5px，baseline 对齐标题底；active = foreground 600 + 2px accent 下划线（scaleX 0→1, 160ms）；inactive = muted |
| 副行 | mono 11.5px, muted：`Fn 出稿 · ⇧Fn 翻译 · 语言` |
| sticky | top 0，bg = var(--background)（不透明，无 blur），底 1px border |

## 手稿行（.ritem）

| 属性 | 值 |
|------|-----|
| 结构 | 序号（mono faint 12px, w 22px）+ meta 行（mono 12px faint：时间 · `[视频/音频]` accent-soft-foreground tag · 时长）+ 正文预览（15.5px/1.7, 2 行截断） |
| padding | 24px 4px |
| 分隔 | 底 1px separator |
| hover | bg `foreground 3%`（无位移） |
| :active | `scale(0.99)` 100ms（**注意**：非 .is-open 时才按，展开态不压） |
| 删除 | 右侧 trash icon，仅 hover 出现 |

**点击行为变更**：点行 → 弹 [`transcript-modal`](./transcript-modal.md)（不再原地展开）。

## 各模式

### 文件（transcribe）
- 上手稿索引（历史结果）为主体；`＋新转写` 进上传流。
- 上传态 = editorial dashed dropzone（min-h 300px, 1.5px dashed border, 圆角 18px, surface-secondary）。dropzone 作为可点卡片有 `scale(0.985)` press。
- 次级切换（本地/链接，音频/视频）= `.tswitch` quiet slash-typography，active = foreground 600，inactive = faint。

### 实时（asr）
- 实时识别流。状态条 + 大字当前句 + 已提交段落。

### 翻译（translate）
- 目标语言/Provider/模型 = masthead 右上或副行 **quiet mono ▾**（去盒化：无 border、无 inset shadow、mono 12px muted→hover foreground）。

### 历史（history）
- 全部记录的手稿索引，行内展开（保留 history 的 inline 展开阅读器）。

## 动效

- 模式切换：下划线 scaleX 160ms；面板 enter（fadeSlide tween 180ms，enter-only）
- 行进入：Reveal capped stagger（前 4 行 ×40ms，opacity 0.92 + y 6）
- 行 hover/press：见上表

## 决策点

- 【 右上 】`＋新转写` 位置：masthead 右上（现）vs 手稿区顶部一行？
- 【保持现状】历史 tab 的 inline 展开是否也统一改弹窗？（现仅文件 tab 弹窗）
- 【yes】模式 + 每模式滚动：sessionStorage 记忆；裸 `/draft` 还原上次 mode；URL `?mode=` 优先；切 tab / 离页再进各自还原 `.app-content` scrollTop
- 【 动画 】draft 的 header 模块，在切换时会出现跳动，页面闪烁的问题，优化下 不要有闪烁要丝滑动画
