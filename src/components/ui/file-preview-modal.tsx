import { useEffect } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { Button, toast } from "@heroui/react";
import { AnimatePresence, motion } from "framer-motion";
import { ExternalLink, X } from "lucide-react";
import { AttachMediaBody } from "@/components/ui/attach-media-body";
import { MarkdownBody } from "@/components/shared/markdown-body";
import { toolResultToMarkdown } from "@/lib/agent-tool-md";
import { duration, easeOut } from "@/lib/motion";
import { useT } from "@/lib/i18n";
import type { AgentPathInfo } from "@/types";

function kindLabelKey(kind: string): string {
  switch (kind) {
    case "image":
      return "common.fileKind.image";
    case "video":
      return "common.fileKind.video";
    case "audio":
      return "common.fileKind.audio";
    case "pdf":
      return "common.fileKind.pdf";
    case "html":
      return "common.fileKind.html";
    case "text":
      return "common.fileKind.text";
    case "dir":
      return "common.fileKind.dir";
    default:
      return "common.fileKind.file";
  }
}

function formatSize(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function openPathInSystem(path: string) {
  return invoke("open_path_in_system", { path }).catch((e) => {
    toast.warning(e instanceof Error ? e.message : String(e));
  });
}

/** In-app preview kinds — others go straight to Finder / default app. */
export function isInAppPreviewable(info: Pick<AgentPathInfo, "kind" | "previewable">): boolean {
  if (info.previewable) return true;
  return (
    info.kind === "image" ||
    info.kind === "video" ||
    info.kind === "audio" ||
    info.kind === "pdf" ||
    info.kind === "html" ||
    info.kind === "text" ||
    info.kind === "dir"
  );
}

type Props = {
  item: AgentPathInfo | null;
  onClose: () => void;
};

/**
 * Full-screen file preview — image / video / audio / pdf / html / text / dir.
 * Asset protocol via AttachMediaBody; always offers 「用系统打开」.
 */
export function FilePreviewModal({ item, onClose }: Props) {
  const t = useT();
  const open = Boolean(item);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  return createPortal(
    <AnimatePresence>
      {item ? (
        <motion.div
          key="file-preview-backdrop"
          className="trm-backdrop fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: duration.normal, ease: easeOut }}
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
        >
          <motion.div
            key="file-preview-panel"
            role="dialog"
            aria-modal="true"
            aria-label={item.name}
            className="agent-file-preview-panel flex h-[min(85vh,44rem)] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl"
            initial={{ opacity: 0, scale: 0.95, y: 24 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 16 }}
            transition={{ type: "spring", bounce: 0.2, duration: 0.3 }}
          >
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{item.name}</div>
                <div className="type-meta mt-0.5 flex flex-wrap items-center gap-2 font-mono">
                  <span>{t(kindLabelKey(item.kind))}</span>
                  {item.kind !== "dir" && item.size > 0 ? (
                    <span>{formatSize(item.size)}</span>
                  ) : null}
                  <span className="truncate" title={item.path}>
                    {item.path.replace(/^\/Users\/[^/]+/, "~")}
                  </span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label={t("common.openInSystem")}
                  onPress={() => void openPathInSystem(item.path)}
                >
                  <ExternalLink size={14} aria-hidden />
                  {t("common.openInSystemShort")}
                </Button>
                <Button
                  isIconOnly
                  size="sm"
                  variant="ghost"
                  aria-label={t("common.close")}
                  onPress={onClose}
                >
                  <X size={16} aria-hidden />
                </Button>
              </div>
            </div>
            <div className="agent-file-preview-body min-h-0 flex-1 overflow-auto p-4">
              <AttachMediaBody
                item={item}
                density="full"
                renderText={(preview, name) => (
                  <div className="agent-file-preview-text max-h-full w-full overflow-auto text-left">
                    <MarkdownBody
                      text={
                        /\.(md|markdown|mdx)$/i.test(name)
                          ? preview
                          : toolResultToMarkdown(preview)
                      }
                    />
                  </div>
                )}
              />
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
