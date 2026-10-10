import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button, Modal, toast } from "@heroui/react";
import { ExternalLink } from "lucide-react";
import { AttachMediaBody } from "@/components/ui/attach-media-body";
import { MarkdownBody } from "@/components/shared/markdown-body";
import { toolResultToMarkdown } from "@/lib/agent-tool-md";
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
 * HeroUI Modal (native enter/exit, Esc/backdrop close, scroll lock).
 * Asset protocol via AttachMediaBody; always offers 「用系统打开」.
 */
export function FilePreviewModal({ item, onClose }: Props) {
  const t = useT();
  // Retain the last item so the exit animation keeps its content.
  const [lastItem, setLastItem] = useState<AgentPathInfo | null>(null);
  if (item && item !== lastItem) setLastItem(item);
  const shown = item ?? lastItem;

  return (
    <Modal
      isOpen={Boolean(item)}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <Modal.Backdrop>
        <Modal.Container placement="center">
          <Modal.Dialog
            aria-label={shown?.name}
            className="agent-file-preview-panel h-[min(85vh,44rem)] w-[min(56rem,calc(100vw-2rem))] gap-0 overflow-hidden p-0 sm:w-[min(56rem,calc(100vw-5rem))]"
          >
            {shown ? (
              <>
                <Modal.Header className="shrink-0 flex-row items-center justify-between gap-3 border-b border-border px-5 py-3">
                  <div className="min-w-0">
                    <Modal.Heading className="truncate text-sm font-medium">
                      {shown.name}
                    </Modal.Heading>
                    <div className="type-meta mt-0.5 flex flex-wrap items-center gap-2 font-mono">
                      <span>{t(kindLabelKey(shown.kind))}</span>
                      {shown.kind !== "dir" && shown.size > 0 ? (
                        <span>{formatSize(shown.size)}</span>
                      ) : null}
                      <span className="truncate" title={shown.path}>
                        {shown.path.replace(/^\/Users\/[^/]+/, "~")}
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="secondary"
                      aria-label={t("common.openInSystem")}
                      onPress={() => void openPathInSystem(shown.path)}
                    >
                      <ExternalLink size={14} aria-hidden />
                      {t("common.openInSystemShort")}
                    </Button>
                    <Modal.CloseTrigger
                      aria-label={t("common.close")}
                      className="static shrink-0"
                    />
                  </div>
                </Modal.Header>
                <Modal.Body className="agent-file-preview-body m-0 min-h-0 flex-1 overflow-auto p-4 text-foreground">
                  <AttachMediaBody
                    item={shown}
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
                </Modal.Body>
              </>
            ) : null}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
