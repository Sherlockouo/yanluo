import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Button,
  Input,
  Kbd,
  Label,
  ListBox,
  Select,
  TextField,
  toast,
} from "@heroui/react";
import { invoke } from "@tauri-apps/api/core";
import {
  Bot,
  ChevronDown,
  Clipboard,
  Mic,
  Plus,
  RefreshCw,
  Send,
  Square,
  Trash2,
} from "lucide-react";
import {
  EmptyState,
  PageHeader,
  PageShell,
  SoftCollapse,
} from "@/components/shared/page-shell";
import { defaultConfig, hotkeySegments, agentModelsFor } from "@/lib/constants";
import { cn } from "@/lib/cn";
import type { AgentJob, AgentKind, AgentProfile } from "@/types";
import { useApp } from "@/app-context";

function HotkeyKbd({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      {hotkeySegments(label).map((part, i) => (
        <span key={`${part}-${i}`} className="inline-flex items-center gap-1">
          {i > 0 ? <span className="text-border">+</span> : null}
          <Kbd>{part}</Kbd>
        </span>
      ))}
    </span>
  );
}

function jobStatusLabel(status: AgentJob["status"]): string {
  switch (status) {
    case "queued":
      return "排队";
    case "running":
      return "运行中";
    case "done":
      return "完成";
    case "error":
      return "失败";
    case "cancelled":
      return "已取消";
    default:
      return status;
  }
}

function isActive(status: AgentJob["status"]) {
  return status === "queued" || status === "running";
}

function shortBin(path: string): string {
  if (!path) return "未设置";
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 3) return path;
  return `…/${parts.slice(-3).join("/")}`;
}

function normalizeProfiles(list: AgentProfile[] | undefined): AgentProfile[] {
  return list?.length ? list : defaultConfig.agent_profiles;
}

