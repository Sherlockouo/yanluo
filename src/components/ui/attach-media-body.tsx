import { useEffect, useState, type ReactNode } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { Button } from "@heroui/react";
import {
  FileAudio,
  FileText,
  FileVideo,
  FolderOpen,
  Image as ImageIcon,
} from "lucide-react";

export type AttachMediaItem = {
  path: string;
  name: string;
  kind: string;
  preview?: string;
};

function resolveKind(item: AttachMediaItem): string {
  if (
    item.kind === "pdf" ||
    item.kind === "html" ||
    item.kind === "video" ||
    item.kind === "audio" ||
    item.kind === "image" ||
    item.kind === "dir" ||
    item.kind === "text"
  ) {
    return item.kind;
  }
  const name = (item.name || item.path).toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  if (ext === "pdf") return "pdf";
  if (ext === "html" || ext === "htm" || ext === "xhtml") return "html";
  if (
    ["mp4", "webm", "mov", "m4v", "mkv", "avi", "ogv"].includes(ext)
  ) {
    return "video";
  }
  if (
    ["mp3", "wav", "m4a", "aac", "ogg", "flac", "opus", "aiff", "aif"].includes(
      ext,
    )
  ) {
    return "audio";
  }
  if (
    ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "heic"].includes(ext)
  ) {
    return "image";
  }
  return item.kind || "file";
}

type Props = {
  item: AttachMediaItem;
  /** Compact = agent job card; full = floating preview window. */
  density?: "compact" | "full";
  /** Optional text renderer (e.g. markdown in job page). */
  renderText?: (preview: string, name: string) => ReactNode;
};

/**
 * Renders image / pdf / html / video / audio / text / dir fallback.
 * Uses asset protocol — never load remote URLs here.
 */
export function AttachMediaBody({
  item,
  density = "full",
  renderText,
}: Props) {
  const [broken, setBroken] = useState(false);
  const src = convertFileSrc(item.path);
  const compact = density === "compact";
  const kind = resolveKind(item);

  useEffect(() => {
    setBroken(false);
  }, [item.path]);

  const openInSystem = () => {
    void invoke("open_path_in_system", { path: item.path }).catch(() => {});
  };

  const isDir = kind === "dir";
  const isImage = kind === "image";
  const isPdf = kind === "pdf";
  const isHtml = kind === "html";
  const isVideo = kind === "video";
  const isAudio = kind === "audio";
  const hasText = Boolean(item.preview) && !isImage && !isPdf && !isHtml && !isVideo && !isAudio;

  const mediaClass = compact
    ? "max-h-40 w-full rounded object-contain"
    : "mx-auto max-h-full max-w-full rounded object-contain";
  const frameClass = compact
    ? "h-40 w-full rounded border-0 bg-black/5"
    : "h-full min-h-[280px] w-full rounded border-0 bg-black/5";

  if (isImage && !broken) {
    return (
      <img
        src={src}
        alt={item.name}
        className={mediaClass}
        onError={() => setBroken(true)}
        onClick={compact ? openInSystem : undefined}
        role={compact ? "button" : undefined}
      />
    );
  }

  if ((isPdf || isHtml) && !broken) {
    return (
      <iframe
        title={item.name}
        src={src}
        className={frameClass}
        sandbox={isHtml ? "allow-same-origin allow-scripts" : undefined}
        onError={() => setBroken(true)}
      />
    );
  }

  if (isVideo && !broken) {
    return (
      <video
        src={src}
        controls
        className={mediaClass}
        onError={() => setBroken(true)}
      />
    );
  }

  if (isAudio && !broken) {
    return (
      <div
        className={
          compact
            ? "flex w-full flex-col items-center gap-2 py-3"
            : "flex h-full min-h-48 flex-col items-center justify-center gap-4"
        }
      >
        <FileAudio
          size={compact ? 28 : 48}
          strokeWidth={1.4}
          className="opacity-50"
        />
        <audio
          src={src}
          controls
          className="w-full max-w-md"
          onError={() => setBroken(true)}
        />
      </div>
    );
  }

  if (hasText) {
    if (renderText) {
      return <>{renderText(item.preview || "", item.name)}</>;
    }
    return (
      <pre
        className={
          compact
            ? "max-h-40 w-full overflow-auto whitespace-pre-wrap break-words text-[11px] leading-snug opacity-90"
            : "whitespace-pre-wrap break-words text-xs leading-relaxed opacity-90"
        }
      >
        {item.preview}
      </pre>
    );
  }

  const FallbackIcon = isDir
    ? FolderOpen
    : isVideo
      ? FileVideo
      : isAudio
        ? FileAudio
        : isImage
          ? ImageIcon
          : FileText;

  return (
    <Button
      variant="ghost"
      className={
        compact
          ? "flex h-auto min-h-0 w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-0 bg-default/30 px-3 py-5 text-muted shadow-none hover:bg-default/45 data-[hovered=true]:bg-default/45 data-[pressed=true]:scale-100"
          : "flex h-full min-h-48 w-full cursor-pointer flex-col items-center justify-center gap-3 rounded-xl bg-default/30 text-muted hover:bg-default/45"
      }
      aria-label="用系统打开"
      onPress={openInSystem}
    >
      <FallbackIcon size={compact ? 28 : 48} strokeWidth={1.4} />
      <span className={compact ? "text-xs" : "text-sm"}>点击用系统打开</span>
      {!compact ? (
        <span className="max-w-md break-all px-4 text-center text-xs opacity-70">
          {item.path}
        </span>
      ) : null}
    </Button>
  );
}
