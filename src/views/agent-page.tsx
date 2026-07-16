import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Button,
  Kbd,
  ListBox,
  Select,
  TextArea,
  TextField,
  toast,
} from "@heroui/react";
import { invoke } from "@tauri-apps/api/core";
import {
  Bot,
  ChevronDown,
  Clipboard,
  Mic,
  Send,
  Settings2,
  Square,
  Trash2,
} from "lucide-react";
import { EmptyState, PageHeader, PageShell } from "@/components/shared/page-shell";
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
      <Button
        variant="ghost"
        className={cn(
          "h-auto min-h-0 min-w-0 flex-1 items-start justify-start gap-2.5 rounded-none",
          "bg-transparent px-0 py-0 text-left font-normal shadow-none",
          "hover:bg-transparent data-[hovered=true]:bg-transparent",
          "data-[pressed=true]:bg-transparent data-[pressed=true]:scale-100",
        )}
        onPress={onOpen}
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
  const [sending, setSending] = useState(false);

  const profiles = useMemo(
    () => normalizeProfiles(config.agent_profiles),
    [config.agent_profiles],
  );
  const profileId =
    profiles.find((p) => p.id === config.agent_profile_id)?.id ??
    profiles[0]?.id ??
    "claude";
  const activeProfile = profiles.find((p) => p.id === profileId) ?? profiles[0];

  const activeCount = agentJobs.filter((j) => isActive(j.status)).length;
  const finishedCount = agentJobs.length - activeCount;
  const canSend = Boolean(prompt.trim()) && !sending;

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
    <PageShell className="agent-list-shell max-w-4xl h-full min-h-0 gap-3 pb-0">
      <PageHeader
        title="派活"
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
          <Button
            size="sm"
            variant="secondary"
            className="btn-press"
            onPress={() => navigate("/settings?tab=agent")}
          >
            <Settings2 size={13} />
            能力
          </Button>
        }
      />

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
                onOpen={() => navigate(`/dispatch/${job.id}`)}
                onCancel={() => void cancelAgentJob(job.id)}
                onDelete={() => void removeJob(job.id)}
                onCopy={() => void copyResult(job)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="agent-list-composer shrink-0 pt-1">
        <div className="agent-composer p-2">
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
              variant="ghost"
              aria-label="语音召唤"
              className="agent-composer-icon btn-press h-7 w-7 min-h-7 min-w-7 p-0"
              onPress={() => void invoke("show_agent_hud")}
            >
              <Mic size={14} />
            </Button>

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
