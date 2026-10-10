import { Button, Dropdown, Header, Separator } from "@heroui/react";
import { Clipboard, Download } from "lucide-react";
import type { HistoryEntry } from "@/types";
import {
  exportHistoryEntry,
  historyEntryClipboard,
  type ExportFormat,
} from "@/lib/export-transcript";
import { useT } from "@/lib/i18n";
import { toast } from "@/lib/toast";

type Props = {
  entry: HistoryEntry;
  /** Prefer primary CTA look for the result modal. */
  variant?: "export" | "copy-export";
  className?: string;
};

const sectionHeaderCls =
  "px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted";

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

  const run = async (format: ExportFormat, mode: "copy" | "file") => {
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

  const onAction = (key: string | number) => {
    const [mode, format] = String(key).split(":");
    void run(format as ExportFormat, mode as "copy" | "file");
  };

  return (
    <Dropdown>
      <Button size="sm" variant="secondary" className={className}>
        <TriggerIcon size={14} aria-hidden />
        {triggerLabel}
      </Button>
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu aria-label={triggerLabel} onAction={onAction}>
          <Dropdown.Section>
            <Header className={sectionHeaderCls}>
              {t("transcribe.exportCopy")}
            </Header>
            <Dropdown.Item id="copy:txt" textValue={t("transcribe.copyTxt")}>
              {t("transcribe.copyTxt")}
            </Dropdown.Item>
            <Dropdown.Item id="copy:srt" textValue={t("transcribe.copySrt")}>
              {t("transcribe.copySrt")}
            </Dropdown.Item>
            <Dropdown.Item id="copy:raw" textValue={t("transcribe.copyRaw")}>
              {t("transcribe.copyRaw")}
            </Dropdown.Item>
          </Dropdown.Section>
          <Separator />
          <Dropdown.Section>
            <Header className={sectionHeaderCls}>
              {t("transcribe.exportFile")}
            </Header>
            <Dropdown.Item id="file:txt" textValue={t("history.exportTxt")}>
              {t("history.exportTxt")}
            </Dropdown.Item>
            <Dropdown.Item id="file:srt" textValue={t("transcribe.exportSrt")}>
              {t("transcribe.exportSrt")}
            </Dropdown.Item>
            <Dropdown.Item id="file:raw" textValue={t("transcribe.exportRaw")}>
              {t("transcribe.exportRaw")}
            </Dropdown.Item>
            <Dropdown.Item id="file:md" textValue={t("history.exportMd")}>
              {t("history.exportMd")}
            </Dropdown.Item>
          </Dropdown.Section>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
