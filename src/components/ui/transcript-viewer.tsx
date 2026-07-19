/**
 * Transcript + media playback.
 * Jobs-like reading: one thought at a time, breathing room, auto-follow.
 * Alignment uses ElevenLabs CharacterAlignmentResponseModel shape.
 *
 * Compound API for cover modals:
 *   <TranscriptViewer.Root ...>
 *     <TranscriptViewer.Media />     // video / hidden audio
 *     <TranscriptViewer.Controls />  // play + scrub (pin in Modal.Header)
 *     <TranscriptViewer.Content />   // scrollable transcript (Modal.Body)
 *   </TranscriptViewer.Root>
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Button } from "@heroui/react";
import { Focus, List, Pause, Play } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  composeSegmentsFromAlignment,
  formatClock,
  groupWordsIntoParagraphs,
  needsLatinWordSpace,
  resolveAlignment,
  splitPlainTextParagraphs,
  type TranscriptParagraph,
  type TranscriptWord,
} from "@/lib/alignment";
import type { CharacterAlignment, TranscriptSegment } from "@/types";
import { motion } from "framer-motion";
import { useFade } from "@/lib/motion";

type WordStatus = "spoken" | "unspoken" | "current";
type ViewMode = "focus" | "read";

type TranscriptViewerProps = {
  text: string;
  audioSrc?: string | null;
  mediaSrc?: string | null;
  mediaKind?: "audio" | "video" | string;
  durationSeconds: number;
  segments?: TranscriptSegment[] | null;
  alignment?: CharacterAlignment | null;
  className?: string;
  emptyLabel?: string;
  children?: ReactNode;
};

type TranscriptCtx = {
  src: string | null;
  isVideo: boolean;
  mediaRef: React.MutableRefObject<HTMLMediaElement | null>;
  scrollRef: React.MutableRefObject<HTMLDivElement | null>;
  activeParaRef: React.MutableRefObject<HTMLElement | null>;
  duration: number;
  isPlaying: boolean;
  setIsScrubbing: (v: boolean) => void;
  mode: ViewMode;
  setMode: (m: ViewMode) => void;
  isLong: boolean;
  hasTimed: boolean;
  paragraphs: TranscriptParagraph[];
  plainParagraphs: string[];
  emptyLabel: string;
  currentParaIndex: number;
  isPlayingOrScrubbed: boolean;
  statusForWord: (word: TranscriptWord) => WordStatus;
  seekTo: (time: number) => void;
  togglePlay: () => void;
  seekToWord: (word: TranscriptWord) => void;
  seekToParagraph: (para: TranscriptParagraph) => void;
  onUserScroll: () => void;
  mediaHandlers: {
    onPlay: () => void;
    onPause: () => void;
    onEnded: () => void;
    onLoadedMetadata: (e: React.SyntheticEvent<HTMLMediaElement>) => void;
    onDurationChange: (e: React.SyntheticEvent<HTMLMediaElement>) => void;
  };
};

/** Clock/scrubber only — updates ~10 Hz; must not fan out into word tree. */
type ClockCtx = {
  currentTime: number;
  progress: number;
};

const TranscriptContext = createContext<TranscriptCtx | null>(null);
const ClockContext = createContext<ClockCtx>({ currentTime: 0, progress: 0 });

function useTranscript() {
  const ctx = useContext(TranscriptContext);
  if (!ctx) {
    throw new Error(
      "TranscriptViewer compound parts must be used within TranscriptViewer.Root",
    );
  }
  return ctx;
}

function useClock() {
  return useContext(ClockContext);
}

