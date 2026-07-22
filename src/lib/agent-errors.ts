/** Map raw agent CLI errors to actionable Chinese for HUD / 派活 UI. */

export function friendlyAgentError(err: unknown, agent?: string): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const kind = (agent ?? "").toLowerCase();
  const lower = raw.toLowerCase();

  const label =
    kind.includes("claude")
      ? "Claude"
      : kind.includes("codex")
        ? "Codex"
        : kind.includes("pi")
          ? "Pi"
          : "Agent";

  if (
    /找不到|not found|no such file|which |ENOENT|路径不存在/i.test(raw) ||
    lower.includes("command not found")
  ) {
    return `未找到 ${label} CLI。安装后在设置 → 派活 里确认路径。`;
  }
  if (/permission|denied|EACCES|执行权限/i.test(raw)) {
    return `${label} 无法执行（权限）。请在设置 → 派活 检查 CLI 路径与执行权限。`;
  }
  if (raw.trim()) return raw.trim();
  return `${label} 派发失败`;
}
