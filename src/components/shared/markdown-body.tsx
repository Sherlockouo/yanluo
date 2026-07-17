import { memo } from "react";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";
import { cn } from "@/lib/cn";

export const MarkdownBody = memo(function MarkdownBody({
  text,
  className,
  streaming = false,
}: {
  text: string;
  className?: string;
  streaming?: boolean;
}) {
  const t = text.trim();
  if (!t) return null;
  return (
    <div
      className={cn(
        "agent-md text-sm leading-relaxed text-foreground/90",
        className,
      )}
    >
      <Streamdown isAnimating={streaming}>{t}</Streamdown>
    </div>
  );
}, (prev, next) => prev.text === next.text && prev.streaming === next.streaming && prev.className === next.className);
