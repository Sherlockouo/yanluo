# 转录详情弹窗 · 左右布局

> 替代原地展开（实测不可用：长稿把列表挤爆，视频撑出黑箱）。
> 设计目标：媒体与文稿并排，视线不用上下跳。

## 布局

```
┌──────────────────────────────────────────────────────────────────┐
│ 2026/7/16 22:36:07 · 127.0s · forced          [复制] [✕]          │  ← header (shrink-0)
├───────────────────────┬──────────────────────────────────────────┤
│                       │  全文模式 · 可滚动阅读        [专注|全文]    │  ← mode toggle (shrink-0)
│      ┌─────────┐      ├──────────────────────────────────────────┤
│      │         │      │                                          │
│      │  VIDEO  │      │   你看到大街上开法拉利的、开劳斯莱斯的，     │
│      │ 16:9    │      │   就是傻叔啊！你也别觉得他好像是狗屎运，     │
│      │         │      │   人家背后比你付出的一定比你多…            │
│      └─────────┘      │                                          │
│    （音频 = 占位卡）    │   他记得夜台汽笛…                          │
│                       │                                          │
│                       │   （滚动区，auto-follow 当前句高亮）          │
│ ┌───────────────────┐ │                                          │
│ │ ▶ ━━━━━━○──── 1:47│ │                                          │  ← controls (shrink-0)
│ └───────────────────┘ │                                          │
└───────────────────────┴──────────────────────────────────────────┘
     左栏 38%                   右栏 62%
```

## 规格

| 部位 | 规格 |
|------|------|
| 弹窗 | max-w-5xl（1024px 内），h = min(85vh, 44rem)，圆角 16px，bg surface，border hairline |
| Backdrop | `color-mix(background 55%, rgba(0,0,0,0.45))`，点击关闭 |
| Header | px-5 py-3，左 mono meta（时间 · 时长 · 语言 accent-soft-foreground），右 [复制 secondary] [✕ ghost] |
| 左栏 | w 38%，border-r hairline，bg `surface-secondary/60`（比右栏略深，分区不抢） |
| 视频 | 栏内居中，max-h 满栏，`bg-black` 圆角 12px，横版 w-full / 竖版 w-auto |
| 音频占位卡 | 居中：accent-soft 圆角 16px 图标块（64px, FileAudio 26px）+ 文件名 truncate + mono `127.0s · 音频` |
| 播放条 | 左栏底部，border-t hairline，p-3：▶ + scrub + 时间 |
| 右栏 | flex-1，min-w-0 |
| 专注/全文 toggle | 顶部 shrink-0，px-5 py-2.5，border-b hairline；现状文字 muted 11px + 右侧 pill |
| 文稿滚动区 | flex-1 min-h-0 overflow-y-auto，px-5 py-4；scroll-edge mask fade（上 12px 下 16px） |

## 动效（丝滑 = 用户原话）

| 元素 | enter | exit | 参数 |
|------|-------|------|------|
| Backdrop | opacity 0→1 | 1→0 | 180ms easeOut |
| Panel | opacity 0→1, scale 0.95→1, y 24→0 | opacity 1→0, scale 1→0.96, y 0→16 | **springUI**（bounce:0, 0.2s）镜像路径 |
| 内容列 | 随 panel，不单独 stagger | — | — |

- Esc 关闭；backdrop 点击关闭；body scroll lock。
- 媒体加载失败 → 整个媒体块隐藏，文稿保持可读（不再有黑箱）。

## 状态

| 状态 | 表现 |
|------|------|
| 加载中 | panel 先出，文稿区显示「加载阅读器…」muted 居中 |
| 无媒体文件 | 左栏显示 FileAudio + 「无媒体文件」muted，右栏正常 |
| 视频加载失败 | 左栏媒体隐藏（onError），播放条保留（若有 src） |
| 长文稿 | 右栏独立滚动，header/controls 固定 |

## 决策点

- 【 】左右比例 38:62（现）vs 42:58（媒体更大）？
- 【 】音频占位卡是否加波形装饰（纯 CSS bars，非实时）？
- 【 】专注模式默认开还是关？（长稿默认全文更稳）
