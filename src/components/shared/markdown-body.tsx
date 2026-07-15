import { Streamdown } from "streamdown";
import "streamdown/styles.css";
import { cn } from "@/lib/cn";

/**
 * LLM / agent markdown — Streamdown (Vercel):
 * streaming-safe incomplete MD, GFM tables, hardened rehype.
 * Best fit for agent chat among react-markdown / StreamMD / StreamMDX.
 */
export function MarkdownBody({
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
}
