# HUD · 悬浮胶囊

> 系统级产品脸。确认前不粘贴（confirm-before-paste）；edit → learn。

## 布局（录音/处理态）

```
        ╭──────────────────────────────────────────────╮
        │ ▂▄█▅▃ : 了。OK，这就上国道了。国道。三三… [Fn] │
        ╰──────────────────────────────────────────────╯
         ↑5 根铜色 pulse bars      ↑单行 ellipsis   ↑mono badge
```

## 规格

| 部位 | 规格 |
|------|------|
| 胶囊 | min-w 420px，h 56px，圆角 999px，padding 10px 18px 10px 14px |
| 背景 | 深 `rgba(23,25,30,0.92)` / 浅 `rgba(244,242,238,0.88)`；**无**边缘 hairline（Retina 上像硬描边） |
| 材质 | `backdrop-filter: blur(20px) saturate(180%)`（仅 HUD，主 shell 不用） |
| 阴影 | 胶囊无 box-shadow；菜单可用软投影。**无 native NSWindow shadow**（矩形阴影会在圆角外形成方环） |
| 音频条 | 5 根 × 3px 宽，铜 accent，高 6/14/20/12/8px，`scaleY(0.55↔1)` pulse 1.1s，delay 0/0.1/0.2/0.15/0.05s |
| 文本 | 13px Satoshi，单行 nowrap ellipsis；已提交段 muted，当前段 foreground |
| Fn badge | mono 10px，border hairline，圆角 6px，padding 1px 5px |
| 位置 | **跟随鼠标所在屏幕**；默认水平居中、垂直约 **78%** 屏高（靠下、距底 ≥160px 避开 Dock）。**按显示器**记住拖拽位；换屏 → 该屏默认位 |

## 状态

| 状态 | 表现 |
|------|------|
| recording | 铜 bars pulse + 实时文本滚动 |
| processing | spinner 替换 bars + 「处理中」+ loading dots |
| refining | 文本 72% 透明度 + loading dots |
| refined | 文本瞬变 success 色 200ms，随后进 editing |
| editing | 文本变可编辑 textarea，Enter 确认粘贴 / Esc 取消 |
| switching | 「切换中」+ 胶囊呼吸 glow |

## 动效

- **出现动画（批注新增）**：圆点 ease-in（opacity 0→1, scale 0.6→1, ~300ms）→ 向左右弹开成胶囊（width 56→460px, cubic-bezier(0.22,1,0.36,1)）→ 左侧音频条流入（translateX -8→0 + opacity，滞后 ~100ms）→ 文本随后浮现。演示见 `hud.html` 第 4 节。
- 消失：opacity→0, scale→0.96, y→6，180ms。
- 文本切换：enter-only opacity 0.7→1，140ms
- 全部包 prefers-reduced-motion（动画关，静态呈现）

## 决策点

- 【No】Fn badge 不常驻 → **仅 editing 态出现**（recording/翻译/processing 都不带 badge）
- 【YES 保持差异】agent 模式胶囊（520px pill 行）与 ASR 胶囊保持视觉差异
- 【增加 胶囊出现动画】→ **已加入规格：圆点 ease-in → 左右弹开 → 音频条左侧流入**
