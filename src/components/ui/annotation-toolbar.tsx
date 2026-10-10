import { useEffect, useState } from "react";
import { Button } from "@heroui/react";
import { MessageSquarePlus, X } from "lucide-react";
import { HIGHLIGHT_COLORS, HIGHLIGHT_SWATCH } from "@/lib/annotations";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n";
import type { TranscriptSelection } from "@/components/ui/transcript-viewer";

/**
 * Floating bar above a reader selection: pick a highlight colour, or write a
 * comment. Acting on it hands control back to the page (which persists it).
 */
export function AnnotationToolbar({
  selection,
  onHighlight,
  onComment,
  onClose,
}: {
  selection: TranscriptSelection;
  onHighlight: (color: string) => void;
  onComment: (text: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [commenting, setCommenting] = useState(false);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const left = selection.rect.left + selection.rect.width / 2;
  const top = Math.max(8, selection.rect.top - 52);

  return (
    <div
      role="toolbar"
      aria-label={t("annotation.toolbarAria")}
      style={{ top, left, transform: "translateX(-50%)" }}
      className="fixed z-50 flex flex-col gap-2 rounded-2xl border border-border bg-surface p-2 shadow-lg"
    >
      <div className="flex items-center gap-1.5">
        {HIGHLIGHT_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            aria-label={t("annotation.highlightAria", { color: t(`annotation.color.${color}`) })}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onHighlight(color)}
            className="h-6 w-6 rounded-full ring-1 ring-black/10 transition-transform hover:scale-110"
            style={{ backgroundColor: HIGHLIGHT_SWATCH[color] }}
          />
        ))}
        <span className="mx-1 h-5 w-px bg-border" aria-hidden />
        <Button
          size="sm"
          variant="ghost"
          className={cn("btn-press", commenting && "text-accent-soft-foreground")}
          onPress={() => setCommenting((v) => !v)}
        >
          <MessageSquarePlus size={14} aria-hidden />
          {t("annotation.comment")}
        </Button>
        <Button isIconOnly size="sm" variant="ghost" aria-label={t("common.cancel")} onPress={onClose}>
          <X size={14} aria-hidden />
        </Button>
      </div>
      {commenting ? (
        <div className="flex flex-col gap-2">
          <textarea
            autoFocus
            value={draft}
            rows={3}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && draft.trim()) {
                onComment(draft.trim());
              }
            }}
            placeholder={t("annotation.commentPlaceholder")}
            aria-label={t("annotation.commentPlaceholder")}
            className="w-72 resize-none rounded-lg border border-border bg-surface-secondary/40 p-2 text-[13px] leading-relaxed outline-none focus:border-accent"
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="primary"
              isDisabled={!draft.trim()}
              onPress={() => onComment(draft.trim())}
            >
              {t("annotation.save")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
