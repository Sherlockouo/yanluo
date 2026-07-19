# v3 主题 · 深色 + 浅色颜色概念

> 视觉预览：浏览器打开 [`theme.html`](./theme.html)。本文 = token 规格 + 决策理由。

## 设计原则

1. **深色是品牌脸**（不动）— 用户已认可暗色视觉。
2. **浅色去黄去浊** — 旧版 `#f0ede6` 黄调偏重，大面积显脏、白卡像浮在泥浆上。v4 目标：干净暖白，像「打印在好纸上的页面」，不是「米黄色旧纸」。
3. **三层可读分离** — 任何一层叠在下一层上都要能看清边界：
   `纸（页面底） → 白卡（panel/card） → 暖嵌（input/secondary well）`
4. **亮橙纪律不变** — `#D9722E` 仅 solid CTA / 录音灯 / active tab 下划线；小字铜色用 `#A0561F`。
5. **Depth = hairline + 极轻环境光**，不是投影堆叠。

---

## 深色（品牌脸 · 保持）

| Token | 值 | 用途 |
|-------|-----|------|
| `background` | `#0E0F12` | 页面底 |
| `surface` | `#17191E` | 卡 |
| `surface-secondary` | `#1E2128` | 嵌/输入 |
| `foreground` | `#E8E6E3` | 主文字 |
| `muted` | `#8B8A86` | 次文字 |
| `faint` | `#7A7978` | 元数据 |
| `border` | `rgba(232,230,227,0.08)` | hairline |
| `separator` | `rgba(232,230,227,0.07)` | 分隔 |
| `accent` | `#C4784A` | 铜 = 唯一强调 |
| `accent-soft` | `rgba(196,120,74,0.18)` | 铜软填充 |
| `accent-soft-foreground` | `#E0A075` | 铜字 |

> 深色不动。若 review 觉得 OK 请在下面打勾：【 】

---

## 浅色（v4 重做）

### 中性层

| Token | v4 值 | 旧值 | 变化理由 |
|-------|-------|------|----------|
| `background` | **`#F6F5F2`** | `#f0ede6` | 降黄降饱和。干净暖白 — 不是米黄。白卡在其上能「站住」 |
| `surface` | `#FFFFFF` | 同 | 纯白卡，与纸形成清晰第二层 |
| `surface-secondary` | **`#FAF9F6`** | `#f7f4ee` | 近白的嵌层，用于卡内次区域（比卡略暖，不抢） |
| `default`（嵌/井） | **`#EDEBE6`** | `#e9e4db` | 第三层：segment 底、chip 底、stat tile。与前两层拉开 |
| `foreground` | `#1C1A17` | 同 | 暖近黑，不动 |
| `muted` | **`#6B6660`** | `#5f5952` | 略提亮 — 次文字与主文字层级更清 |
| `faint` | **`#8E8983`** | `#6e6860` | 元数据再降一级（时间戳/序号），不抢正文 |
| `border` | **`rgba(30,28,25,0.15)`** | `0.22` | 旧版 hairline 过重显「框」；0.15 更细更贵气，配合环境光仍清晰 |
| `separator` | **`rgba(30,28,25,0.09)`** | `0.16` | 列表分隔再轻 — 编辑式索引靠行距读，不靠线 |

### 强调层（纪律不变）

| Token | 值 | 用途 |
|-------|-----|------|
| `accent` | `#D9722E` | **仅**：solid CTA / 录音灯 / active tab 2px 下划线 |
| `accent-hover` | `#BE611F` | CTA hover |
| `accent-soft` | `rgba(217,114,46,0.10)` | 暖橙软填充（active 卡、tag 底） |
| `accent-soft-foreground` | `#A0561F` | 小字铜文（≥4.5:1 on paper） |
| `link` | `#A0561F` | 链接 |

### 语义层

| Token | 值 |
|-------|-----|
| danger | `#C24238` / soft `rgba(194,66,56,0.10)` |
| success | `#2F7A4C` / soft `rgba(47,122,76,0.12)` |
| warning | `#A66C12` / soft `rgba(166,108,18,0.12)` |

### 卡片深度（light only）

```css
.light .panel {
  box-shadow:
    0 1px 0 rgba(255,255,255,0.8) inset,   /* 顶部内高光 — 光打在卡上沿 */
    0 1px 2px rgba(30,28,25,0.04),          /* 贴地线 */
    0 8px 24px rgba(30,28,25,0.05);         /* 大半径空气感，冷中性不泛黄 */
}
```

原则：**hairline 定义边缘，环境光只负责「离地」**，不产生方向性投影。

### Rail（左侧窄轨）

```css
.light .app-rail {
  background: color-mix(in oklab, var(--background) 96%, var(--foreground));
  /* 比纸深 4% — 读作独立一条，不用另一种颜色 */
}
```

---

## 字体（两主题共用）

| 角色 | 字体 | tracking | 用途 |
|------|------|----------|------|
| Display | Instrument Serif + Noto Serif SC | `-0.02em` | 页面大标题（出稿/设置/言落） |
| UI | Satoshi + Noto Sans SC | `0`（body）/ `-0.01em`（section） | 全部界面文字 |
| Data | IBM Plex Mono | `+0.01em` | 时间戳/热键/序号/session id |

> 浅色下衬线大字（如「出稿」56px）在 `#1C1A17` on `#F6F5F2` 对比 14:1+，锐利。

---

## 决策点（请批注）

1. 浅色 `background` 方向：**干净暖白 `#F6F5F2`**（本稿）vs 更冷 `#F5F5F4` vs 保留暖黄 `#F4F2EE`？ 
2. 卡片环境光：**保留极轻冷中性投影**（本稿）vs 纯 hairline 无投影（更扁）？
3. `muted/faint` 提亮后是否够灰、够层级？
4. Rail 是否需要更深（如 8%）或更浅（2%）？
