import { Fragment, useDeferredValue, useMemo, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { motion, useReducedMotion } from "framer-motion";
import { PageShell, Reveal } from "@/components/shared/page-shell";
import { WordCloud } from "@/components/home/word-cloud";
import { duration, easeOut } from "@/lib/motion";
import {
  aggregateAllSources,
  CLOUD_SOURCES,
  type CloudSource,
} from "@/lib/word-freq";
import { useT } from "@/lib/i18n";
import { useApp } from "@/app-context";

const CLOUD_SOURCE_KEY = "yanluo:home-cloud-source";

function readCloudSource(): CloudSource {
  try {
    const v = sessionStorage.getItem(CLOUD_SOURCE_KEY);
    if (v === "fn" || v === "translate" || v === "transcribe") return v;
  } catch {
    /* ignore */
  }
  return "fn";
}

export function OverviewPage() {
  const t = useT();
  const navigate = useNavigate();
  const { config, modelLoaded, agentJobs, history } = useApp();
  const [cloudSource, setCloudSource] = useState<CloudSource>(readCloudSource);
  const reduceMotion = useReducedMotion();

  // All sources aggregated in ONE pass per history change — tab switches reuse
  // the cache instead of re-tokenizing the full history on the click frame.
  const clouds = useMemo(() => aggregateAllSources(history, 40), [history]);
  // Tab highlight is instant (cloudSource); the cloud swap is deferred so the
  // press feedback never waits on pack/layout work.
  const deferredSource = useDeferredValue(cloudSource);
  const cloudWords = clouds[deferredSource] ?? [];

  const setSource = (id: CloudSource) => {
    setCloudSource(id);
    try {
      sessionStorage.setItem(CLOUD_SOURCE_KEY, id);
    } catch {
      /* ignore */
    }
  };

  // Model not installed — gated state for draft card (not a wall).
  const needsInstall =
    config.asr_provider === "qwen" &&
    !config.asr_model_dir?.trim() &&
    !modelLoaded;

  const activeAgents = agentJobs.filter(
    (j) => j.status === "queued" || j.status === "running",
  ).length;

  const dispatchHint =
    activeAgents > 0
      ? t("home.runningCount", { n: activeAgents })
      : agentJobs.length > 0
        ? t("home.jobCount", { n: agentJobs.length })
        : t("home.dispatchDefault");

  const draftKey = config.hotkey_transcribe.label;
  const translateKey = config.hotkey_translate.label;
  const agentKey = config.hotkey_agent?.label ?? "Fn+Space";

  return (
    <PageShell className="page-fill mx-0 max-w-[1080px] gap-0 pb-0">
      <Reveal index={0}>
        <span className="home-eyebrow">{t("home.eyebrow")}</span>
        <h1 className="home-headline mt-3.5">{t("home.headline")}</h1>
      </Reveal>

      <div className="mt-9 grid gap-3.5 sm:grid-cols-2">
        <Reveal index={1} className="h-full">
          <NavLink
            to={needsInstall ? "#" : "/draft"}
            className={`dest-card dest-card-primary card-press h-full${needsInstall ? " pointer-events-auto" : ""}`}
            style={needsInstall ? { opacity: 0.7 } : undefined}
            onClick={needsInstall ? (e) => e.preventDefault() : undefined}
          >
            <div>
              <div className="dest-label dest-label-primary">{t("home.draftCard")}</div>
              <div className="dest-hint">
                {t("home.draftHintA")}
                <br />
                {t("home.draftHintB")}
              </div>
              {needsInstall ? (
                // span, not NavLink — nested <a> inside the card's <a> is invalid
                // HTML and swallows the click on some engines.
                <span
                  role="link"
                  tabIndex={0}
                  className="mt-2 inline-block cursor-pointer font-mono text-xs text-muted chip-press transition-colors hover:text-foreground"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    navigate("/settings?tab=asr");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      navigate("/settings?tab=asr");
                    }
                  }}
                >
                  {t("home.modelNotReady")}
                </span>
              ) : null}
            </div>
            <div className="dest-foot">
              <span className="kbd-key">{draftKey}</span>
            </div>
          </NavLink>
        </Reveal>

        <Reveal index={2} className="h-full">
          <NavLink to="/dispatch" className="dest-card card-press h-full">
            <div>
              <div className="dest-label">{t("home.dispatchCard")}</div>
              <div className="dest-hint">
                {dispatchHint}
                <br />
                {t("home.dispatchHintB")}
              </div>
            </div>
            <div className="dest-foot">
              <span className="kbd-key">{agentKey}</span>
            </div>
          </NavLink>
        </Reveal>
      </div>

      <Reveal index={3} className="home-cloud">
        <div className="home-cloud-head">
          <span className="home-cloud-label">{t("home.wordCloud")}</span>
          <div className="tswitch" role="tablist" aria-label={t("home.cloudSourceAria")}>
            {CLOUD_SOURCES.map((s, i) => (
              <Fragment key={s.id}>
                {i > 0 ? (
                  <span className="sep" aria-hidden>
                    ·
                  </span>
                ) : null}
                <button
                  type="button"
                  role="tab"
                  aria-selected={cloudSource === s.id}
                  className={`chip-press o${cloudSource === s.id ? " is-active" : ""}`}
                  onClick={() => setSource(s.id)}
                >
                  {t(`home.cloudSource.${s.id}`)}
                </button>
              </Fragment>
            ))}
          </div>
        </div>
        <motion.div
          key={deferredSource}
          initial={reduceMotion ? false : { opacity: 0.96, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: duration.fast, ease: easeOut }}
        >
          <WordCloud words={cloudWords} />
        </motion.div>
      </Reveal>

      <Reveal index={4} className="home-legend mt-auto pt-10">
        <span>
          <b>{draftKey}</b> {t("home.draftCard")}
        </span>
        <span>
          <b>{translateKey}</b> {t("home.legendTranslate")}
        </span>
        <span>
          <b>{agentKey}</b> {t("home.dispatchCard")}
        </span>
        <span>{t("home.privacyNote")}</span>
      </Reveal>
    </PageShell>
  );
}
