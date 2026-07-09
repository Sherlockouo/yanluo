import { useBarHeights } from "@/hooks/useAudioBars";
import { cn } from "@/lib/cn";

const WAVE_W = 44;
const WAVE_H = 32;

type AudioBarsProps = {
  rms: number;
  active: boolean;
  className?: string;
};

/**
 * Five vertical bars driven by real-time RMS (weights center-high).
 * Size matches HUD spec: 44×32px.
 */
export function AudioBars({ rms, active, className }: AudioBarsProps) {
  const heights = useBarHeights(rms, active, WAVE_H);

  return (
    <div
      className={cn("audio-bars", className)}
      style={{ width: WAVE_W, height: WAVE_H }}
      aria-hidden
    >
      {heights.map((h, i) => (
        <span
          key={i}
          className="audio-bar"
          style={{ height: `${h}px` }}
        />
      ))}
    </div>
  );
}
