# 派活 · 任务列表 + 会话详情

> 亮到可读，少边框。任务优先，配置收敛。

## 列表页

```
┌────────────────────────────────────────────┐
│ 派活                              [+ 新任务] │
│                                            │
│ ● claude · 运行中 · 14:32                  │  ← agent-job-row
│   帮我把今天的访谈整理成可发布的一版…         │
│ ────────────────────────────────────────── │
│ ✓ codex · 完成 · 2h 05m                    │
│   重构 settings 页双栏布局…                 │
└────────────────────────────────────────────┘
```

| 元素 | 规格 |
|------|------|
| 行 | hairline 分隔，kicker mono meta（状态点 + agent · 状态 · 时间），prompt 15px/1.45 |
| 状态色 | 运行中 accent-soft-foreground + pulse 点 / 完成 success / 失败 danger / 其他 muted |
| hover | bg `foreground 4%`；:active `scale(0.99)` |
| 空态 | editorial dropzone + 「Fn+Space 语音派活」 |

## 详情页（会话 · v3.1 header 重排）

```
← 派活
claude [运行中]                                        [■ 取消] [文件 ▸]
14:32 · 3m · ~/repos/asrrrr/asr-cli · a1b2c3d4
────────────────────────────────────────────────────────────
┌──────────────────────────────────────────────┬───────────┐
│ 🤖 对话 · 12                                  │  文件      │
│ ──────────────────────────────────────────  │  📄 a.md   │
│                              ┌─────────────┐ │  📄 b.png  │
│  用户气泡（右，surface-2）     │ 整理成发布稿 │ │  📁 src/   │
│                              └─────────────┘ │           │
│  ┌─────────────────────────┐                 │  [预览卡]  │
│  │ assistant（左，无泡纯文）  │                 │           │
│  └─────────────────────────┘                 │           │
│  ┌──────────────────────────────┐            │           │
│  │ 🔧 Bash  git status     14:33 ▾│           │           │
│  │ mono brief: M src/app.tsx …   │ ← 折叠时显示 brief     │
│  └──────────────────────────────┘            │           │
│ ┌──────────────────────────────────────────┐ │           │
│ │ 继续对话…                            [+][模型▾][➤] │ ← composer │
│ └──────────────────────────────────────────┘ │           │
└──────────────────────────────────────────────┴───────────┘
```

**Header 规则（v3.1）**：quiet back link 独立一行 → serif 标题 + `badge-soft` 状态 pill 同行 → mono meta 行（时间 · 时长 · cwd · session id）→ 右侧操作区（取消 / 文件栏开关）。不再把返回按钮和标题挤在一行。

### 关键规格

| 元素 | 规格 |
|------|------|
| 状态 | `badge-soft` pill（accent/success/danger/neutral），非 inline 文字 |
| 用户消息 | 右侧气泡 surface-secondary，圆角 14px 右下 4px |
| assistant | 左侧纯文块（无气泡），`agent-md` markdown |
| tool | 居中灰卡（唯一带边框对象），折叠时显示 mono brief（命令/路径首 60 字符） |
| tool_result | 同上，brief = 首 80 字符；失败正则匹配 → danger 色 |
| 复制按钮 | hover 行才出现，26px 圆角 8px |
| 时间戳 | mono micro，行下或工具卡内右 |
| 长会话 | 仅渲染最近 50 条，顶部「↑ 还有 N 条更早」展开 |
| composer | 独立区块（顶部 hairline + surface 渐变），圆角 14px border，focus = accent border |
| 附件预览 | 从右滑入（x 20→0, springUI），关闭镜像滑出 |
| 侧栏 | lg 显示，w-72，border-l；文件列表 mono 12px |

### 动效

- 新消息行：opacity 0→1 + y 4→0，180ms（CSS keyframe，reduced-motion 关）
- 附件预览 / 侧栏：springUI 镜像 enter/exit
- 运行中状态点：opacity pulse 1.6s（reduced-motion 关）

## 决策点

- 【 保持现状 】tool 卡默认折叠（现：任务运行中默认展开，历史任务折叠）——统一默认折叠？
- 【 不用描边 】用户气泡是否需要更明显的 accent 描边以区分？
- 【 agent detail header 】现在的UI 返回放在左边，接着是，title，组织看起来很奇怪，状态可以用badge展示
