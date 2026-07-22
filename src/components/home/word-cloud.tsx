import { useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import type { WordWeight } from "@/lib/word-freq";
import { duration, easeOut } from "@/lib/motion";

const W = 960;
const H = 300;
/** Gravity influence radius (svg units). Beyond → almost no pull. */
const GRAVITY_R = 360;
/** At distance 0: fraction of the vector toward pointer applied. */
const GRAVITY_NEAR = 0.55;

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
    const fontSize = 16 + t * 30; // 16–46
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

/** Inverse-square-ish falloff: near → strong pull, far → tiny. */
function gravityPull(
  birthX: number,
  birthY: number,
  ptr: { x: number; y: number },
): { x: number; y: number; near: number } {
  const dx = ptr.x - birthX;
  const dy = ptr.y - birthY;
  const dist = Math.hypot(dx, dy);
  const t = Math.max(0, 1 - dist / GRAVITY_R);
  const factor = GRAVITY_NEAR * t * t;
  return { x: dx * factor, y: dy * factor, near: t };
}

const MIN_GAP = 8;

type LivePos = {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  near: number;
  scale: number;
};

/**
 * After gravity, push overlapping boxes apart so hover cluster stays clickable.
 * Mutual separation along least-penetration axis; clamp to canvas.
 */
function resolveLayout(
  placed: Placed[],
  ptr: { x: number; y: number } | null,
  hoverKey: string | null,
  active: boolean,
): LivePos[] {
  const items: LivePos[] = placed.map((p) => {
    const key = `${p.word}-${p.rank}`;
    const pull =
      active && ptr ? gravityPull(p.x, p.y, ptr) : { x: 0, y: 0, near: 0 };
    const hot = hoverKey === key;
    const scale = hot ? 1.12 : 1 + pull.near * 0.04;
    const w = approxWidth(p.word, p.fontSize) * scale;
    const h = p.fontSize * 1.2 * scale;
    return {
      key,
      x: p.x + pull.x,
      y: p.y + pull.y,
      w,
      h,
      near: pull.near,
      scale,
    };
  });

  if (!active) return items;

  // More iters when cluster is dense near pointer.
  const iters = 12;
  for (let n = 0; n < iters; n++) {
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i]!;
        const b = items[j]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const minDx = (a.w + b.w) / 2 + MIN_GAP;
        const minDy = (a.h + b.h) / 2 + MIN_GAP;
        const ox = minDx - Math.abs(dx);
        const oy = minDy - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue;

        // Prefer pushing the less-near (weaker gravity) word farther —
        // keeps cursor-cluster readable without yanking the hovered one away.
        const wa = 0.35 + a.near * 0.4;
        const wb = 0.35 + b.near * 0.4;
        const sum = wa + wb;
        if (ox < oy) {
          const sx = dx === 0 ? 1 : Math.sign(dx);
          const push = ox;
          a.x -= (push * wb) / sum * sx;
          b.x += (push * wa) / sum * sx;
        } else {
          const sy = dy === 0 ? 1 : Math.sign(dy);
          const push = oy;
          a.y -= (push * wb) / sum * sy;
          b.y += (push * wa) / sum * sy;
        }
      }
    }
  }

  for (const it of items) {
    it.x = Math.min(W - it.w / 2 - 4, Math.max(it.w / 2 + 4, it.x));
    it.y = Math.min(H - it.h / 2 - 4, Math.max(it.h / 2 + 4, it.y));
  }
  return items;
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
  const insideRef = useRef(false);
  const [inside, setInside] = useState(false);
  const [ptr, setPtr] = useState<{ x: number; y: number } | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const placed = useMemo(() => packWordCloud(words), [words]);

  const layout = useMemo(
    () =>
      resolveLayout(
        placed,
        ptr,
        hoverKey,
        !reduce && inside && ptr != null,
      ),
    [placed, ptr, hoverKey, reduce, inside],
  );
  const byKey = useMemo(() => {
    const m = new Map<string, LivePos>();
    for (const L of layout) m.set(L.key, L);
    return m;
  }, [layout]);

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
          const live = byKey.get(key);
          const x = live?.x ?? p.x;
          const y = live?.y ?? p.y;
          const scale = live?.scale ?? 1;
          return (
            <motion.g
              key={key}
              initial={false}
              animate={{ x, y, scale }}
              transition={{
                type: "spring",
                stiffness: 340,
                damping: 30,
                mass: 0.32,
              }}
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
