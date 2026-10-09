/**
 * Dev-only perf probe. Self-gates on `?probe=1`. Renders a bottom-left overlay
 * with longtasks and rail-click → route-DOM timings so route-switch jank can be
 * read off the screen (also exposed as window.__perfDump()).
 */

const ENABLED =
  new URLSearchParams(window.location.search).get("probe") === "1";

if (ENABLED) {
  const lines: string[] = [];
  const overlay = document.createElement("pre");
  overlay.id = "perf-probe";
  overlay.style.cssText =
    "position:fixed;left:8px;bottom:8px;z-index:99999;max-width:46vw;max-height:40vh;overflow:auto;" +
    "background:rgba(0,0,0,0.82);color:#7fffb0;font:11px/1.5 ui-monospace,monospace;" +
    "padding:8px 10px;border-radius:8px;pointer-events:none;white-space:pre-wrap;margin:0;";
  const render = () => {
    overlay.textContent = lines.slice(-40).join("\n") || "perf-probe: idle";
  };
  const push = (s: string) => {
    lines.push(s);
    render();
  };

  const mount = () => {
    document.body.appendChild(overlay);
    render();
  };
  if (document.body) mount();
  else window.addEventListener("DOMContentLoaded", mount, { once: true });

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        push(`longtask ${Math.round(e.duration)}ms @${Math.round(e.startTime)}`);
      }
    }).observe({ type: "longtask", buffered: true });
  } catch {
    push("longtask observer unsupported");
  }

  /** Page markers: [route hash fragment, full selector that must appear]. */
  const MARKERS: [string, string][] = [
    ["/draft", ".app-content .dmast"],
  ];

  window.addEventListener(
    "click",
    (ev) => {
      const el = (ev.target as HTMLElement | null)?.closest?.("a.rail-item");
      if (!el) return;
      const label = el.getAttribute("aria-label") ?? "?";
      const t0 = performance.now();
      push(`click[${label}] @${Math.round(t0)}`);
      // Frame-drop stats for 700ms after the click — what the eye actually feels.
      let frames = 0;
      let dropped = 0;
      let worst = 0;
      let last = t0;
      const frame = (now: number) => {
        const dt = now - last;
        last = now;
        frames += 1;
        if (dt > 25) dropped += 1;
        if (dt > worst) worst = dt;
        if (now - t0 < 700) {
          requestAnimationFrame(frame);
        } else {
          push(
            `click[${label}] frames ${frames} dropped ${dropped} worst ${Math.round(worst)}ms`,
          );
        }
      };
      requestAnimationFrame(frame);
      const poll = () => {
        const t = performance.now();
        const hash = location.hash;
        const selector =
          MARKERS.find(([frag]) => hash.includes(frag))?.[1] ??
          ".app-content > *";
        // Route committed once hash points at the target AND its shell exists.
        if (document.querySelector(selector)) {
          push(`click[${label}] route-dom ${Math.round(t - t0)}ms (hash ${hash})`);
          return;
        }
        if (t - t0 > 5000) {
          push(`click[${label}] TIMEOUT 5s (hash ${hash})`);
          return;
        }
        window.setTimeout(poll, 8);
      };
      window.setTimeout(poll, 0);
    },
    true,
  );

  (window as unknown as { __perfDump: () => string }).__perfDump = () =>
    lines.join("\n");
  (window as unknown as { __perfClear: () => void }).__perfClear = () => {
    lines.length = 0;
    render();
  };
  push("perf-probe ready");
}
