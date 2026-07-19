# 言落 · v3 设计稿

> 状态：**待 review**。HTML 直接在浏览器打开看效果，批注写到对应 `.md` 文件里（格式：`【批注】...`），批注完我继续实现。

## HTML 预览（全部支持右上角 ⇄ 深/浅切换）

| 文件 | 页面 | 看点 |
|------|------|------|
| [`theme.html`](./theme.html) | **主题概念** | 深色×浅色双栏对比，色板/字体/组件 |
| [`home.html`](./home.html) | 首页 | 海报双目的地（出稿 primary 铜软填 / 派活） |
| [`draft.html`](./draft.html) | 出稿 × 4 模式 | **文件 / 实时 / 翻译 / 历史** 全模式（点 tab 切换）；实时 = 大字当前句 + 已提交段；翻译 = 句对对照；历史 = inline 展开卡 |
| [`transcript-modal.html`](./transcript-modal.html) | **转录详情弹窗** | **左右布局**：左 38% 媒体 / 右 62% 滚动稿；底部切「视频版 / 音频占位卡版」 |
| [`agent.html`](./agent.html) | 派活 | 列表 + 会话详情（底部切换）；**v3.1 header**：back 独立行 + serif 标题 + badge + 右操作区 |
| [`settings.html`](./settings.html) | 设置 | **v3.1 重做**：detail 填宽 + hairline rows 去盒 + quiet mono ▾ + sticky savebar |
| [`hud.html`](./hud.html) | **HUD × 3 态** | ASR / 翻译 / Agent 胶囊；**Fn badge 仅 editing 态**；新增圆点弹开出现动画演示（第 4 节） |

## Markdown 规格（批注写这里）

| 文件 | 内容 |
|------|------|
| [`theme.md`](./theme.md) | 主题 token 规格 + 浅色 v4 决策理由 + 决策点 |
| [`home.md`](./home.md) | 首页规格 |
| [`draft.md`](./draft.md) | 出稿规格 |
| [`transcript-modal.md`](./transcript-modal.md) | 弹窗规格（左右布局 + 丝滑动效参数） |
| [`agent.md`](./agent.md) | 派活规格 |
| [`settings.md`](./settings.md) | 设置规格 |
| [`hud.md`](./hud.md) | HUD 规格 |

## 本版核心决策

1. **浅色 v4**：`#F6F5F2` 干净暖白去黄浊；三层分离（纸/白卡/暖嵌 `#EDEBE6`）；hairline 0.15/0.09；卡片极轻冷中性环境光。深色不动。
2. **转录详情弹窗**：左右布局（媒体 | 滚动文稿），springUI 镜像 enter/exit（scale 0.95→1, y 24→0, 0.2s）。
3. **HUD 三态统一语言**：5 铜 bars + 单行 ellipsis + mono badge；agent 态扩展为 w520 圆角 20px（pill 行 + 附件 chip + 工具钮）。
