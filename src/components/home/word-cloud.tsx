import { useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import type { WordWeight } from "@/lib/word-freq";
import { duration, easeOut } from "@/lib/motion";

const W = 960;
const H = 300;

type Placed = {
  word: string;
  weight: number;
  count: number;
  entryId?: string;
  x: number;
  y: number;
  fontSize: number;
  rank: number;
};

function approxWidth(word: string, fontSize: number): number {
  let units = 0;
  for (const ch of word) {
    units += /[\u4e00-\u9fff]/.test(ch) ? 1 : 0.58;
  }
  return Math.max(fontSize * 0.95, units * fontSize);
}

function overlaps(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
  pad: number,
): boolean {
  return !(
    a.x + a.w / 2 + pad < b.x - b.w / 2 ||
    a.x - a.w / 2 - pad > b.x + b.w / 2 ||
    a.y + a.h / 2 + pad < b.y - b.h / 2 ||
    a.y - a.h / 2 - pad > b.y + b.h / 2
  );
}

/** Deterministic spiral pack — same input → same positions (no jump on re-render). */
export function packWordCloud(
  words: WordWeight[],
  width = W,
  height = H,
): Placed[] {
  if (words.length === 0) return [];
  const maxW = Math.max(...words.map((w) => w.weight), 1);
  const minW = Math.min(...words.map((w) => w.weight), maxW);
  const span = Math.max(maxW - minW, 0.001);
  const cx = width / 2;
  const cy = height / 2;

  const placed: Placed[] = [];
  const boxes: { x: number; y: number; w: number; h: number }[] = [];

  words.forEach((item, rank) => {
    const t = (item.weight - minW) / span;
    const fontSize = 16 + t * 30; // 16–46 — roomier / more presence
    const bw = approxWidth(item.word, fontSize);
    const bh = fontSize * 1.2;

    let found = false;
    let x = cx;
    let y = cy;
    for (let i = 0; i < 1200; i++) {
      const angle = i * 0.4;
      const radius = 4 + i * 0.72;
      x = cx + Math.cos(angle) * radius;
      y = cy + Math.sin(angle) * radius * 0.68;
      const box = { x, y, w: bw, h: bh };
      const inBounds =
        x - bw / 2 > 6 &&
        x + bw / 2 < width - 6 &&
        y - bh / 2 > 4 &&
        y + bh / 2 < height - 4;
      if (!inBounds) continue;
      if (boxes.some((b) => overlaps(box, b, 4))) continue;
      boxes.push(box);
      found = true;
      break;
    }
    if (!found) return;
    placed.push({
      word: item.word,
      weight: item.weight,
      count: item.count,
      entryId: item.entryId,
      x,
      y,
      fontSize,
      rank,
    });
  });

  return placed;
}

function fillForRank(rank: number, total: number, hot: boolean): string {
  if (hot || rank < 3) return "var(--accent-soft-foreground)";
  const t = total <= 1 ? 0 : rank / (total - 1);
  if (t < 0.35) return "var(--foreground)";
  if (t < 0.7) return "var(--muted)";
  return "var(--faint)";
}

type Props = {
  words: WordWeight[];
  emptyHint?: string;
};

export function WordCloud({
  words,
  emptyHint = "还没有词 · 开口出稿后出现",
}: Props) {
  const reduce = useReducedMotion();
  const navigate = useNavigate();
  const svgRef = useRef<SVGSVGElement>(null);
  const [ptr, setPtr] = useState<{ x: number; y: number } | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const placed = useMemo(() => packWordCloud(words), [words]);

  const toSvg = (clientX: number, clientY: number) => {
    const el = svgRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return {
      x: ((clientX - r.left) / r.width) * W,
      y: ((clientY - r.top) / r.height) * H,
    };
  };

  const openWord = (p: Placed) => {
    if (p.entryId) {
      navigate(`/draft?mode=history&hid=${encodeURIComponent(p.entryId)}`);
      return;
    }
    navigate("/draft?mode=history");
  };

  if (words.length === 0) {
    return (
      <div className="home-cloud-empty" role="status">
        {emptyHint}
      </div>
    );
  }

  return (
    <motion.svg
      ref={svgRef}
      className="home-cloud-svg"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="本机高频词"
      initial={reduce ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: duration.slow, ease: easeOut }}
      onPointerMove={(e) => {
        if (reduce) return;
        const p = toSvg(e.clientX, e.clientY);
        if (p) setPtr(p);
      }}
      onPointerLeave={() => {
        setPtr(null);
        setHoverKey(null);
      }}
    >
      {placed.map((p, i) => {
        const key = `${p.word}-${p.rank}`;
        const hot = hoverKey === key;
        // Magnetic pull toward pointer; hovered word follows harder.
        let pullX = 0;
        let pullY = 0;
        if (!reduce && ptr) {
          const dx = ptr.x - p.x;
          const dy = ptr.y - p.y;
          const dist = Math.hypot(dx, dy) || 1;
          const falloff = Math.max(0, 1 - dist / 320);
          const strength = hot ? 0.28 : 0.08 * falloff;
          pullX = dx * strength;
          pullY = dy * strength;
        }
        const tracking = !reduce && (ptr != null || hot);
        const floatAmp = reduce || tracking ? 0 : i % 2 === 0 ? -2.4 : 2.4;
        return (
          <motion.g
            key={key}
            initial={false}
            animate={{
              x: p.x + pullX,
              y: tracking
                ? p.y + pullY
                : [p.y, p.y + floatAmp, p.y],
              scale: hot ? 1.16 : 1,
            }}
            transition={
              tracking
                ? { type: "spring", stiffness: 320, damping: 26, mass: 0.35 }
                : reduce
                  ? undefined
                  : {
                      duration: 5.5 + (i % 5) * 0.55,
                      repeat: Infinity,
                      ease: "easeInOut",
                      delay: (i % 7) * 0.18,
                    }
            }
            style={{ cursor: "pointer" }}
            onPointerEnter={() => setHoverKey(key)}
            onPointerLeave={() =>
              setHoverKey((cur) => (cur === key ? null : cur))
            }
            onClick={() => openWord(p)}
          >
            <title>
              {p.entryId
                ? `${p.word} · ${p.count} 次 · 打开记录`
                : `${p.word} · ${p.count} 次`}
            </title>
            <text
              x={0}
              y={0}
              textAnchor="middle"
              dominantBaseline="middle"
              className="home-cloud-word"
              style={{
                fontSize: p.fontSize,
                fill: fillForRank(p.rank, placed.length, hot),
                fontWeight: hot || p.rank < 3 ? 600 : 500,
              }}
            >
              {p.word}
            </text>
          </motion.g>
        );
      })}
    </motion.svg>
  );
}
