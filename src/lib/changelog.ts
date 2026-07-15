/** Bundled release notes shown offline in Settings → 更新. */
export type ChangelogEntry = {
  version: string;
  date: string;
  notes: string[];
};

export const APP_REPO = "XBCoder128/asr-cli";
export const APP_REPO_URL = `https://github.com/${APP_REPO}`;
export const APP_RELEASES_URL = `${APP_REPO_URL}/releases`;

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "0.1.1",
    date: "2026-07-10",
    notes: [
      "修复 Apple Speech 权限请求崩溃（主线程异步）",
      "HUD 改为细频谱条：Goertzel 分频 + 独立起落",
      "ElevenLabs 凭证移入 ASR 引擎设置",
      "多平台 CI / Release（macOS · Linux · Windows）",
    ],
  },
  {
    version: "0.1.0",
    date: "2026-07-10",
    notes: [
      "首个公开构建：Tauri 桌面端 + 浮动 HUD 胶囊",
      "Apple Speech（仅 macOS）/ ElevenLabs / Qwen 本地（可选）",
      "ForcedAligner 字符级对齐与视频转写回放高亮",
      "设置页：常规 / 权限（请求+调试路径）/ 版本更新",
      "GitHub Actions 多平台打包：macOS / Linux / Windows",
    ],
  },
];
