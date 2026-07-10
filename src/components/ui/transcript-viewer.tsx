/**
 * Transcript + media playback.
 * Jobs-like reading: one thought at a time, breathing room, auto-follow.
 * Alignment uses ElevenLabs CharacterAlignmentResponseModel shape.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Button } from "@heroui/react";
import { Focus, List, Pause, Play } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  composeSegmentsFromAlignment,
  formatClock,
  groupWordsIntoParagraphs,
  resolveAlignment,
  splitPlainTextParagraphs,
  type TranscriptParagraph,
  type TranscriptWord,
} from "@/lib/alignment";
import type { CharacterAlignment, TranscriptSegment } from "@/types";

type WordStatus = "spoken" | "unspoken" | "current";
type ViewMode = "focus" | "read";

export function TranscriptViewer({
  text,
  mediaSrc,
  mediaKind = "audio",
  durationSeconds,
  segments,
  alignment,
  className,
  emptyLabel = "暂无转写文本",
}: {
  text: string;
  audioSrc?: string | null;
  mediaSrc?: string | null;
  mediaKind?: "audio" | "video" | string;
  durationSeconds: number;
  segments?: TranscriptSegment[] | null;
  alignment?: CharacterAlignment | null;
  className?: string;
  emptyLabel?: string;
}) {
  const src = mediaSrc ?? null;
  const isVideo = mediaKind === "video";
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const activeParaRef = useRef<HTMLElement | null>(null);
  const userScrollUntil = useRef(0);

  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(Math.max(durationSeconds, 0));
  const [isPlaying, setIsPlaying] = useState(false);
  const [isScrubbing, setIsScrubbing] = useState(false);

  const resolvedAlignment = useMemo(
    () => resolveAlignment({ alignment, segments }),
    [alignment, segments],
  );

  const composed = useMemo(
    () =>
      resolvedAlignment
        ? composeSegmentsFromAlignment(resolvedAlignment)
        : { segments: [], words: [] as TranscriptWord[] },
    [resolvedAlignment],
  );

  const paragraphs = useMemo(
    () => groupWordsIntoParagraphs(composed.words),
    [composed.words],
  );

  const plainParagraphs = useMemo(
    () => (paragraphs.length ? [] : splitPlainTextParagraphs(text)),
    [paragraphs.length, text],
  );

  const isLong =
    paragraphs.length >= 6 ||
    plainParagraphs.length >= 6 ||
    text.length >= 180;

  const [mode, setMode] = useState<ViewMode>("focus");
  useEffect(() => {
    setMode(isLong ? "focus" : "read");
  }, [isLong, src, text]);

  useEffect(() => {
    setCurrentTime(0);
    setIsPlaying(false);
  }, [src, text]);

  useEffect(() => {
    const tick = () => {
      const el = mediaRef.current;
      if (el && !isScrubbing) setCurrentTime(el.currentTime);
      rafRef.current = requestAnimationFrame(tick);
    };
    if (isPlaying) rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [isPlaying, isScrubbing]);

  const seekTo = useCallback(
    (time: number) => {
      const el = mediaRef.current;
      if (!el) return;
      const next = Math.min(Math.max(time, 0), el.duration || duration || 0);
      el.currentTime = next;
      setCurrentTime(next);
    },
    [duration],
  );

  const togglePlay = useCallback(() => {
    const el = mediaRef.current;
    if (!el || !src) return;
    if (el.paused) void el.play().catch(() => undefined);
    else el.pause();
  }, [src]);

  const seekToWord = useCallback(
    (word: TranscriptWord) => {
      seekTo(word.startTime);
      const el = mediaRef.current;
      if (el?.paused) void el.play().catch(() => undefined);
    },
    [seekTo],
  );

  const seekToParagraph = useCallback(
    (para: TranscriptParagraph) => {
      seekTo(para.startTime);
      const el = mediaRef.current;
      if (el?.paused) void el.play().catch(() => undefined);
    },
    [seekTo],
  );

  const { currentWordIndex, currentParaIndex, atEnd } = useMemo(() => {
    const words = composed.words;
    if (!words.length) {
      return { currentWordIndex: -1, currentParaIndex: -1, atEnd: false };
    }
    const end = duration > 0 && currentTime >= duration - 0.05;
    let idx = -1;
    for (let i = 0; i < words.length; i++) {
      if (currentTime + 1e-3 >= words[i].startTime) idx = i;
      else break;
    }
    if (end) idx = words.length - 1;

    let paraIdx = -1;
    if (idx >= 0) {
      for (let p = 0; p < paragraphs.length; p++) {
        const first = paragraphs[p].words[0]?.wordIndex ?? -1;
        const last =
          paragraphs[p].words[paragraphs[p].words.length - 1]?.wordIndex ?? -1;
        if (idx >= first && idx <= last) {
          paraIdx = p;
          break;
        }
      }
    }
    return {
      currentWordIndex: idx,
      currentParaIndex: paraIdx,
      atEnd: end,
    };
  }, [composed.words, currentTime, duration, paragraphs]);

  const statusForWord = useCallback(
    (word: TranscriptWord): WordStatus => {
      if (atEnd) return "spoken";
      if (currentWordIndex < 0) return "unspoken";
      if (word.wordIndex < currentWordIndex) return "spoken";
      if (word.wordIndex === currentWordIndex) return "current";
      return "unspoken";
    },
    [atEnd, currentWordIndex],
  );

  // Auto-follow current paragraph unless the user recently scrolled.
  useEffect(() => {
    if (mode !== "focus" && !isPlaying) return;
    if (Date.now() < userScrollUntil.current) return;
    const node = activeParaRef.current;
    const scroller = scrollRef.current;
    if (!node || !scroller) return;
    const nodeTop = node.offsetTop;
    const target = Math.max(0, nodeTop - scroller.clientHeight * 0.28);
    scroller.scrollTo({ top: target, behavior: "smooth" });
  }, [currentParaIndex, mode, isPlaying]);

  const onUserScroll = () => {
    userScrollUntil.current = Date.now() + 2800;
  };

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
  const hasTimed = paragraphs.length > 0;

  const mediaHandlers = {
    onPlay: () => setIsPlaying(true),
    onPause: () => setIsPlaying(false),
    onEnded: () => {
      setIsPlaying(false);
      setCurrentTime(duration);
    },
    onLoadedMetadata: (e: React.SyntheticEvent<HTMLMediaElement>) => {
      const d = e.currentTarget.duration;
      if (Number.isFinite(d) && d > 0) setDuration(d);
    },
    onDurationChange: (e: React.SyntheticEvent<HTMLMediaElement>) => {
      const d = e.currentTarget.duration;
      if (Number.isFinite(d) && d > 0) setDuration(d);
    },
  };

  return (
    <div
      className={cn(
        "flex flex-col gap-4 rounded-2xl border border-border bg-surface-secondary/40 p-4",
        className,
      )}
    >
      {src && isVideo ? (
        <video
          ref={(el) => {
            mediaRef.current = el;
          }}
          src={src}
          preload="metadata"
          playsInline
          className="max-h-64 w-full rounded-xl bg-black object-contain sm:max-h-72"
          {...mediaHandlers}
        />
      ) : src ? (
        <audio
          ref={(el) => {
            mediaRef.current = el;
          }}
          src={src}
          preload="metadata"
          className="sr-only"
          {...mediaHandlers}
        />
      ) : null}

      {(hasTimed || plainParagraphs.length > 0) && isLong ? (
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] text-muted">
            {mode === "focus"
              ? "专注模式 · 跟随当前一句"
              : "全文模式 · 可滚动阅读"}
          </p>
          <div className="flex overflow-hidden rounded-full border border-border bg-surface">
            <button
              type="button"
              className={cn(
                "inline-flex items-center gap-1 px-2.5 py-1 text-[11px] transition",
                mode === "focus"
                  ? "bg-accent/15 font-medium text-accent"
                  : "text-muted hover:text-foreground",
              )}
              onClick={() => setMode("focus")}
            >
              <Focus size={12} aria-hidden />
              专注
            </button>
            <button
              type="button"
              className={cn(
                "inline-flex items-center gap-1 px-2.5 py-1 text-[11px] transition",
                mode === "read"
                  ? "bg-accent/15 font-medium text-accent"
                  : "text-muted hover:text-foreground",
              )}
              onClick={() => setMode("read")}
            >
              <List size={12} aria-hidden />
              全文
            </button>
          </div>
        </div>
      ) : null}

      <div
        ref={scrollRef}
        onScroll={onUserScroll}
        className={cn(
          "transcript-scroll relative overflow-y-auto overscroll-contain",
          isLong ? "max-h-[min(52vh,420px)]" : "max-h-[min(60vh,520px)]",
          mode === "focus" && "px-1",
        )}
      >
        {hasTimed ? (
          <div
            className={cn(
              "mx-auto flex flex-col max-w-[40rem] ",
              mode === "focus" ? "gap-5 py-6" : "gap-4 py-2",
            )}
          >
            {paragraphs.map((para, pi) => {
              const isActive = pi === currentParaIndex;
              const isPast =
                currentParaIndex >= 0 && pi < currentParaIndex;
              const isFuture =
                currentParaIndex >= 0 && pi > currentParaIndex;
              const dim =
                mode === "focus" &&
                currentParaIndex >= 0 &&
                !isActive &&
                (isPlaying || currentTime > 0);

              return (
                <section
                  key={para.id}
                  ref={isActive ? (el) => {
                    activeParaRef.current = el;
                  } : undefined}
                  data-active={isActive || undefined}
                  className={cn(
                    "group relative rounded-2xl transition-all duration-300",
                    mode === "focus" && isActive && "bg-accent/[0.06] px-4 py-3",
                    mode === "read" && "px-1",
                    dim && isPast && "opacity-[0.34]",
                    dim && isFuture && "opacity-[0.22]",
                  )}
                >
                  <button
                    type="button"
                    className="mb-1.5 block text-[10px] tabular-nums tracking-wide text-muted/80 transition hover:text-accent"
                    onClick={() => seekToParagraph(para)}
                  >
                    {formatClock(para.startTime)}
                  </button>
                  <p
                    className={cn(
                      "text-pretty break-words transition-all duration-300",
                      mode === "focus" && isActive
                        ? "text-[17px] leading-[1.85] sm:text-[18px]"
                        : "text-[15px] leading-[1.75] sm:text-base",
                      mode === "focus" && isActive
                        ? "text-foreground"
                        : dim
                          ? "text-foreground"
                          : "text-foreground",
                    )}
                  >
                    {para.words.map((word) => {
                      const status = statusForWord(word);
                      return (
                        <button
                          key={`w-${word.segmentIndex}`}
                          type="button"
                          data-status={status}
                          title={`${formatClock(word.startTime)}`}
                          className={cn(
                            "inline rounded-[3px] px-[0.5px] transition-colors duration-100",
                            status === "spoken" && "text-muted",
                            status === "current" &&
                              "bg-accent/30 font-semibold text-accent",
                            status === "unspoken" && "text-inherit",
                          )}
                          onClick={() => seekToWord(word)}
                        >
                          {word.text}
                        </button>
                      );
                    })}
                  </p>
                </section>
              );
            })}
          </div>
        ) : plainParagraphs.length > 0 ? (
          <div className="mx-auto flex max-w-[36rem] flex-col gap-4 py-3">
            {plainParagraphs.map((para, i) => (
              <p
                key={i}
                className="text-pretty text-[15px] leading-[1.8] text-foreground sm:text-base"
              >
                {para}
              </p>
            ))}
          </div>
        ) : (
          <p className="py-6 text-center text-sm text-muted">{emptyLabel}</p>
        )}
      </div>

      {src ? (
        <div className="flex flex-col gap-2 border-t border-border/60 pt-3">
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              variant="secondary"
              isIconOnly
              aria-label={isPlaying ? "暂停" : "播放"}
              onPress={togglePlay}
            >
              {isPlaying ? <Pause size={16} /> : <Play size={16} />}
            </Button>
            <ScrubTrack
              progress={progress}
              duration={duration}
              onScrubStart={() => setIsScrubbing(true)}
              onScrubEnd={() => setIsScrubbing(false)}
              onScrub={seekTo}
            />
          </div>
          <div className="flex justify-between text-[11px] tabular-nums text-muted">
            <span>{formatClock(currentTime)}</span>
            <span>{formatClock(duration)}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ScrubTrack({
  progress,
  duration,
  onScrub,
  onScrubStart,
  onScrubEnd,
}: {
  progress: number;
  duration: number;
  onScrub: (time: number) => void;
  onScrubStart: () => void;
  onScrubEnd: () => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);

  const timeFromX = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track || !duration) return null;
      const rect = track.getBoundingClientRect();
      const ratio = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
      return duration * ratio;
    },
    [duration],
  );

  const onPointerDown = (event: ReactPointerEvent) => {
    if (!duration) return;
    event.preventDefault();
    onScrubStart();
    const t = timeFromX(event.clientX);
    if (t != null) onScrub(t);

    const onMove = (e: PointerEvent) => {
      const next = timeFromX(e.clientX);
      if (next != null) onScrub(next);
    };
    const onUp = () => {
      onScrubEnd();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  };

  return (
    <div
      ref={trackRef}
      role="slider"
      aria-valuemin={0}
      aria-valuemax={duration || 0}
      aria-valuenow={duration ? (progress / 100) * duration : 0}
      tabIndex={0}
      className="relative h-2 w-full grow cursor-pointer touch-none rounded-full bg-default"
      onPointerDown={onPointerDown}
    >
      <div
        className="absolute inset-y-0 left-0 rounded-full bg-accent"
        style={{ width: `${Math.min(Math.max(progress, 0), 100)}%` }}
      />
      <div
        className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent-foreground ring-2 ring-accent"
        style={{ left: `${Math.min(Math.max(progress, 0), 100)}%` }}
      />
    </div>
  );
}