function AgentJobCard({
  job,
  onOpen,
  onCancel,
  onDelete,
  onCopy,
}: {
  job: AgentJob;
  onOpen: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onCopy: () => void;
}) {
  const active = isActive(job.status);
  const attachCount = job.attachments?.length ?? 0;

  return (
    <div
      className={cn(
        "agent-job-row group",
        active && "is-active",
        job.status === "error" && "is-error",
        job.status === "done" && "is-done",
      )}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
        onClick={onOpen}
      >
        <span
          className={cn(
            "agent-job-status-dot mt-1.5",
            active && "is-active",
            job.status === "error" && "is-error",
            job.status === "done" && "is-done",
            job.status === "cancelled" && "is-muted",
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-sm font-semibold capitalize text-foreground">
              {job.agent}
            </span>
            <span
              className={cn(
                "text-[12px]",
                active && "text-accent",
                job.status === "error" && "text-danger",
                job.status === "done" && "text-success",
                !active &&
                  job.status !== "error" &&
                  job.status !== "done" &&
                  "text-muted",
              )}
            >
              {jobStatusLabel(job.status)}
            </span>
            {attachCount > 0 ? (
              <span className="type-meta">{attachCount} 附件</span>
            ) : null}
          </div>
          <div className="select-text mt-0.5 line-clamp-2 text-sm leading-snug text-foreground/90">
            {job.prompt}
          </div>
          {job.progress && active ? (
            <div className="mt-1 truncate text-[12px] text-accent/80">
              {job.progress}
            </div>
          ) : null}
        </div>
      </button>

      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        {active ? (
          <button
            type="button"
            className="rounded-md p-1.5 text-muted transition hover:bg-default/50 hover:text-foreground"
            title="取消"
            onClick={onCancel}
          >
            <Square size={12} fill="currentColor" />
          </button>
        ) : null}
        {(job.result || job.error) && !active ? (
          <button
            type="button"
            className="rounded-md p-1.5 text-muted transition hover:bg-default/50 hover:text-foreground"
            title="复制结果"
            onClick={onCopy}
          >
            <Clipboard size={12} />
          </button>
        ) : null}
        <button
          type="button"
          className="rounded-md p-1.5 text-muted transition hover:bg-default/50 hover:text-danger"
          title="删除"
          onClick={onDelete}
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}

type DetectedBins = {
  claude: string | null;
  codex: string | null;
  pi: string | null;
};

function detectedForKind(
  detected: DetectedBins,
  kind: AgentKind,
): string | null {
  if (kind === "codex") return detected.codex;
  if (kind === "pi") return detected.pi;
  return detected.claude;
}

function defaultModelForKind(kind: AgentKind): string {
  if (kind === "claude") return "sonnet";
  return "";
}

export function AgentPage() {
  const navigate = useNavigate();
  const {
    config,
    updateConfig,
    saveConfig,
    agentJobs,
    cancelAgentJob,
    deleteAgentJob,
  } = useApp();
  const [configOpen, setConfigOpen] = useState(false);
  const [detected, setDetected] = useState<DetectedBins>({
    claude: null,
    codex: null,
    pi: null,
  });
  const [detecting, setDetecting] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);

  const profiles = useMemo(
    () => normalizeProfiles(config.agent_profiles),
    [config.agent_profiles],
  );
  const profileId =
    profiles.find((p) => p.id === config.agent_profile_id)?.id ??
    profiles[0]?.id ??
    "claude";
  const activeProfile =
    profiles.find((p) => p.id === profileId) ?? profiles[0];

  const activeCount = agentJobs.filter((j) => isActive(j.status)).length;
  const finishedCount = agentJobs.length - activeCount;
  const canSend = Boolean(prompt.trim()) && !sending;

  useEffect(() => {
    void refreshDetect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshDetect = async () => {
    setDetecting(true);
    try {
      const next = await invoke<DetectedBins>("detect_agent_bins");
      setDetected(next);
    } catch {
      /* ignore */
    } finally {
      setDetecting(false);
    }
  };

  const selectProfile = (id: string) => {
    const p = profiles.find((x) => x.id === id);
    if (!p) return;
    updateConfig("agent_profile_id", p.id);
    updateConfig("agent_kind", p.kind);
    void saveConfig(
      { ...config, agent_profile_id: p.id, agent_kind: p.kind },
      { silent: true },
    );
  };

  const selectModel = (modelId: string) => {
    const model = modelId === "__default__" ? "" : modelId;
    const next = profiles.map((p) =>
      p.id === profileId ? { ...p, model } : p,
    );
    updateConfig("agent_profiles", next);
    void saveConfig(
      { ...config, agent_profiles: next },
      { silent: true },
    );
  };

  const persistProfiles = (next: AgentProfile[], sel?: string) => {
    const profileIdNext = sel ?? profileId;
    const kind =
      next.find((p) => p.id === profileIdNext)?.kind ?? ("claude" as AgentKind);
    updateConfig("agent_profiles", next);
    updateConfig("agent_profile_id", profileIdNext);
    updateConfig("agent_kind", kind);
    void saveConfig(
      {
        ...config,
        agent_profiles: next,
        agent_profile_id: profileIdNext,
        agent_kind: kind,
      },
      { silent: true },
    );
  };

  const addAgentProfile = () => {
    const id = `agent-${Date.now().toString(36)}`;
    const next: AgentProfile[] = [
      ...profiles,
      {
        id,
        name: "新 Agent",
        kind: "claude",
        bin: "",
        model: "sonnet",
      },
    ];
    persistProfiles(next, id);
  };

  const removeAgentProfile = (id: string) => {
    if (profiles.length <= 1) {
      toast.warning("至少保留一个");
      return;
    }
    const next = profiles.filter((p) => p.id !== id);
    persistProfiles(next, profileId === id ? next[0].id : profileId);
  };

  const patchProfile = (id: string, patch: Partial<AgentProfile>) => {
    const next = profiles.map((p) => (p.id === id ? { ...p, ...patch } : p));
    persistProfiles(next);
  };

  const modelOptions = agentModelsFor(
    (activeProfile?.kind ?? "claude") as AgentKind,
  );
  const currentModel = activeProfile?.model ?? "";
  const modelKey =
    modelOptions.some((m) => m.id === currentModel)
      ? currentModel || "__default__"
      : currentModel
        ? currentModel
        : "__default__";
  const modelLabel =
    modelOptions.find((m) => m.id === currentModel)?.label ??
    (currentModel || "默认");

  const dispatch = async () => {
    const text = prompt.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const kind = activeProfile?.kind ?? "claude";
      await invoke("dispatch_agent", {
        agent: kind,
        prompt: text,
        cwd: config.agent_cwd || "",
        attachments: [] as string[],
      });
      setPrompt("");
    } catch (e) {
      toast.danger(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const copyResult = async (job: AgentJob) => {
    const text = (job.error || job.result || "").trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast.success("已复制");
    } catch {
      toast.danger("复制失败");
    }
  };

  const removeJob = async (id: string) => {
    try {
      await deleteAgentJob(id);
    } catch (e) {
      toast.danger(`删除失败: ${e}`);
    }
  };

  return (
    <PageShell className="agent-list-shell max-w-2xl h-full min-h-0 gap-3 pb-0">
      <PageHeader
        title="Agent"
        status={
          agentJobs.length ? (
            <>
              {activeCount > 0 ? (
                <span className="text-accent">{activeCount} 运行</span>
              ) : null}
              {activeCount > 0 && finishedCount > 0 ? " · " : null}
              {finishedCount > 0 ? `${finishedCount} 完成` : null}
              {!activeCount && !finishedCount ? null : " · "}
              <HotkeyKbd label={config.hotkey_agent?.label ?? "Fn+Space"} />
            </>
          ) : (
            <HotkeyKbd label={config.hotkey_agent?.label ?? "Fn+Space"} />
          )
        }
        action={
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant={configOpen ? "primary" : "ghost"}
              onPress={() => setConfigOpen((v) => !v)}
            >
              配置
            </Button>
            <Button
              size="sm"
              variant="primary"
              className="btn-press"
              onPress={() => void invoke("show_agent_hud")}
            >
              <Mic size={14} />
              召唤
            </Button>

          </div>
        }
      />

      <SoftCollapse open={configOpen}>
        <div className="surface-card mb-1 flex flex-col gap-4 p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="type-ui">Agent 类型</div>
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="secondary"
                isDisabled={detecting}
                onPress={() => void refreshDetect()}
              >
                <RefreshCw
                  size={13}
                  className={detecting ? "animate-spin" : ""}
                />
                which
              </Button>
              <Button size="sm" variant="secondary" onPress={addAgentProfile}>
                <Plus size={13} />
                添加
              </Button>
            </div>
          </div>
          <ul className="flex flex-col gap-2">
            {profiles.map((p) => {
              const hit = detectedForKind(detected, p.kind);
              return (
                <li
                  key={p.id}
                  className={cn(
                    "rounded-xl px-3 py-2.5",
                    p.id === profileId
                      ? "bg-accent/8 ring-1 ring-accent/25"
                      : "bg-default/25",
                  )}
                >
                  <div className="mb-2 flex items-center gap-2">
                    <button
                      type="button"
                      className={cn(
                        "rounded-md px-2 py-0.5 text-[11px] font-medium",
                        p.id === profileId
                          ? "bg-accent text-accent-foreground"
                          : "bg-default/50 text-muted hover:text-foreground",
                      )}
                      onClick={() => selectProfile(p.id)}
                    >
                      {p.id === profileId ? "当前" : "选用"}
                    </button>
                    <button
                      type="button"
                      className="ml-auto rounded-md p-1 text-muted hover:bg-default/50 hover:text-danger"
                      title="删除"
                      onClick={() => removeAgentProfile(p.id)}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <TextField
                      value={p.name}
                      onChange={(v) => patchProfile(p.id, { name: v })}
                    >
                      <Label>名称</Label>
                      <Input />
                    </TextField>
                    <Select
                      selectedKey={p.kind}
                      onSelectionChange={(key) => {
                        if (
                          key !== "claude" &&
                          key !== "codex" &&
                          key !== "pi"
                        ) {
                          return;
                        }
                        patchProfile(p.id, {
                          kind: key,
                          model: defaultModelForKind(key),
                        });
                      }}
                    >
                      <Label>CLI</Label>
                      <Select.Trigger>
                        <Select.Value />
                        <Select.Indicator />
                      </Select.Trigger>
                      <Select.Popover>
                        <ListBox>
                          <ListBox.Item id="claude" textValue="Claude">
                            Claude
                            <ListBox.ItemIndicator />
                          </ListBox.Item>
                          <ListBox.Item id="codex" textValue="Codex">
                            Codex
                            <ListBox.ItemIndicator />
                          </ListBox.Item>
                          <ListBox.Item id="pi" textValue="Pi">
                            Pi
                            <ListBox.ItemIndicator />
                          </ListBox.Item>
                        </ListBox>
                      </Select.Popover>
                    </Select>
                    <TextField
                      value={p.model ?? ""}
                      onChange={(v) => patchProfile(p.id, { model: v })}
                    >
                      <Label>模型</Label>
                      <Input
                        placeholder={
                          p.kind === "claude"
                            ? "sonnet"
                            : p.kind === "pi"
                              ? "空=默认 · provider/id"
                              : "空=默认"
                        }
                      />
                    </TextField>
                    <TextField
                      value={p.bin ?? ""}
                      onChange={(v) => patchProfile(p.id, { bin: v })}
                    >
                      <Label>路径</Label>
                      <Input
                        placeholder={hit ?? `which ${p.kind}`}
                        className="font-mono text-[12px]"
                      />
                    </TextField>
                  </div>
                  {hit ? (
                    <div className="type-meta mt-1.5 truncate">
                      探测 {shortBin(hit)}
                    </div>
                  ) : (
                    <div className="type-meta mt-1.5 text-warning">
                      未找到 {p.kind}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="form-actions">
            <Button
              size="sm"
              variant="primary"
              onPress={() => void saveConfig()}
            >
              保存
            </Button>
          </div>
        </div>
      </SoftCollapse>

      <div className="agent-list-body min-h-0 flex-1 overflow-auto">
        {agentJobs.length === 0 ? (
          <EmptyState
            icon={<Bot size={20} />}
            title="暂无任务"
            description="下方输入派活，或 Fn+Space 语音召唤"
          />
        ) : (
          <div className="flex flex-col gap-0.5 pb-2">
            {agentJobs.map((job) => (
              <AgentJobCard
                key={job.id}
                job={job}
                onOpen={() => navigate(`/agent/${job.id}`)}
                onCancel={() => void cancelAgentJob(job.id)}
                onDelete={() => void removeJob(job.id)}
                onCopy={() => void copyResult(job)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="agent-list-composer shrink-0 pt-1">
        <div className="agent-composer">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={2}
            placeholder="派给 Agent…"
            className="agent-composer-input"
            disabled={sending}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void dispatch();
              }
            }}
          />
          <div className="agent-composer-bar">
            <Select
              className="inline-flex min-w-24"
              aria-label="Agent"
              selectedKey={profileId}
              onSelectionChange={(key) => {
                if (key == null) return;
                selectProfile(String(key));
              }}
            >
              <Select.Trigger className="agent-profile-trigger">
                <Select.Value>
                  {() => (
                    <span className="inline-flex items-center gap-1">
                      <Bot size={12} />
                      <span>{activeProfile?.name ?? "Agent"}</span>
                    </span>
                  )}
                </Select.Value>
                <ChevronDown size={12} className="shrink-0 opacity-50" />
              </Select.Trigger>
              <Select.Popover className="min-w-36">
                <ListBox>
                  {profiles.map((p) => (
                    <ListBox.Item className="flex items-center justify-start gap-1" key={p.id} id={p.id} textValue={p.name}>
                      <div>{p.name}</div>
                      <div>{p.kind}</div>
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>

            <Select
              className="inline-flex w-auto"
              aria-label="模型"
              selectedKey={modelKey}
              onSelectionChange={(key) => {
                if (key == null) return;
                selectModel(String(key));
              }}
            >
              <Select.Trigger className="agent-model-trigger">
                <Select.Value>
                  {() => <span>{modelLabel}</span>}
                </Select.Value>
                <ChevronDown size={12} className="shrink-0 opacity-50" />
              </Select.Trigger>
              <Select.Popover className="min-w-36">
                <ListBox>
                  {modelOptions.map((m) => (
                    <ListBox.Item
                      key={m.id || "__default__"}
                      id={m.id || "__default__"}
                      textValue={m.label}
                    >
                      <span>{m.label}</span>
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                  {currentModel &&
                  !modelOptions.some((m) => m.id === currentModel) ? (
                    <ListBox.Item
                      id={currentModel}
                      textValue={currentModel}
                    >
                      <span>{currentModel}</span>
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ) : null}
                </ListBox>
              </Select.Popover>
            </Select>

            <button
              type="button"
              title="语音召唤"
              className="agent-composer-icon"
              onClick={() => void invoke("show_agent_hud")}
            >
              <Mic size={14} />
            </button>

            <button
              type="button"
              title="发送 Enter"
              className="agent-composer-send is-accent"
              disabled={!canSend}
              onClick={() => void dispatch()}
            >
              <Send size={13} strokeWidth={2.4} />
            </button>
          </div>
        </div>
      </div>
    </PageShell>
  );
}
