import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Button, Dropdown, Label, ListBox, Select, TextArea, TextField, toast } from "@heroui/react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeft,
  AtSign,
  Bot,
  ChevronDown,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  PanelRight,
  PanelRightClose,
  Paperclip,
  Plus,
  Send,
  Square,
  Wrench,
  X,
} from "lucide-react";
import {
  EmptyState,
  PageHeader,
  PageShell,
  SoftCollapse,
} from "@/components/shared/page-shell";
import { MarkdownBody } from "@/components/shared/markdown-body";
import { AttachMediaBody } from "@/components/ui/attach-media-body";
import {
  toolCallToMarkdown,
  toolResultToMarkdown,
} from "@/lib/agent-tool-md";
import { defaultConfig, agentModelsFor } from "@/lib/constants";
import { cn } from "@/lib/cn";
import type {
  AgentJob,
  AgentJobEvent,
  AgentKind,
  AgentPathInfo,
} from "@/types";
import { useApp } from "@/app-context";

type Attachment = AgentPathInfo & { at: boolean };

function shortName(name: string, max = 14): string {
  if (name.length <= max) return name;
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  const base = name.slice(0, Math.max(4, max - ext.length - 1));
  return `${base}…${ext}`;
}

async function loadPathInfo(path: string, at: boolean): Promise<Attachment> {
  const info = await invoke<AgentPathInfo>("get_path_info", { path });
  return { ...info, at: at || info.kind === "dir" };
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

function extractPaths(text: string): string[] {
  const re =
    /(?:^|[\s`"'(])((?:\/Users\/|\/home\/|\/var\/|\/tmp\/|[A-Za-z]:\\)[^\s`"')\]]+)/gm;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const p = m[1].replace(/[.,;:]+$/, "");
    if (p && !out.includes(p)) out.push(p);
  }
  return out.slice(0, 40);
}

/** Drop duplicate assistant/result rows that show the same body (fig1 issue). */
function dedupeEvents(list: AgentJobEvent[]): AgentJobEvent[] {
  const out: AgentJobEvent[] = [];
  for (const e of list) {
    const prev = out[out.length - 1];
    const sameBody =
      prev &&
      (prev.kind === "assistant" || prev.kind === "result") &&
      (e.kind === "assistant" || e.title === "result" || e.kind === "assistant") &&
      prev.text.trim() === e.text.trim() &&
      e.text.trim().length > 0;
    // also: result following assistant with identical text
    const resultDup =
      prev &&
      prev.kind === "assistant" &&
      (e.title === "result" || e.kind === "assistant") &&
      prev.text.trim() === e.text.trim() &&
      e.text.trim().length > 40;
    if (sameBody || resultDup) continue;
    out.push(e);
  }
  return out;
}

function eventBodyMarkdown(event: AgentJobEvent): string {
  const raw = event.text;
  if (!raw.trim()) return "";
  if (event.kind === "tool") {
    return toolCallToMarkdown(event.title || event.kind, raw);
  }
  if (event.kind === "tool_result") {
    return toolResultToMarkdown(raw);
  }
  return raw;
}

function EventRow({
  event,
  streaming,
  jobActive,
}: {
  event: AgentJobEvent;
  streaming?: boolean;
  jobActive?: boolean;
}) {
  const body = eventBodyMarkdown(event);
  const kind = event.kind;
  const isUser = kind === "user";
  const isTool = kind === "tool";
  const isToolResult = kind === "tool_result";
  const isError = kind === "error";
  const isStatus = kind === "status" || kind === "system";
  const toolLabel = (event.title || "").replace(/^tool\s*·\s*/i, "") || "tool";
  const preferOpen = Boolean(jobActive || streaming);
  const [foldOpen, setFoldOpen] = useState(preferOpen);

  useEffect(() => {
    setFoldOpen(preferOpen);
  }, [preferOpen]);

  if (isStatus && !body) {
    return (
      <p className="agent-chat-meta">{event.title || kind}</p>
    );
  }

  if (isUser) {
    return (
      <article className="agent-chat-row is-user">
        <div className="agent-chat-bubble">
          {body ? <MarkdownBody text={body} /> : null}
        </div>
      </article>
    );
  }

  if (isTool) {
    return (
      <article className="agent-chat-row is-tool">
        <div className="agent-tool-card">
          <Button
            variant="ghost"
            className="agent-tool-card-head h-auto min-h-0 min-w-0 justify-start rounded-none px-0 py-0 shadow-none data-[pressed=true]:scale-100"
            aria-expanded={foldOpen}
            onPress={() => setFoldOpen((v) => !v)}
          >
            <Wrench size={13} strokeWidth={2} className="shrink-0 opacity-50" />
            <span className="agent-tool-card-name">{toolLabel}</span>
            <ChevronDown
              size={13}
              strokeWidth={2}
              className={cn(
                "ml-auto shrink-0 opacity-40 transition-transform duration-150",
                foldOpen && "rotate-180",
              )}
            />
          </Button>
          <SoftCollapse open={foldOpen && Boolean(body)}>
            <MarkdownBody text={body} className="agent-tool-card-body" />
          </SoftCollapse>
        </div>
      </article>
    );
  }

  if (isToolResult) {
    return (
      <article className="agent-chat-row is-tool-result w-full">
        <div className="agent-tool-card w-full">
          <Button
            variant="ghost"
            className="agent-tool-card-head h-auto min-h-0 min-w-0 justify-start rounded-none px-0 py-0 shadow-none data-[pressed=true]:scale-100"
            aria-expanded={foldOpen}
            onPress={() => setFoldOpen((v) => !v)}
          >
            <FileText size={13} strokeWidth={2} className="shrink-0 opacity-50" />
            <span className="agent-tool-card-name">结果</span>
            <ChevronDown
              size={13}
              strokeWidth={2}
              className={cn(
                "ml-auto shrink-0 opacity-40 transition-transform duration-150",
                foldOpen && "rotate-180",
              )}
            />
          </Button>
          <SoftCollapse open={foldOpen && Boolean(body)}>
            <MarkdownBody
              text={body}
              className="agent-tool-result max-w-full"
            />
          </SoftCollapse>
        </div>
      </article>
    );
  }

  return (
    <article
      className={cn(
        "agent-chat-row is-assistant",
        isError && "is-error",
      )}
    >
      <div className="agent-msg-block w-full">
        {isError ? (
          <p className="agent-chat-meta is-danger">{event.title || "error"}</p>
        ) : null}
        {body ? (
          <MarkdownBody className="w-full" text={body} streaming={streaming} />
        ) : null}
      </div>
    </article>
  );
}

function AttachPreview({
  item,
  onClose,
}: {
  item: Attachment | AgentPathInfo;
  onClose: () => void;
}) {
  const isDir =
    "at" in item ? item.at || item.kind === "dir" : item.kind === "dir";
  const isImage = item.kind === "image";

  return (
    <div className="agent-attach-preview-card">
      <div className="mb-1.5 flex items-center gap-2">
        {isImage ? (
          <ImageIcon size={12} className="opacity-60" />
        ) : isDir ? (
          <FolderOpen size={12} className="opacity-60" />
        ) : (
          <FileText size={12} className="opacity-60" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {isDir ? `@${item.name}` : item.name}
        </span>
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label="关闭预览"
          className="rounded p-1 text-muted"
          onPress={onClose}
        >
          <X size={12} />
        </Button>
      </div>
      <AttachMediaBody
        item={item}
        density="compact"
        renderText={(preview, name) => (
          <div className="agent-attach-preview max-h-40 w-full overflow-auto text-left">
            <MarkdownBody
              text={
                /\.(md|markdown|mdx)$/i.test(name)
                  ? preview
                  : toolResultToMarkdown(preview)
              }
              className="pointer-events-none text-[11px] leading-snug"
            />
          </div>
        )}
      />
    </div>
  );
}

export function AgentJobPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const {
    config,
    updateConfig,
    saveConfig,
    agentJobs,
    cancelAgentJob,
    continueAgentJob,
    agentModels,
  } = useApp();
  const job = useMemo(
    () => agentJobs.find((j) => j.id === id) ?? null,
    [agentJobs, id],
  );
  const profiles = useMemo(
    () =>
      config.agent_profiles?.length
        ? config.agent_profiles
        : defaultConfig.agent_profiles,
    [config.agent_profiles],
  );
  const profileId =
    profiles.find((p) => p.id === config.agent_profile_id)?.id ??
    profiles[0]?.id ??
    "claude";
  const activeProfile =
    profiles.find((p) => p.id === profileId) ?? profiles[0];

  const [preview, setPreview] = useState<Attachment | AgentPathInfo | null>(
    null,
  );
  const [previewBusy, setPreviewBusy] = useState(false);
  const [reply, setReply] = useState("");
  const [replyAttach, setReplyAttach] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const [addMenu, setAddMenu] = useState(false);
  const [sideOpen, setSideOpen] = useState(() => {
    try {
      return localStorage.getItem("asr-agent-side") !== "0";
    } catch {
      return true;
    }
  });
  const timelineRef = useRef<HTMLDivElement>(null);

  const toggleSide = () => {
    setSideOpen((v) => {
      const next = !v;
      try {
        localStorage.setItem("asr-agent-side", next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const rawEvents = job?.events?.length
    ? job.events
    : job
      ? ([
          {
            seq: 0,
            ts: job.started_at,
            kind: "user",
            title: "user",
            text: job.prompt,
          },
          ...(job.error
            ? [
                {
                  seq: 1,
                  ts: job.finished_at || job.started_at,
                  kind: "error",
                  title: "error",
                  text: job.error,
                },
              ]
            : job.result
              ? [
                  {
                    seq: 1,
                    ts: job.finished_at || job.started_at,
                    kind: "assistant",
                    title: "assistant",
                    text: job.result,
                  },
                ]
              : []),
        ] as AgentJobEvent[])
      : [];

  const events = useMemo(() => dedupeEvents(rawEvents), [rawEvents]);

  const paths = useMemo(() => {
    if (!job) return [] as string[];
    const fromAttach = job.attachments ?? [];
    const fromBody = extractPaths(
      [job.result, job.error, ...events.map((e) => e.text)]
        .filter(Boolean)
        .join("\n"),
    );
    const merged = [...fromAttach];
    for (const p of fromBody) {
      if (!merged.includes(p)) merged.push(p);
    }
    for (const a of replyAttach) {
      if (!merged.includes(a.path)) merged.push(a.path);
    }
    return merged;
  }, [job, events, replyAttach]);

  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [events.length, job?.progress, job?.status]);

  const openPreview = async (path: string) => {
    setPreviewBusy(true);
    try {
      const info = await invoke<AgentPathInfo>("get_path_info", { path });
      setPreview(info);
    } catch (e) {
      toast.warning(e instanceof Error ? e.message : String(e));
    } finally {
      setPreviewBusy(false);
    }
  };

  const mergeReplyAttach = useCallback(async (pathsIn: string[], at: boolean) => {
    const next: Attachment[] = [];
    for (const p of pathsIn) {
      try {
        next.push(await loadPathInfo(p, at));
      } catch {
        /* skip */
      }
    }
    if (!next.length) return;
    setReplyAttach((prev) => {
      const merged = [...prev];
      for (const a of next) {
        if (!merged.some((x) => x.path === a.path)) merged.push(a);
      }
      return merged;
    });
    if (next.length === 1) setPreview(next[0]);
    setAddMenu(false);
  }, []);

  const addReplyAttach = async (asDir: boolean) => {
    setAddMenu(false);
    const selected = await openDialog(
      asDir
        ? {
            directory: true,
            multiple: false,
            defaultPath: job?.cwd || undefined,
          }
        : {
            multiple: true,
            defaultPath: job?.cwd || undefined,
          },
    ).catch(() => null);
    const picked = Array.isArray(selected)
      ? selected
      : typeof selected === "string"
        ? [selected]
        : [];
    if (!picked.length) return;
    await mergeReplyAttach(picked, asDir);
  };

  const canContinue =
    !!job && !isActive(job.status) && Boolean(job.session_id?.trim());

  const canDispatchNew =
    !!job && !isActive(job.status) && !job.session_id?.trim();

  const canSend =
    !!job &&
    !sending &&
    (Boolean(reply.trim()) || replyAttach.length > 0) &&
    (canContinue || canDispatchNew);

  const selectModel = (modelId: string) => {
    const model = modelId === "__default__" ? "" : modelId;
    // Prefer profile matching this job's agent kind.
    const targetId =
      profiles.find((p) => p.kind === job?.agent)?.id ?? profileId;
    const next = profiles.map((p) =>
      p.id === targetId ? { ...p, model } : p,
    );
    updateConfig("agent_profiles", next);
    void saveConfig(
      { ...config, agent_profiles: next },
      { silent: true },
    );
  };

  const jobKind = (job?.agent ?? activeProfile?.kind ?? "claude") as AgentKind;
  const jobProfile =
    profiles.find((p) => p.kind === jobKind) ?? activeProfile;
  const modelOptions = agentModelsFor(jobKind, agentModels);
  const currentModel = jobProfile?.model ?? "";
  const modelKey =
    modelOptions.some((m) => m.id === currentModel)
      ? currentModel || "__default__"
      : currentModel || "__default__";
  const modelLabel =
    modelOptions.find((m) => m.id === currentModel)?.label ??
    (currentModel || "默认");

  const sendContinue = async () => {
    if (!job || !canSend) return;
    setSending(true);
    try {
      if (canContinue) {
        await continueAgentJob(
          job.id,
          reply.trim(),
          replyAttach.map((a) => a.path),
        );
      } else {
        await invoke("dispatch_agent", {
          agent: job.agent,
          prompt: reply.trim() || "（见附件）",
          cwd: job.cwd,
          attachments: replyAttach.map((a) => a.path),
        });
      }
      setReply("");
      setReplyAttach([]);
      setPreview(null);
      setAddMenu(false);
    } catch (e) {
      toast.danger(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  useEffect(() => {
    if (!canContinue && !canDispatchNew) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key !== "v" && e.key !== "V") return;
      const t = e.target as HTMLElement | null;
      if (!t?.closest?.("[data-continue-composer]")) return;
      void (async () => {
        const clipPaths = await invoke<string[]>(
          "read_clipboard_attachments",
        ).catch(() => [] as string[]);
        if (!clipPaths.length) return;
        e.preventDefault();
        await mergeReplyAttach(clipPaths, false);
      })();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [canContinue, canDispatchNew, mergeReplyAttach]);

  if (!job) {
    return (
      <PageShell>
        <PageHeader
          title="任务"
          action={
            <Link
              to="/dispatch"
              className="text-sm text-muted hover:text-foreground"
            >
              返回列表
            </Link>
          }
        />
        <EmptyState title="任务不存在" description="可能已被删除。" />
      </PageShell>
    );
  }

  const active = isActive(job.status);

  return (
    <PageShell className="agent-job-shell max-w-5xl h-full min-h-0 gap-3 pb-0">
      <header className="agent-job-head shrink-0">
        <Button
          size="sm"
          variant="secondary"
          className="agent-job-back"
          onPress={() => navigate("/dispatch")}
        >
          <ArrowLeft size={14} />
          返回
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="type-display truncate capitalize">
            {job.agent}
            <span className="font-normal text-muted">
              {" "}
              · {jobStatusLabel(job.status)}
            </span>
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 type-meta">
            <span className="truncate" title={job.cwd}>
              {job.cwd.replace(/^\/Users\/[^/]+/, "~")}
            </span>
            {job.session_id ? (
              <span className="font-mono text-[11px]" title={job.session_id}>
                {job.session_id}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {active ? (
            <Button
              size="sm"
              variant="ghost"
              onPress={() => void cancelAgentJob(job.id)}
            >
              <Square size={12} fill="currentColor" />
              取消
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            aria-label={sideOpen ? "收起文件栏" : "文件栏"}
            onPress={toggleSide}
          >
            {sideOpen ? (
              <PanelRightClose size={14} />
            ) : (
              <PanelRight size={14} />
            )}
            <span className="hidden sm:inline">
              {sideOpen ? "收起" : "文件"}
            </span>
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <section className="agent-chat flex min-h-0 flex-1 flex-col rounded-2xl bg-surface">
            <div className="flex shrink-0 items-center gap-2 px-4 pt-3.5 pb-1">
              <Bot size={13} className={active ? "text-accent" : "text-muted"} />
              <span className="text-sm font-medium">对话</span>
              <span className="type-meta">{events.length}</span>
              {job.progress && active ? (
                <span className="truncate type-meta">{job.progress}</span>
              ) : null}
            </div>
            <div
              ref={timelineRef}
              className="agent-chat-timeline max-w-full min-h-0 flex-1 overflow-auto px-4 py-3"
            >
              <div className="flex flex-col gap-4">
              {events.length === 0 ? (
                <p className="type-meta">{active ? "运行中…" : "无输出"}</p>
              ) : (
                events.map((e, i) => (
                  <EventRow
                    key={`${e.seq}-${e.ts}-${e.kind}`}
                    event={e}
                    jobActive={active}
                    streaming={
                      active &&
                      i === events.length - 1 &&
                      e.kind === "assistant"
                    }
                  />
                ))
              )}
              </div>
            </div>

            <div
              className="agent-chat-composer-wrap shrink-0 px-3 pb-3 pt-1"
              data-continue-composer
            >
              {canContinue || canDispatchNew ? (
                <div className="flex flex-col gap-2">
                  {replyAttach.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {replyAttach.map((a) => (
                        <div
                          key={a.path}
                          title={a.path}
                          className={cn(
                            "inline-flex max-w-40 items-center gap-0.5 rounded-full border border-border py-0.5 pl-1.5 pr-0.5 text-[11px] transition hover:bg-default/40",
                            preview?.path === a.path &&
                              "border-accent/40 bg-accent/10",
                          )}
                        >
                          <Button
                            variant="ghost"
                            className="h-auto min-h-0 min-w-0 flex-1 gap-1 rounded-none bg-transparent px-0.5 py-0.5 text-[11px] font-normal shadow-none hover:bg-transparent data-[hovered=true]:bg-transparent data-[pressed=true]:scale-100"
                            onPress={() => setPreview(a)}
                          >
                            {a.at || a.kind === "dir" ? (
                              <AtSign
                                size={10}
                                className="shrink-0 opacity-70"
                              />
                            ) : (
                              <Paperclip
                                size={10}
                                className="shrink-0 opacity-70"
                              />
                            )}
                            <span className="min-w-0 truncate">
                              {a.at || a.kind === "dir"
                                ? `@${shortName(a.name)}`
                                : shortName(a.name)}
                            </span>
                          </Button>
                          <Button
                            isIconOnly
                            variant="ghost"
                            aria-label="移除附件"
                            className="h-auto min-h-0 min-w-0 rounded p-0.5 opacity-50 shadow-none hover:bg-default/50 hover:opacity-100 data-[hovered=true]:bg-default/50 data-[hovered=true]:opacity-100 data-[pressed=true]:scale-100"
                            onPress={() => {
                              setReplyAttach((prev) =>
                                prev.filter((x) => x.path !== a.path),
                              );
                              setPreview((p) =>
                                p?.path === a.path ? null : p,
                              );
                            }}
                          >
                            <X size={10} />
                          </Button>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {preview &&
                  replyAttach.some((a) => a.path === preview.path) ? (
                    <AttachPreview
                      item={preview as Attachment}
                      onClose={() => setPreview(null)}
                    />
                  ) : null}

                  <div className="agent-composer">
                    <TextField
                      fullWidth
                      aria-label={canContinue ? "继续对话" : "开新任务"}
                      value={reply}
                      onChange={setReply}
                      isDisabled={sending}
                      className="agent-composer-field"
                    >
                      <TextArea
                        rows={2}
                        placeholder={
                          canContinue ? "继续对话…" : "开新任务…"
                        }
                        className="agent-composer-input"
                        onKeyDown={(e) => {
                          if (
                            e.nativeEvent.isComposing ||
                            e.keyCode === 229
                          ) {
                            return;
                          }
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            void sendContinue();
                          }
                          if (e.key === "@" && !replyAttach.length) {
                            setAddMenu(true);
                          }
                          if (e.key === "Escape") setAddMenu(false);
                        }}
                      />
                    </TextField>
                    <div className="agent-composer-bar">
                      <Dropdown
                        isOpen={addMenu}
                        onOpenChange={setAddMenu}
                      >
                        <Button
                          isIconOnly
                          variant="ghost"
                          aria-label="添加"
                          className={cn(
                            "agent-composer-icon h-7 w-7 min-h-7 min-w-7 p-0",
                            addMenu && "is-open",
                          )}
                          isDisabled={sending}
                        >
                          <Plus size={15} strokeWidth={2.25} />
                        </Button>
                        <Dropdown.Popover
                          placement="top start"
                          className="min-w-[220px]"
                        >
                          <Dropdown.Menu
                            aria-label="添加附件"
                            onAction={(key) => {
                              if (key === "files") void addReplyAttach(false);
                              if (key === "dirs") void addReplyAttach(true);
                            }}
                          >
                            <Dropdown.Item
                              id="files"
                              textValue="文件和文件夹"
                            >
                              <Paperclip size={14} className="opacity-60" />
                              <Label>文件和文件夹</Label>
                            </Dropdown.Item>
                            <Dropdown.Item id="dirs" textValue="仅文件夹">
                              <FolderOpen size={14} className="opacity-60" />
                              <Label>仅文件夹</Label>
                            </Dropdown.Item>
                          </Dropdown.Menu>
                        </Dropdown.Popover>
                      </Dropdown>

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
                            {() => (
                              <span className="inline-flex items-center gap-1">
                                <span className="capitalize opacity-70">
                                  {job.agent}
                                </span>
                                <span>·</span>
                                <span>{modelLabel}</span>
                              </span>
                            )}
                          </Select.Value>
                          <ChevronDown
                            size={12}
                            className="shrink-0 opacity-50"
                          />
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

                      <Button
                        isIconOnly
                        variant="primary"
                        aria-label="发送 Enter"
                        className="agent-composer-send h-7 w-7 min-h-7 min-w-7 p-0"
                        isDisabled={!canSend}
                        onPress={() => void sendContinue()}
                      >
                        <Send size={13} strokeWidth={2.4} />
                      </Button>
                    </div>
                  </div>
                </div>
              ) : active ? (
                <p className="type-meta text-accent">运行中，完成后可续聊</p>
              ) : (
                <p className="type-meta">
                  无 session id，无法续聊（需 Claude 新任务或 Codex 回报会话）
                </p>
              )}
            </div>
          </section>
        </div>

        {sideOpen ? (
          <aside className="flex w-full shrink-0 flex-col gap-2 overflow-auto border-t border-border pt-3 lg:w-72 lg:border-t-0 lg:border-l lg:pl-3 lg:pt-0">
            <div className="rounded-xl border border-border bg-surface px-3 py-2.5">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium">文件</span>
                <Button
                  isIconOnly
                  size="sm"
                  variant="ghost"
                  className="rounded p-1 text-muted lg:hidden"
                  aria-label="收起侧栏"
                  onPress={toggleSide}
                >
                  <PanelRightClose size={14} />
                </Button>
              </div>
              {paths.length === 0 ? (
                <p className="type-meta">附件与结果路径会出现在这里</p>
              ) : (
                <ul className="flex max-h-64 flex-col gap-1 overflow-auto">
                  {paths.map((p) => {
                    const name = p.split("/").filter(Boolean).pop() || p;
                    const pending = replyAttach.some((a) => a.path === p);
                    return (
                      <li key={p}>
                        <Button
                          variant="ghost"
                          aria-label={p}
                          isDisabled={previewBusy}
                          className={cn(
                            "h-auto min-h-0 w-full justify-start gap-2 rounded-lg px-2 py-1.5 text-left text-xs font-normal shadow-none hover:bg-default/50 data-[hovered=true]:bg-default/50 data-[pressed=true]:scale-100",
                            preview?.path === p && "bg-default/40",
                          )}
                          onPress={() => {
                            const local = replyAttach.find((a) => a.path === p);
                            if (local) setPreview(local);
                            else void openPreview(p);
                          }}
                        >
                          {pending ? (
                            <Paperclip
                              size={12}
                              className="shrink-0 opacity-60"
                            />
                          ) : (
                            <FileText
                              size={12}
                              className="shrink-0 opacity-60"
                            />
                          )}
                          <span className="min-w-0 truncate">{name}</span>
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {preview && !replyAttach.some((a) => a.path === preview.path) ? (
              <AttachPreview item={preview} onClose={() => setPreview(null)} />
            ) : null}
          </aside>
        ) : null}
      </div>
    </PageShell>
  );
}
