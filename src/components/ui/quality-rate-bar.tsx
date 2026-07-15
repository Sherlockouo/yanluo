import { Button } from "@heroui/react";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { cn } from "@/lib/cn";

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
  label: string;
  tone?: "bad" | "good";
  icon?: "down" | "up";
}[] = [
  { value: "bad", label: "差", tone: "bad", icon: "down" },
  { value: "ok", label: "一般" },
  { value: "good", label: "好", tone: "good", icon: "up" },
];

export function QualityRateBar({
  rating,
  onRate,
  compact,
  className,
  label = "识别效果",
}: Props) {
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
      {label ? <span className="type-micro tracking-[0.06em]!">{label}</span> : null}
      <div className="rate-segment" role="group" aria-label={label || "评分"}>
        {OPTIONS.map((opt) => {
          const active = rating === opt.value;
          return (
            <Button
              key={opt.value}
              variant="ghost"
              className="rate-segment-btn h-auto min-h-0 shadow-none data-[pressed=true]:scale-100"
              data-active={active ? "true" : "false"}
              data-tone={opt.tone}
              aria-pressed={active}
              onPress={() => toggle(opt.value)}
            >
              {opt.icon === "down" ? <ThumbsDown size={11} aria-hidden /> : null}
              {opt.icon === "up" ? <ThumbsUp size={11} aria-hidden /> : null}
              {opt.label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
