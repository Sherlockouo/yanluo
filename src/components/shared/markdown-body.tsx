import { memo, useCallback, type AnchorHTMLAttributes } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";
import { cn } from "@/lib/cn";
import { linkifyBareUrls } from "@/lib/extract-paths";

function MdLink({
  href,
  children,
  className,
  node: _node,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) {
  const onClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (!href) return;
      if (href.startsWith("#") || href.startsWith("/")) return;
      e.preventDefault();
      void open(href).catch(() => {
        window.open(href, "_blank", "noopener,noreferrer");
      });
    },
    [href],
  );

  return (
    <a
      {...rest}
      href={href}
      className={cn("agent-md-link", className)}
      onClick={onClick}
      rel="noopener noreferrer"
    >
      {children}
    </a>
  );
}

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
  const linked = linkifyBareUrls(t);
  return (
    <div
      className={cn(
        "agent-md text-sm leading-relaxed text-foreground/90",
        className,
      )}
    >
      <Streamdown
        isAnimating={streaming}
        // Streamdown Components index is loose; cast keeps `a` override typed.
        components={{ a: MdLink } as never}
        linkSafety={{ enabled: false }}
      >
        {linked}
      </Streamdown>
    </div>
  );
}, (prev, next) => prev.text === next.text && prev.streaming === next.streaming && prev.className === next.className);
