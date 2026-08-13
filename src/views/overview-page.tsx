import { Fragment, useMemo, useState } from "react";
import { NavLink } from "react-router-dom";
import { motion, useReducedMotion } from "framer-motion";
import { PageShell } from "@/components/shared/page-shell";
import { WordCloud } from "@/components/home/word-cloud";
import { duration, easeOut, springUI } from "@/lib/motion";
import {
  aggregateWordFreq,
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
  const { config, modelLoaded, agentJobs, history } = useApp();
  const [cloudSource, setCloudSource] = useState<CloudSource>(readCloudSource);
  const reduceMotion = useReducedMotion();

  const cloudWords = useMemo(
    () => aggregateWordFreq(history, cloudSource, 40),
    [history, cloudSource],
  );

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
      <span className="home-eyebrow">{t("home.eyebrow")}</span>
      <h1 className="home-headline mt-3.5">{t("home.headline")}</h1>

      <div className="mt-9 grid gap-3.5 sm:grid-cols-2">
        <motion.div
          initial={reduceMotion ? false : { opacity: 0.92, y: 14, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={springUI}
        >
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
                <NavLink
                  to="/settings?tab=asr"
                  className="mt-2 inline-block font-mono text-xs text-muted chip-press transition-colors hover:text-foreground"
                  onClick={(e) => e.stopPropagation()}
                >
                  {t("home.modelNotReady")}
                </NavLink>
              ) : null}
            </div>
            <div className="dest-foot">
              <span className="kbd-key">{draftKey}</span>
            </div>
          </NavLink>
        </motion.div>

        <motion.div
          initial={reduceMotion ? false : { opacity: 0.92, y: 14, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ ...springUI, delay: 0.05 }}
        >
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
        </motion.div>
      </div>

      <div className="home-cloud">
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
          key={cloudSource}
          initial={reduceMotion ? false : { opacity: 0.96 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.14, ease: easeOut }}
        >
          <WordCloud words={cloudWords} />
        </motion.div>
      </div>

      <motion.div
        className="home-legend mt-auto pt-10"
        initial={reduceMotion ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{
          duration: duration.fast,
          ease: easeOut,
          delay: reduceMotion ? 0 : 0.06,
        }}
      >
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
      </motion.div>
    </PageShell>
  );
}
