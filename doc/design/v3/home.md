# 首页 · 海报双目的地

> 3 秒测试：用户 3 秒内必须看懂「言落 = 说话 → 出稿或派活」。

## 布局

```
┌────────────────────────────────────────────────────┐
│ LOCAL · MAC                                        │  ← mono kicker (accent-soft-foreground)
│                                                    │
│ 今天开口                                           │  ← Instrument Serif 40-56px, -0.02em
│ 要什么结果？                                        │
│                                                    │
│ ┌──────────────────┐  ┌──────────────────┐         │
│ │ 出稿              │  │ 派活              │         │  ← dest cards, min-h 140px
│ │ 开会·口述·文件转写 │  │ 说完派给 Claude   │         │
│ │                  │  │ /Codex            │         │
│ │ Fn 开录          │  │ Fn+Space          │         │  ← 底部 mono 热键
│ └──────────────────┘  └──────────────────┘         │
│                                                    │
│ Fn 出稿 · ⇧Fn 翻译 · Fn+Space 派活                  │  ← mono legend
└────────────────────────────────────────────────────┘
```

## 组件规格

### dest-card（目的地卡）

| 属性 | 值 |
|------|-----|
| 尺寸 | min-height 140px, padding 22px 20px |
| 圆角 | 14px |
| 出稿（primary） | bg `accent-soft`，border `accent 32%`，label 铜色（暗 `#C4784A` / 浅 `#A0561F`） |
| 派活 | bg `surface-secondary`，border `border`，label `foreground` |
| hover | `translateY(-2px)` 160ms + border `accent 55%`（primary）/ `foreground 20%`（普通） |
| :active | `scale(0.985)` 100ms ease-out |

### 文字

- 卡 label：Satoshi 600, 20px, -0.02em
- 卡 hint：Satoshi 400, 13px, muted，2 行
- 卡热键：IBM Plex Mono 11px, muted（**修过的点**：HeroUI `Kbd` 默认 sans，已覆盖为 mono）

## 安装门槛（install gate）

- 模型未装时**不整屏替换**。海报照常渲染，出稿卡上方插一条 gate 卡（下载进度 + CTA），出稿卡呈现 gated 态（降低 opacity + 卡内给下载入口）。
- 派活卡不受影响（不依赖本机模型时）。

## 动效

- 页面进入：PageShell 统一（opacity 0.92 / y 12 / scale 0.995, 180ms tween）
- 卡 hover/press：见上表
- 无 stagger 炫技

## 决策点

- 【保持现状 】双卡等宽 1:1（现）vs 出稿略宽 7:5（更突出主目的地）？
