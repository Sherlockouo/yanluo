import { memo, useCallback, useMemo, type AnchorHTMLAttributes } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";
import { cn } from "@/lib/cn";
import { SEEK_HASH } from "@/lib/timestamps";
import { linkifyBareUrls } from "@/lib/extract-paths";

function MdLink({
  href,
  children,
  className,
  node: _node,
  onSeek,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & {
  node?: unknown;
  onSeek?: ((seconds: number) => void) | null;
}) {
  const onClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (!href) return;
      if (href.startsWith(SEEK_HASH)) {
        e.preventDefault();
        const seconds = Number(href.slice(SEEK_HASH.length));
        if (onSeek && Number.isFinite(seconds)) onSeek(seconds);
        return;
      }
      if (href.startsWith("#") || href.startsWith("/")) return;
      e.preventDefault();
      void open(href).catch(() => {
        window.open(href, "_blank", "noopener,noreferrer");
      });
    },
    [href, onSeek],
  );

  return (
    <a
      {...rest}
      href={href}
      className={cn(
        "agent-md-link",
        href?.startsWith(SEEK_HASH) && "tabular-nums",
        className,
      )}
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
  onSeek,
}: {
  text: string;
  className?: string;
  streaming?: boolean;
  /** Called with seconds when a `[mm:ss]` anchor is clicked. */
  onSeek?: ((seconds: number) => void) | null;
}) {
  const t = text.trim();
  // Streamdown's Components index is loose; the cast keeps the `a` override typed.
  const components = useMemo(
    () =>
      ({
        a: (props: AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) => (
          <MdLink {...props} onSeek={onSeek} />
        ),
      }) as never,
    [onSeek],
  );
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
        components={components}
        linkSafety={{ enabled: false }}
      >
        {linked}
      </Streamdown>
    </div>
  );
}, (prev, next) =>
  prev.text === next.text &&
  prev.streaming === next.streaming &&
  prev.className === next.className &&
  prev.onSeek === next.onSeek);

