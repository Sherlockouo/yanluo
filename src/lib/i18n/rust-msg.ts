/**
 * Rust → i18n bridge: maps known Chinese strings from Rust `emit()` / `invoke()`
 * error payloads to i18n keys so the HUD can display them in the active locale.
 *
 * Pattern: the Rust string is matched as a *prefix* (e.g. "不存在: /path" matches
 * the "不存在" entry). If no match → original string is returned unchanged.
 *
 * Usage:
 *   import { lookupRustMsg } from "@/lib/i18n/rust-msg";
 *   const displayed = lookupRustMsg(error, t);
 */
import type { tStatic } from "./index";

type TFunc = typeof tStatic;

/**
 * Known Rust-side Chinese prefixes → "hud.rustMsg.*" keys.
 * Sorted longest-first so "剪贴板无文件/图片" wins over a hypothetical "剪贴板" prefix.
 */
const RUST_PREFIXES: [string, string][] = [
  ["MLX worker 已退出（可能已崩溃）。请重启应用后再试。", "hud.rustMsg.MLX worker 已退出（可能已崩溃）。请重启应用后再试。"],
  ["LLM 请求超时（90s）。检查 Ollama 是否在跑、模型是否已拉取。", "hud.rustMsg.LLM 请求超时（90s）。检查 Ollama 是否在跑、模型是否已拉取。"],
  ["LLM 纠错未启用（LLM 页打开「启用纠错」并保存）", "hud.rustMsg.LLM 纠错未启用（LLM 页打开「启用纠错」并保存）"],
  ["Model not loaded — 请先在设置 → 识别 加载 Qwen 模型", "hud.rustMsg.Model not loaded — 请先在设置 → 识别 加载 Qwen 模型"],
  ["未授权语音识别 — 设置 → 系统 → 权限，打开「语音识别」", "hud.rustMsg.未授权语音识别 — 设置 → 系统 → 权限，打开「语音识别」"],
  ["Apple Speech 仅支持 macOS，请改用 Qwen 本地识别", "hud.rustMsg.Apple Speech 仅支持 macOS，请改用 Qwen 本地识别"],
  ["ElevenLabs 已移除 — 请在设置 → 识别 改选 Apple 或 Qwen", "hud.rustMsg.ElevenLabs 已移除 — 请在设置 → 识别 改选 Apple 或 Qwen"],
  ["已写入剪切板，但粘贴失败（请检查辅助功能权限）", "hud.rustMsg.已写入剪切板，但粘贴失败（请检查辅助功能权限）"],
  ["粘贴失败，文字已在剪贴板", "hud.rustMsg.粘贴失败，文字已在剪贴板"],
  ["切换目标语言后重译失败", "hud.rustMsg.切换目标语言后重译失败"],
  ["剪贴板附件仅支持 macOS", "hud.rustMsg.剪贴板附件仅支持 macOS"],
  ["剪贴板无文件/图片", "hud.rustMsg.剪贴板无文件/图片"],
  ["写入剪贴板图片失败", "hud.rustMsg.写入剪贴板图片失败"],
  ["当前平台不支持系统打开", "hud.rustMsg.当前平台不支持系统打开"],
  ["没有待确认的识别结果", "hud.rustMsg.没有待确认的识别结果"],
  ["正在录音中，请先结束录音", "hud.rustMsg.正在录音中，请先结束录音"],
  ["派活态请用 Enter 派发", "hud.rustMsg.派活态请用 Enter 派发"],
  ["当前不在处理中间态", "hud.rustMsg.当前不在处理中间态"],
  ["确认文本不能为空", "hud.rustMsg.确认文本不能为空"],
  ["未配置 API Base URL", "hud.rustMsg.未配置 API Base URL"],
  ["未配置 Model", "hud.rustMsg.未配置 Model"],
  // Partial match: Rust interpolates detail mid-sentence（系统音频不可用（{err}）…）;
  // the Chinese tail is appended as-is — better than fully untranslated.
  ["系统音频不可用", "hud.rustMsg.系统音频不可用"],
  ["会话已取消", "hud.rustMsg.会话已取消"],
  ["打开失败", "hud.rustMsg.打开失败"],
  ["不存在", "hud.rustMsg.不存在"],
  ["无内容", "hud.rustMsg.无内容"],
];

/**
 * Translate a Rust-originated user-visible string through the i18n layer.
 * Falls back to the raw string if no mapping is found.
 */
export function lookupRustMsg(raw: string, t: TFunc): string {
  if (!raw) return raw;
  for (const [prefix, key] of RUST_PREFIXES) {
    if (raw === prefix || raw.startsWith(prefix)) {
      const translated = t(key);
      // Append any suffix the Rust side added (e.g. ": /path/file")
      const suffix = raw.slice(prefix.length);
      return translated + suffix;
    }
  }
  return raw;
}