function TranscriptRoot({
  text,
  mediaSrc,
  mediaKind = "audio",
  durationSeconds,
  segments,
  alignment,
  emptyLabel = "暂无转写文本",
  children,
}: TranscriptViewerProps) {
  const src = mediaSrc ?? null;
  const isVideo = mediaKind === "video";
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const activeParaRef = useRef<HTMLElement | null>(null);
  const userScrollUntil = useRef(0);
  /** Raw media time — updated every frame without React. */
  const timeRef = useRef(0);
  const wordIdxRef = useRef(-1);
  const paraIdxRef = useRef(-1);
  const lastUiFlushRef = useRef(0);

  const [currentTime, setCurrentTime] = useState(0);
  const [currentWordIndex, setCurrentWordIndex] = useState(-1);
  const [currentParaIndex, setCurrentParaIndex] = useState(-1);
  const [atEnd, setAtEnd] = useState(false);
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
    timeRef.current = 0;
    wordIdxRef.current = -1;
    paraIdxRef.current = -1;
    lastUiFlushRef.current = 0;
    setCurrentTime(0);
    setCurrentWordIndex(-1);
    setCurrentParaIndex(-1);
    setAtEnd(false);
    setIsPlaying(false);
  }, [src, text]);

  const syncPlaybackMarkers = useCallback(
    (t: number, forceUi = false) => {
      timeRef.current = t;
      const words = composed.words;
      const dur = duration;
      const end = dur > 0 && t >= dur - 0.05;

      let idx = -1;
      if (words.length) {
        // Current word = last one already started. DON'T break on the first
        // future word: streaming segments overlap (rollback/overlap), so a
        // boundary can dip startTime backward — an early break would freeze the
        // highlight for the rest of playback.
        for (let i = 0; i < words.length; i++) {
          if (t + 1e-3 >= words[i].startTime) idx = i;
        }
        if (end) idx = words.length - 1;
      }

      let paraIdx = -1;
      if (idx >= 0) {
        for (let p = 0; p < paragraphs.length; p++) {
          const first = paragraphs[p].words[0]?.wordIndex ?? -1;
          const last =
            paragraphs[p].words[paragraphs[p].words.length - 1]?.wordIndex ??
            -1;
          if (idx >= first && idx <= last) {
            paraIdx = p;
            break;
          }
        }
      }

      if (idx !== wordIdxRef.current) {
        wordIdxRef.current = idx;
        setCurrentWordIndex(idx);
      }
      if (paraIdx !== paraIdxRef.current) {
        paraIdxRef.current = paraIdx;
        setCurrentParaIndex(paraIdx);
      }
      setAtEnd((prev) => (prev === end ? prev : end));

      // Scrubber/clock: ~10 Hz, not 60 fps full-tree reconcile.
      const now =
        typeof performance !== "undefined" ? performance.now() : Date.now();
      if (forceUi || now - lastUiFlushRef.current >= 100) {
        lastUiFlushRef.current = now;
        setCurrentTime(t);
      }
    },
    [composed.words, duration, paragraphs],
  );

  useEffect(() => {
    const tick = () => {
      const el = mediaRef.current;
      if (el && !isScrubbing) syncPlaybackMarkers(el.currentTime);
      rafRef.current = requestAnimationFrame(tick);
    };
    if (isPlaying) rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [isPlaying, isScrubbing, syncPlaybackMarkers]);

  const seekTo = useCallback(
    (time: number) => {
      const el = mediaRef.current;
      if (!el) return;
      const next = Math.min(Math.max(time, 0), el.duration || duration || 0);
      el.currentTime = next;
      syncPlaybackMarkers(next, true);
    },
    [duration, syncPlaybackMarkers],
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

  useEffect(() => {
    if (mode !== "focus" && !isPlaying) return;
    if (Date.now() < userScrollUntil.current) return;
    const node = activeParaRef.current;
    const scroller = scrollRef.current;
    if (!node || !scroller) return;
    const scrollerRect = scroller.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    const nodeTop = nodeRect.top - scrollerRect.top + scroller.scrollTop;
    const target = Math.max(0, nodeTop - scroller.clientHeight * 0.28);
    // Instant follow — smooth queues layout thrash while playhead advances.
    scroller.scrollTo({ top: target, behavior: "auto" });
  }, [currentParaIndex, mode, isPlaying]);

  const onUserScroll = useCallback(() => {
    userScrollUntil.current = Date.now() + 2800;
  }, []);

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
  const hasTimed = paragraphs.length > 0;
  const isPlayingOrScrubbed =
    isPlaying || currentWordIndex >= 0 || currentParaIndex >= 0;

  const mediaHandlers = useMemo(
    () => ({
      onPlay: () => setIsPlaying(true),
      onPause: () => setIsPlaying(false),
      onEnded: () => {
        setIsPlaying(false);
        syncPlaybackMarkers(duration, true);
      },
      onLoadedMetadata: (e: React.SyntheticEvent<HTMLMediaElement>) => {
        const d = e.currentTarget.duration;
        if (Number.isFinite(d) && d > 0) setDuration(d);
      },
      onDurationChange: (e: React.SyntheticEvent<HTMLMediaElement>) => {
        const d = e.currentTarget.duration;
        if (Number.isFinite(d) && d > 0) setDuration(d);
      },
    }),
    [duration, syncPlaybackMarkers],
  );

  const value = useMemo<TranscriptCtx>(
    () => ({
      src,
      isVideo,
      mediaRef,
      scrollRef,
      activeParaRef,
      duration,
      isPlaying,
      setIsScrubbing,
      mode,
      setMode,
      isLong,
      hasTimed,
      paragraphs,
      plainParagraphs,
      emptyLabel,
      currentParaIndex,
      isPlayingOrScrubbed,
      statusForWord,
      seekTo,
      togglePlay,
      seekToWord,
      seekToParagraph,
      onUserScroll,
      mediaHandlers,
    }),
    [
      src,
      isVideo,
      duration,
      isPlaying,
      mode,
      isLong,
      hasTimed,
      paragraphs,
      plainParagraphs,
      emptyLabel,
      currentParaIndex,
      isPlayingOrScrubbed,
      statusForWord,
      seekTo,
      togglePlay,
      seekToWord,
      seekToParagraph,
      onUserScroll,
      mediaHandlers,
    ],
  );

  const clock = useMemo<ClockCtx>(
    () => ({ currentTime, progress }),
    [currentTime, progress],
  );

  return (
    <TranscriptContext.Provider value={value}>
      <ClockContext.Provider value={clock}>{children}</ClockContext.Provider>
    </TranscriptContext.Provider>
  );
}

/** Cache orientation by media src to avoid layout flash on reopen. */
const orientationCache = new Map<string, "landscape" | "portrait">();

function TranscriptMedia({
  className,
  videoClassName,
}: {
  className?: string;
  videoClassName?: string;
}) {
  const { src, isVideo, mediaRef, mediaHandlers } = useTranscript();
  const [orientation, setOrientation] = useState<"landscape" | "portrait" | null>(
    () => (src ? orientationCache.get(src) ?? null : null),
  );

  useEffect(() => {
    setOrientation(src ? orientationCache.get(src) ?? null : null);
  }, [src]);

  const syncOrientation = useCallback(
    (el: HTMLVideoElement | null) => {
      if (!el || !el.videoWidth || !el.videoHeight) return;
      const next =
        el.videoWidth >= el.videoHeight ? "landscape" : "portrait";
      if (src) orientationCache.set(src, next);
      setOrientation((prev) => (prev === next ? prev : next));
    },
    [src],
  );

  if (!src) return null;

  if (isVideo) {
    const { onLoadedMetadata, ...restMediaHandlers } = mediaHandlers;
    const ready = orientation != null;
    return (
      <video
        ref={(el) => {
          mediaRef.current = el;
          syncOrientation(el);
        }}
        src={src}
        preload="metadata"
        playsInline
        className={cn(
          "rounded-xl bg-black object-contain",
          videoClassName,
          className,
          // Hold off painting until ratio is known so landscape/portrait
          // classes never swap visibly.
          !ready && "pointer-events-none invisible absolute h-px w-px",
          ready &&
            orientation === "portrait" &&
            "h-auto max-h-[min(52vh,28rem)] w-auto max-w-full",
          ready &&
            orientation === "landscape" &&
            "h-auto max-h-[min(40vh,22rem)] w-full",
        )}
        {...restMediaHandlers}
        onLoadedMetadata={(e) => {
          syncOrientation(e.currentTarget);
          onLoadedMetadata(e);
        }}
      />
    );
  }

  return (
    <audio
      ref={(el) => {
        mediaRef.current = el;
      }}
      src={src}
      preload="metadata"
      className={cn("sr-only", className)}
      {...mediaHandlers}
    />
  );
}

function TranscriptControls({ className }: { className?: string }) {
  const {
    src,
    isPlaying,
    togglePlay,
    duration,
    seekTo,
    setIsScrubbing,
  } = useTranscript();
  const { currentTime, progress } = useClock();
  const fade = useFade();

  if (!src) return null;

  return (
    <motion.div
      className={cn("flex flex-col gap-2", className)}
      initial={fade.initial}
      animate={fade.animate}
      transition={fade.transition}
    >
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
    </motion.div>
  );
}

function TranscriptModeToggle({ className }: { className?: string }) {
  const { isLong, hasTimed, plainParagraphs, mode, setMode } = useTranscript();

  if (!((hasTimed || plainParagraphs.length > 0) && isLong)) return null;

  return (
    <div className={cn("flex items-center justify-between gap-2", className)}>
      <p className="text-[11px] text-muted">
        {mode === "focus" ? "专注模式 · 跟随当前一句" : "全文模式 · 可滚动阅读"}
      </p>
      <div className="flex overflow-hidden rounded-full border border-border bg-surface">
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={mode === "focus"}
          className={cn(
            "inline-flex h-auto min-h-0 items-center gap-1 rounded-none px-2.5 py-1 text-[11px] shadow-none",
            mode === "focus"
              ? "bg-accent/15 font-medium text-accent-soft-foreground data-[hovered=true]:bg-accent/15"
              : "text-muted hover:text-foreground data-[hovered=true]:text-foreground",
          )}
          onPress={() => setMode("focus")}
        >
          <Focus size={12} aria-hidden />
          专注
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={mode === "read"}
          className={cn(
            "inline-flex h-auto min-h-0 items-center gap-1 rounded-none px-2.5 py-1 text-[11px] shadow-none",
            mode === "read"
              ? "bg-accent/15 font-medium text-accent-soft-foreground data-[hovered=true]:bg-accent/15"
              : "text-muted hover:text-foreground data-[hovered=true]:text-foreground",
          )}
          onPress={() => setMode("read")}
        >
          <List size={12} aria-hidden />
          全文
        </Button>
      </div>
    </div>
  );
}

function TranscriptContent({
  className,
  scroll = true,
  fill = false,
}: {
  className?: string;
  /** When false, parent (e.g. Modal.Body) owns scrolling; we bind auto-follow to it. */
  scroll?: boolean;
  /** Use flex-1 min-h-0 instead of max-height when this element scrolls. */
  fill?: boolean;
}) {
  const {
    scrollRef,
    activeParaRef,
    onUserScroll,
    mode,
    isLong,
    hasTimed,
    paragraphs,
    plainParagraphs,
    emptyLabel,
    currentParaIndex,
    isPlayingOrScrubbed,
    statusForWord,
    seekToWord,
    seekToParagraph,
  } = useTranscript();

  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (scroll) return;
    const node = rootRef.current;
    if (!node) return;

    let el: HTMLElement | null = node.parentElement;
    while (el) {
      const { overflowY } = getComputedStyle(el);
      if (
        overflowY === "auto" ||
        overflowY === "scroll" ||
        overflowY === "overlay"
      ) {
        scrollRef.current = el as HTMLDivElement;
        const handler = () => onUserScroll();
        el.addEventListener("scroll", handler, { passive: true });
        return () => {
          el?.removeEventListener("scroll", handler);
          if (scrollRef.current === el) scrollRef.current = null;
        };
      }
      el = el.parentElement;
    }
  }, [scroll, scrollRef, onUserScroll]);

  return (
    <div ref={rootRef} className={cn("flex flex-col gap-3", className)}>
      <div
        ref={scroll ? scrollRef : undefined}
        onScroll={scroll ? onUserScroll : undefined}
        className={cn(
          "transcript-scroll relative",
          scroll && "overflow-y-auto overscroll-contain",
          scroll &&
            (fill
              ? "min-h-0 flex-1"
              : isLong
                ? "max-h-[min(52vh,420px)]"
                : "max-h-[min(60vh,520px)]"),
          mode === "focus" && "px-1",
        )}
      >
        {hasTimed ? (
          <div
            className={cn(
              "mx-auto flex max-w-[40rem] flex-col",
              mode === "focus" ? "gap-5 py-6" : "gap-4 py-2",
            )}
          >
            {paragraphs.map((para, pi) => {
              const isActive = pi === currentParaIndex;
              const isPast = currentParaIndex >= 0 && pi < currentParaIndex;
              const isFuture = currentParaIndex >= 0 && pi > currentParaIndex;
              const dim =
                mode === "focus" &&
                currentParaIndex >= 0 &&
                !isActive &&
                isPlayingOrScrubbed;

              return (
                <section
                  key={para.id}
                  ref={
                    isActive
                      ? (el) => {
                          activeParaRef.current = el;
                        }
                      : undefined
                  }
                  data-active={isActive || undefined}
                  className={cn(
                    "group relative rounded-xl transition-[opacity,background-color] duration-200",
                    mode === "focus" &&
                      isActive &&
                      "bg-accent/[0.07] px-4 py-3.5 ring-1 ring-accent/15",

                    mode === "read" && !isActive && "pl-3.5",
                    dim && isPast && "opacity-[0.38]",
                    dim && isFuture && "opacity-[0.26]",
                  )}
                >
                  <Button
                    variant="ghost"
                    aria-label={`跳转到 ${formatClock(para.startTime)}`}
                    className="mb-1.5 h-auto min-h-0 justify-start rounded-none px-0 py-0 font-mono text-[10px] font-normal tabular-nums tracking-wider text-muted/70 shadow-none hover:text-accent-soft-foreground data-[hovered=true]:bg-transparent data-[hovered=true]:text-accent-soft-foreground data-[pressed=true]:bg-transparent data-[pressed=true]:opacity-60"
                    onPress={() => seekToParagraph(para)}
                  >
                    {formatClock(para.startTime)}
                  </Button>
                  <p
                    className={cn(
                      "text-pretty break-words",
                      mode === "focus" && isActive
                        ? "text-[17px] leading-[1.85] sm:text-[18px]"
                        : "text-[15px] leading-[1.75] sm:text-base",
                      "text-foreground",
                    )}
                  >
                    {para.words.map((word, wi) => {
                      const status = statusForWord(word);
                      const prev = wi > 0 ? para.words[wi - 1] : null;
                      const needSpace =
                        prev != null && needsLatinWordSpace(prev.text, word.text);
                      return (
                        <span key={`w-${word.segmentIndex}`}>
                          {needSpace ? " " : null}
                          <span
                            role="button"
                            tabIndex={0}
                            data-status={status}
                            aria-label={`${word.text}, ${formatClock(word.startTime)}`}
                            className={cn(
                              "inline cursor-pointer rounded-sm transition-colors duration-100 outline-none focus-visible:ring-1 focus-visible:ring-accent/50",
                              // Latin click targets need a sliver of padding; CJK must stay flush.
                              /[A-Za-z0-9]/.test(word.text) && "px-px",
                              status === "spoken" && "text-muted",
                              status === "current" &&
                                "bg-accent/25 font-medium text-accent-soft-foreground",
                              status === "unspoken" && "text-inherit",
                            )}
                            onClick={() => seekToWord(word)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                seekToWord(word);
                              }
                            }}
                          >
                            {word.text}
                          </span>
                        </span>
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
    </div>
  );
}

/** Default stacked layout: media → text → controls. */
export function TranscriptViewer({
  className,
  ...props
}: TranscriptViewerProps) {
  return (
    <TranscriptRoot {...props}>
      <div
        className={cn(
          "flex flex-col gap-4 rounded-2xl border border-border bg-surface-secondary/40 p-4",
          className,
        )}
      >
        <TranscriptMedia />
        <TranscriptModeToggle />
        <TranscriptContent />
        <TranscriptControls className="border-t border-border/60 pt-3" />
      </div>
    </TranscriptRoot>
  );
}

TranscriptViewer.Root = TranscriptRoot;
TranscriptViewer.Media = TranscriptMedia;
TranscriptViewer.Controls = TranscriptControls;
TranscriptViewer.Content = TranscriptContent;
TranscriptViewer.ModeToggle = TranscriptModeToggle;

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
