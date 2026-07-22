import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Button,
  ListBox,
  Select,
  TextArea,
  TextField,
  toast,
} from "@heroui/react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Bot,
  ChevronDown,
  Clipboard,
  Paperclip,
  Send,
  Settings2,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { PageShell, Reveal } from "@/components/shared/page-shell";
import { defaultConfig, agentModelsFor } from "@/lib/constants";
import { cn } from "@/lib/cn";
import { takePendingDispatchPrompt } from "@/lib/ui-session";
import { friendlyAgentError } from "@/lib/agent-errors";
import type { AgentJob, AgentKind, AgentProfile } from "@/types";
import { useApp } from "@/app-context";

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

/** "14:32" — IBM Plex Mono slot in the kicker. */
function fmtClock(ts?: string | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** "42s" / "3m" / "1h 05m" — elapsed or total duration. */
function fmtDuration(start?: string | null, end?: string | null): string {
  if (!start) return "";
  const a = new Date(start).getTime();
  const b = end ? new Date(end).getTime() : Date.now();
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return "";
  const s = Math.round((b - a) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
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
  const clock = fmtClock(job.started_at);
  const duration = fmtDuration(
    job.started_at,
    active ? null : job.finished_at,
  );

  return (
    <div
      className={cn(
        "agent-job-row group",
        job.status === "error" && "is-error",
        job.status === "done" && "is-done",
      )}
    >
      <span
        className={cn(
          "agent-job-status-dot",
          active && "is-active",
          job.status === "error" && "is-error",
          job.status === "done" && "is-done",
          job.status === "cancelled" && "is-muted",
        )}
      />
      <Button
        variant="ghost"
        className={cn(
          "h-auto min-h-0 min-w-0 flex-1 items-start justify-start rounded-none",
          "bg-transparent px-0 py-0 text-left font-normal shadow-none",
          "hover:bg-transparent data-[hovered=true]:bg-transparent",
          "data-[pressed=true]:bg-transparent data-[pressed=true]:scale-100",
        )}
        onPress={onOpen}
      >
        <div className="min-w-0 flex-1">
          <div className="agent-job-kicker">
            <span className="capitalize">{job.agent}</span>
            <span
              className={cn(
                active && "is-status-active",
                job.status === "error" && "is-status-error",
                job.status === "done" && "is-status-done",
              )}
            >
              {jobStatusLabel(job.status)}
            </span>
            {clock || duration ? (
              <span>
                {clock}
                {clock && duration ? " · " : ""}
                {duration}
              </span>
            ) : null}
            {attachCount > 0 ? <span>{attachCount} 附件</span> : null}
          </div>
          <div className="agent-job-prompt select-text line-clamp-2">
            {job.prompt}
          </div>
          {job.progress && active ? (
            <div className="mt-1 truncate type-meta text-accent-soft-foreground">
              {job.progress}
            </div>
          ) : null}
        </div>
      </Button>

      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
        {active ? (
          <Button
            size="sm"
            isIconOnly
            variant="ghost"
            className="btn-press text-muted"
            aria-label="取消"
            onPress={onCancel}
          >
            <Square size={12} fill="currentColor" />
          </Button>
        ) : null}
        {(job.result || job.error) && !active ? (
          <Button
            size="sm"
            isIconOnly
            variant="ghost"
            className="btn-press text-muted"
            aria-label="复制结果"
            onPress={onCopy}
          >
            <Clipboard size={12} />
          </Button>
        ) : null}
        <Button
          size="sm"
          isIconOnly
          variant="ghost"
          className="btn-press text-muted hover:text-danger data-[hovered=true]:text-danger"
          aria-label="删除"
          onPress={onDelete}
        >
          <Trash2 size={12} />
        </Button>
      </div>
    </div>
  );
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
    agentModels,
  } = useApp();
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [sending, setSending] = useState(false);

  // 派这段 bridge: 历史/其它页面 stash text via ui-session, we pick it up once.
  useEffect(() => {
    const pending = takePendingDispatchPrompt();
    if (pending) setPrompt((prev) => prev || pending);
  }, []);

  const profiles = useMemo(
    () => normalizeProfiles(config.agent_profiles),
    [config.agent_profiles],
  );
  const profileId =
    profiles.find((p) => p.id === config.agent_profile_id)?.id ??
    profiles[0]?.id ??
    "claude";
  const activeProfile = profiles.find((p) => p.id === profileId) ?? profiles[0];

  const canSend = (Boolean(prompt.trim()) || attachments.length > 0) && !sending;

  const pickAttachments = async () => {
    const selected = await openDialog({
      multiple: true,
      defaultPath: config.agent_cwd || undefined,
    }).catch(() => null);
    const picked = Array.isArray(selected)
      ? selected
      : typeof selected === "string"
        ? [selected]
        : [];
    if (!picked.length) return;
    setAttachments((prev) => [...new Set([...prev, ...picked])]);
  };

  const removeAttachment = (path: string) => {
    setAttachments((prev) => prev.filter((p) => p !== path));
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
    void saveConfig({ ...config, agent_profiles: next }, { silent: true });
  };

  const modelOptions = agentModelsFor(
    (activeProfile?.kind ?? "claude") as AgentKind,
    agentModels,
  );
  const currentModel = activeProfile?.model ?? "";
  const modelKey = modelOptions.some((m) => m.id === currentModel)
    ? currentModel || "__default__"
    : currentModel
      ? currentModel
      : "__default__";
  const modelLabel =
    modelOptions.find((m) => m.id === currentModel)?.label ??
    (currentModel || "默认");

  const dispatch = async () => {
    const text = prompt.trim();
    if ((!text && attachments.length === 0) || sending) return;
    setSending(true);
    const kind = activeProfile?.kind ?? "claude";
    try {
      await invoke("dispatch_agent", {
        agent: kind,
        prompt: text,
        cwd: config.agent_cwd || "",
        attachments,
      });
      setPrompt("");
      setAttachments([]);
    } catch (e) {
      toast.danger(friendlyAgentError(e, kind));
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
    <PageShell className="agent-list-shell max-w-3xl h-full min-h-0 gap-0 pb-0">
      <header className="amast">
        <div className="amast-top">
          <span className="amast-kicker">派活 · agent jobs</span>
          <Button
            size="sm"
            variant="ghost"
            className="amast-action btn-press"
            onPress={() => navigate("/settings?tab=agent")}
          >
            <Settings2 size={12} />
            能力
          </Button>
        </div>
        <h1 className="amast-title">派活</h1>
      </header>

      <div className="agent-list-body min-h-0 flex-1 overflow-auto">
        {agentJobs.length === 0 ? (
          <div className="agent-list-empty">
            <div className="dropzone">
              <span className="dropzone-ic">
                <Bot size={22} aria-hidden />
              </span>
              <span className="dropzone-t">开口派活</span>
              <span className="dropzone-fmt">
                Fn+Space 说一声，或下面打字 — 声音不出电脑
              </span>
            </div>
          </div>
        ) : (
          <div className="agent-job-list flex flex-col pb-2">
            {agentJobs.map((job, i) => (
              <Reveal key={job.id} index={i}>
                <AgentJobCard
                  job={job}
                  onOpen={() => navigate(`/dispatch/${job.id}`)}
                  onCancel={() => void cancelAgentJob(job.id)}
                  onDelete={() => void removeJob(job.id)}
                  onCopy={() => void copyResult(job)}
                />
              </Reveal>
            ))}
          </div>
        )}
      </div>

      <div className="agent-list-composer shrink-0 pt-1">
        <div className="agent-composer">
          {attachments.length > 0 ? (
            <div className="agent-attach-chips">
              {attachments.map((path) => (
                <span key={path} className="agent-attach-chip" title={path}>
                  <Paperclip size={11} className="shrink-0 opacity-60" />
                  <span className="agent-attach-chip-name">
                    {path.split("/").filter(Boolean).pop() ?? path}
                  </span>
                  <button
                    type="button"
                    aria-label={`移除 ${path}`}
                    className="agent-attach-chip-x"
                    onClick={() => removeAttachment(path)}
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <TextField
            fullWidth
            aria-label="派活"
            value={prompt}
            onChange={setPrompt}
            isDisabled={sending}
            className="agent-composer-field"
          >
            <TextArea
              rows={2}
              placeholder="派个活…"
              className="agent-composer-input"
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void dispatch();
                }
              }}
            />
          </TextField>
          <div className="agent-composer-bar">
            <Button
              isIconOnly
              variant="ghost"
              aria-label="添加文件"
              className="agent-composer-icon btn-press h-7 w-7 min-h-7 min-w-7 p-0"
              onPress={() => void pickAttachments()}
            >
              <Paperclip size={14} />
            </Button>

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
                    <ListBox.Item
                      className="flex items-center justify-start gap-1"
                      key={p.id}
                      id={p.id}
                      textValue={p.name}
                    >
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
                <Select.Value>{() => <span>{modelLabel}</span>}</Select.Value>
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
                    <ListBox.Item id={currentModel} textValue={currentModel}>
                      <span>{currentModel}</span>
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ) : null}
                </ListBox>
              </Select.Popover>
            </Select>

            <Button
              isIconOnly
              variant="primary"
              aria-label="发送 Enter"
              className="agent-composer-send btn-press h-7 w-7 min-h-7 min-w-7 p-0"
              isDisabled={!canSend}
              onPress={() => void dispatch()}
            >
              <Send size={13} strokeWidth={2.4} />
            </Button>
          </div>
        </div>
      </div>
    </PageShell>
  );
}
