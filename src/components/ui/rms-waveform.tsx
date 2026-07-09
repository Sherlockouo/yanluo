import { useEffect, useRef, type HTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { useWaveformBands } from "@/hooks/useAudioBars";

export type RmsWaveformProps = HTMLAttributes<HTMLDivElement> & {
  /** External RMS from Tauri audio-level events (0–1). */
  rms?: number;
  active?: boolean;
  processing?: boolean;
  barWidth?: number;
  barGap?: number;
  barRadius?: number;
  barColor?: string;
  fadeEdges?: boolean;
  fadeWidth?: number;
  height?: number | string;
  mode?: "static" | "scrolling";
};

/**
 * ElevenLabs LiveWaveform-inspired canvas visualizer.
 * Driven by external RMS instead of opening the microphone,
 * so it coexists with Tauri's native audio capture.
 */
export function RmsWaveform({
  rms = 0,
  active = false,
  processing = false,
  barWidth = 3,
  barGap = 2,
  barRadius = 1.5,
  barColor = "#34d3ee",
  fadeEdges = true,
  fadeWidth = 28,
  height = 72,
  mode = "static",
  className,
  ...props
}: RmsWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<number[]>([]);
  const bandsRef = useRef<number[]>([]);
  const styleRef = useRef({
    barWidth,
    barGap,
    barRadius,
    barColor,
    fadeEdges,
    fadeWidth,
    mode,
  });

  const bandCount = 48;
  const bands = useWaveformBands(rms, active, processing, bandCount);
  const heightStyle = typeof height === "number" ? `${height}px` : height;

  bandsRef.current = bands;
  styleRef.current = {
    barWidth,
    barGap,
    barRadius,
    barColor,
    fadeEdges,
    fadeWidth,
    mode,
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const {
        barWidth: bw,
        barGap: bg,
        barRadius: br,
        barColor: color,
        fadeEdges: fade,
        fadeWidth: fw,
        mode: drawMode,
      } = styleRef.current;
      const bandsNow = bandsRef.current;

      ctx.clearRect(0, 0, rect.width, rect.height);

      const step = bw + bg;
      const count = Math.max(1, Math.floor(rect.width / step));
      const centerY = rect.height / 2;

      if (drawMode === "scrolling") {
        const avg =
          bandsNow.reduce((sum, v) => sum + v, 0) /
          Math.max(1, bandsNow.length);
        historyRef.current.push(avg || 0.08);
        if (historyRef.current.length > 80) historyRef.current.shift();
      }

      const data =
        drawMode === "scrolling"
          ? historyRef.current
          : bandsNow.length
            ? bandsNow
            : Array.from({ length: count }, () => 0.08);

      for (let i = 0; i < count; i++) {
        let value = 0.08;
        if (drawMode === "scrolling") {
          const idx = data.length - 1 - i;
          value = idx >= 0 ? (data[idx] ?? 0.08) : 0.08;
        } else {
          const srcIdx = Math.floor((i / count) * data.length);
          value = data[srcIdx] ?? 0.08;
        }

        const x =
          drawMode === "scrolling" ? rect.width - (i + 1) * step : i * step;
        const barH = Math.max(4, value * rect.height * 0.86);
        const y = centerY - barH / 2;

        ctx.fillStyle = color;
        ctx.globalAlpha = 0.35 + value * 0.65;
        if (br > 0) {
          ctx.beginPath();
          ctx.roundRect(x, y, bw, barH, br);
          ctx.fill();
        } else {
          ctx.fillRect(x, y, bw, barH);
        }
      }

      if (fade && fw > 0 && rect.width > 0) {
        const fadePercent = Math.min(0.28, fw / rect.width);
        const gradient = ctx.createLinearGradient(0, 0, rect.width, 0);
        gradient.addColorStop(0, "rgba(255,255,255,1)");
        gradient.addColorStop(fadePercent, "rgba(255,255,255,0)");
        gradient.addColorStop(1 - fadePercent, "rgba(255,255,255,0)");
        gradient.addColorStop(1, "rgba(255,255,255,1)");
        ctx.globalCompositeOperation = "destination-out";
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, rect.width, rect.height);
        ctx.globalCompositeOperation = "source-over";
      }

      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      ref={containerRef}
      className={cn("relative w-full overflow-hidden", className)}
      style={{ height: heightStyle }}
      role="img"
      aria-label={
        active
          ? "Live audio waveform"
          : processing
            ? "Processing audio"
            : "Audio waveform idle"
      }
      {...props}
    >
      <canvas ref={canvasRef} className="block h-full w-full" aria-hidden />
    </div>
  );
}
