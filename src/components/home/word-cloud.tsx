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
  /** Magnetic only while pointer is inside the cloud surface. */
  const insideRef = useRef(false);
  const [inside, setInside] = useState(false);
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

  const leaveCloud = () => {
    insideRef.current = false;
    setInside(false);
    setPtr(null);
    setHoverKey(null);
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
    <div
      className="home-cloud-stage"
      onPointerEnter={(e) => {
        if (reduce) return;
        insideRef.current = true;
        setInside(true);
        const p = toSvg(e.clientX, e.clientY);
        if (p) setPtr(p);
      }}
      onPointerLeave={leaveCloud}
      onPointerMove={(e) => {
        if (reduce || !insideRef.current) return;
        const p = toSvg(e.clientX, e.clientY);
        if (p) setPtr(p);
      }}
    >
      <motion.svg
        ref={svgRef}
        className="home-cloud-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="本机高频词"
        initial={reduce ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: duration.slow, ease: easeOut }}
      >
        {placed.map((p) => {
          const key = `${p.word}-${p.rank}`;
          const hot = inside && hoverKey === key;
          // Magnet only after pointer entered the cloud AND is on this word.
          // Idle = still; no ambient float (mouse-not-moving must look frozen).
          let pullX = 0;
          let pullY = 0;
          if (!reduce && hot && ptr) {
            pullX = (ptr.x - p.x) * 0.62;
            pullY = (ptr.y - p.y) * 0.62;
          }
          return (
            <motion.g
              key={key}
              initial={false}
              animate={{
                x: p.x + pullX,
                y: p.y + pullY,
                scale: hot ? 1.22 : 1,
              }}
              transition={
                hot
                  ? { type: "spring", stiffness: 380, damping: 22, mass: 0.28 }
                  : { type: "spring", stiffness: 420, damping: 36, mass: 0.4 }
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
    </div>
  );
}
