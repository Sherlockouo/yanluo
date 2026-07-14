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
        "flex flex-wrap items-center gap-1.5",
        compact ? "pt-1.5" : "border-t border-border/60 pt-2",
        className,
      )}
    >
      {label ? (
        <span className="mr-1 text-[10px] text-muted">{label}</span>
      ) : null}
      <Button
        size="sm"
        variant={rating === "bad" ? "primary" : "secondary"}
        onPress={() => toggle("bad")}
      >
        <ThumbsDown size={12} />
        差
      </Button>
      <Button
        size="sm"
        variant={rating === "ok" ? "primary" : "secondary"}
        onPress={() => toggle("ok")}
      >
        一般
      </Button>
      <Button
        size="sm"
        variant={rating === "good" ? "primary" : "secondary"}
        onPress={() => toggle("good")}
      >
        <ThumbsUp size={12} />
        好
      </Button>
    </div>
  );
}
