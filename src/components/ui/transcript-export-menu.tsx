import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Button } from "@heroui/react";
import { Clipboard, Download } from "lucide-react";
import type { HistoryEntry } from "@/types";
import {
  exportHistoryEntry,
  historyEntryClipboard,
  type ExportFormat,
} from "@/lib/export-transcript";
import { springUI } from "@/lib/motion";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";

type Props = {
  entry: HistoryEntry;
  /** Prefer primary CTA look for the result modal. */
  variant?: "export" | "copy-export";
  className?: string;
};

function MenuItem({
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-center px-3 py-2 text-left text-[13px] text-foreground transition-colors hover:bg-surface-secondary"
      onClick={onPress}
    >
      {label}
    </button>
  );
}

/**
 * Copy / export menu: TXT · SRT · Raw (+ optional MD).
 * `raw_text` is always on the history entry — Raw exports that.
 */
export function TranscriptExportMenu({
  entry,
  variant = "export",
  className,
}: Props) {
  const t = useT();
  const reducedMotion = useReducedMotion();
  const [open, setOpen] = useState(false);

  const run = async (format: ExportFormat, mode: "copy" | "file") => {
    setOpen(false);
    if (mode === "copy") {
      const body = historyEntryClipboard(entry, format);
      try {
        await navigator.clipboard.writeText(body);
        toast.success(t("transcribe.copied"));
      } catch {
        toast.danger(t("transcribe.copyFailed"));
      }
      return;
    }
    exportHistoryEntry(entry, format);
    toast.success(t("transcribe.exported"));
  };

  const triggerLabel =
    variant === "copy-export" ? t("transcribe.copyExport") : t("history.export");
  const TriggerIcon = variant === "copy-export" ? Clipboard : Download;

  return (
    <div className={className ? `relative ${className}` : "relative"}>
      <Button
        size="sm"
        variant="secondary"
        onPress={() => setOpen((v) => !v)}
      >
        <TriggerIcon size={14} aria-hidden />
        {triggerLabel}
      </Button>
      <AnimatePresence>
        {open ? (
          <>
            <div
              role="presentation"
              className="fixed inset-0 z-40 cursor-default"
              onClick={() => setOpen(false)}
            />
            <motion.div
              initial={
                reducedMotion ? { opacity: 1 } : { opacity: 0, scale: 0.96, y: 4 }
              }
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={
                reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 4 }
              }
              transition={springUI}
              style={{ transformOrigin: "top right" }}
              className="absolute right-0 z-50 mt-2 w-52 overflow-hidden rounded-2xl border border-border bg-surface py-1 shadow-lg"
            >
              <div className="px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
                {t("transcribe.exportCopy")}
              </div>
              <MenuItem
                label={t("transcribe.copyTxt")}
                onPress={() => void run("txt", "copy")}
              />
              <MenuItem
                label={t("transcribe.copySrt")}
                onPress={() => void run("srt", "copy")}
              />
              <MenuItem
                label={t("transcribe.copyRaw")}
                onPress={() => void run("raw", "copy")}
              />
              <div className="my-1 border-t border-border" />
              <div className="px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
                {t("transcribe.exportFile")}
              </div>
              <MenuItem
                label={t("history.exportTxt")}
                onPress={() => void run("txt", "file")}
              />
              <MenuItem
                label={t("transcribe.exportSrt")}
                onPress={() => void run("srt", "file")}
              />
              <MenuItem
                label={t("transcribe.exportRaw")}
                onPress={() => void run("raw", "file")}
              />
              <MenuItem
                label={t("history.exportMd")}
                onPress={() => void run("md", "file")}
              />
            </motion.div>
          </>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
