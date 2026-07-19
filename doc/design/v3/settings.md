# 设置 · macOS 双栏（v3.1 重做版）

> **v3.1 改动（响应批注）**：
> 1. 右栏 detail 填宽（grid 240px + 1fr，不再半格小气）
> 2. **去盒子化**：select → quiet mono `▾`；录音源/外观 → quiet 文字开关（underline active）；form rows = hairline 行（左标签右控件）
> 3. 保存条 **sticky 底部通栏**（blur backdrop + 亮橙 CTA 右置）
> 4. 排版更大气：sec-title 30px serif、行高 18px padding、分组小标题 mono uppercase

> 系统设置式：左 source list，右 detail。结果/主功能优先，高级折叠。

## 布局（v3.1）

```
设置
┌───────────┬──────────────────────────────────────────────┐
│ ▌常规      │  常规                                         │
│  识别      │  语言、录音源与外观。                            │
│  润色      │  ──────────────────────────────────────────  │
│  派活      │  识别语言         自动检测（系统语言优先）▾      │ ← hairline row
│  系统      │  录音源           只录外部 / 只录系统 / 都录      │ ← quiet 文字开关
│  更新      │  外观             跟随系统 / 深色 / 浅色          │
│           │  开机自启                            (toggle) │
│           │                                              │
│           │  润色 · 服务商                                 │
│           │  配置   纠错学习   词库                          │ ← 15px underline subtabs
│           │  OpenAI [当前]  gpt-4o-mini · api.openai.com 编辑 │ ← hairline provider row
│           │  DeepSeek       deepseek-chat · …      设为当前 │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│ 已修改 2 项 · 保存后生效              [放弃] [ 保存 ]        │ ← sticky savebar
└───────────┴──────────────────────────────────────────────┘
   左 240px            右 detail 填宽
```

## 规格

| 部位 | 规格 |
|------|------|
| 左栏 | w 240px，sticky top；item = icon + Satoshi 500 14.5px，圆角 10px |
| 左栏 active | bg surface + inset hairline + 左 2.5px rail mark（浅 = ink，深 = accent） |
| 右栏标题 | Instrument Serif 30px，-0.01em；下接 13px muted 描述行 |
| form 行 | grid 200px + 1fr，py 18px，hairline 分隔；标签 14.5px 500 + 12px faint 说明 |
| quiet 选择器 | mono 13px `▾`，hover 变 accent-fg，**无盒** |
| quiet 开关 | 文字 slash 切换，active = 600 + 2px accent 下划线，**无盒** |
| toggle | 40×24 圆角 999，on = accent fill |
| subtabs | 15px，gap 28px，active 下划线 2px accent（比旧版 13.5px 大气） |
| provider 行 | hairline 分隔（无卡盒），current = 左起 accent-soft 渐隐背景 + tag |
| savebar | sticky bottom，blur 12px + border-t，左 hint 右 [放弃 ghost] [保存 accent] |

## 各 tab 要点

| tab | 结构 |
|-----|------|
| 常规 | 语言 + 录音源 + 外观 + 自启（hairline rows） |
| 识别 | 引擎/型号/对齐 + `模型目录与高级参数` 折叠 |
| 润色 | 服务商 hairline rows + subtabs（配置/纠错学习/词库） |
| 派活 | 3 固定内置 agents（Claude/Codex/Pi），无自由添加 |
| 系统 | 热键 + 权限 |
| 更新 | 版本 + 检查更新 |

## 动效

- tab 切换：内容 cross-fade（`useFade` 140ms）
- 折叠区：SoftCollapse（opacity 0.92 + y 6→0, 140ms，enter-only）
- 行 hover：bg `foreground 2.5%`；press `scale(0.99)`
- savebar CTA：hover 深 8%，press `scale(0.97)` 100ms

## 决策点

- 【yes】保存按钮常驻底部 sticky → **已实现：savebar sticky 通栏**
- 【layout】整体太紧凑 → **已重做：v3.1 填宽 + 去盒 + hairline rows**
- 【 】左栏图标是否保留？（现保留小 icon；纯文字更编辑感）
