import { Button } from "@heroui/react";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n";

export type QualityRating = "bad" | "ok" | "good";

type Props = {
  rating: QualityRating | null | undefined;
  onRate: (next: QualityRating | "") => void;
  compact?: boolean;
  className?: string;
  label?: string;
};

const OPTIONS: {
  value: QualityRating;
  labelKey: string;
  tone?: "bad" | "good";
  icon?: "down" | "up";
}[] = [
  { value: "bad", labelKey: "common.rate.bad", tone: "bad", icon: "down" },
  { value: "ok", labelKey: "common.rate.ok" },
  { value: "good", labelKey: "common.rate.good", tone: "good", icon: "up" },
];

export function QualityRateBar({
  rating,
  onRate,
  compact,
  className,
  label,
}: Props) {
  const t = useT();
  const resolvedLabel = label ?? t("common.rate.label");
  const toggle = (value: QualityRating) => {
    onRate(rating === value ? "" : value);
  };

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2",
        compact ? "pt-1.5" : "border-t border-border/50 pt-2.5",
        className,
      )}
    >
      {resolvedLabel ? (
        <span className="type-micro tracking-[0.06em]!">{resolvedLabel}</span>
      ) : null}
      <div
        className="rate-segment"
        role="group"
        aria-label={resolvedLabel || t("common.rate.ariaFallback")}
      >
        {OPTIONS.map((opt) => {
          const active = rating === opt.value;
          return (
            <Button
              key={opt.value}
              variant="ghost"
              size="sm"
              className="rate-segment-btn h-auto min-h-0 shadow-none data-[pressed=true]:scale-100"
              data-active={active ? "true" : "false"}
              data-tone={opt.tone}
              aria-pressed={active}
              onPress={() => toggle(opt.value)}
            >
              {opt.icon === "down" ? <ThumbsDown size={11} aria-hidden /> : null}
              {opt.icon === "up" ? <ThumbsUp size={11} aria-hidden /> : null}
              {t(opt.labelKey)}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
