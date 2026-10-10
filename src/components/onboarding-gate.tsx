import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
} from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Link } from "react-router-dom";
import { Button, Modal } from "@heroui/react";
import { toast } from "@/lib/toast";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { CheckCircle2, CircleAlert, Download, Keyboard, Mic, Shield } from "lucide-react";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n";
import { duration, easeOut, revealDelay, springBounce, springUI } from "@/lib/motion";
import { useApp } from "@/app-context";
import { ONBOARD_STORAGE_KEY, INTRO_DONE_EVENT, readIntroDone } from "@/lib/first-run";
import { readTourDone, requestStartTour } from "@/components/spotlight-tour";
import { playSfx, unlockSfx } from "@/lib/sfx";
import {
  type ModelDownloadProgress,
  type ModelStatus,
  progressLabel,
} from "@/lib/model-download";

export { ONBOARD_STORAGE_KEY };

function readOnboarded(): boolean {
  try {
    return localStorage.getItem(ONBOARD_STORAGE_KEY) === "1";
  } catch {
    return true;
  }
}

function markOnboarded() {
  try {
    localStorage.setItem(ONBOARD_STORAGE_KEY, "1");
  } catch {
    /* ignore */
  }
}

type MiniPerms = { microphone: boolean; accessibility: boolean };
type PermKind = "microphone" | "accessibility";
type PermRequestResult = {
  granted: boolean;
  open_settings: boolean;
  message?: string;
  needs_relaunch?: boolean;
};
type OnboardStep = "perms" | "engine";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/60";
const QUIET_BTN = `rounded text-[13px] text-muted transition-colors hover:text-foreground disabled:opacity-45 ${FOCUS_RING}`;

/**
 * Quiet first-run: mic + 辅助功能 + 热键, then engine (Apple now / Qwen download).
 * Tokenizer ships with model download — no manual HF step.
 */
export function OnboardingGate() {
  const { config, updateConfig, loadModel, saveConfig } = useApp();
  const t = useT();
  const reduce = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<OnboardStep>("perms");
  const [perms, setPerms] = useState<MiniPerms | null>(null);
  const [busy, setBusy] = useState<PermKind | null>(null);
  const [qwenLocal, setQwenLocal] = useState(false);
  const [modelReady, setModelReady] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<ModelDownloadProgress | null>(null);

  useEffect(() => {
    const tryOpen = () => {
      if (readOnboarded()) return;
      // Cover under intro until brand moment finishes — no double-flash.
      if (!readIntroDone()) return;
      setOpen(true);
    };
    const id = window.requestAnimationFrame(tryOpen);
    window.addEventListener(INTRO_DONE_EVENT, tryOpen);
    return () => {
      window.cancelAnimationFrame(id);
      window.removeEventListener(INTRO_DONE_EVENT, tryOpen);
    };
  }, []);

  useEffect(() => {
    void invoke<{ qwen_local_available?: boolean }>("get_app_info")
      .then((info) => setQwenLocal(Boolean(info.qwen_local_available)))
      .catch(() => setQwenLocal(false));
  }, []);

  const refreshModel = useCallback(async () => {
    try {
      const status = await invoke<ModelStatus>("get_model_status", {
        modelId: config.asr_model_id || "Qwen3-ASR-0.6B",
      });
      setModelReady(status.installed && status.has_tokenizer && !status.needs_download);
    } catch {
      setModelReady(false);
    }
  }, [config.asr_model_id]);

  useEffect(() => {
    if (open && step === "engine") void refreshModel();
  }, [open, step, refreshModel]);

  useEffect(() => {
    if (!open || step !== "engine") return;
    let unlisten: (() => void) | undefined;
    void listen<ModelDownloadProgress>("model-download-progress", (event) => {
      setProgress(event.payload);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [open, step]);

  const refreshPerms = useCallback(async () => {
    try {
      const status = await invoke<MiniPerms>("get_permission_status");
      setPerms({ microphone: status.microphone, accessibility: status.accessibility });
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (open && step === "perms") void refreshPerms();
  }, [open, step, refreshPerms]);

  const requestPerm = async (kind: PermKind) => {
    if (busy) return;
    setBusy(kind);
    try {
      const result = await invoke<PermRequestResult>("request_permission", { kind });
      if (result.open_settings) {
        await invoke("open_permission_settings", { kind }).catch(() => {});
      }
      if (result.message && !result.granted) {
        toast.warning(result.message);
      }
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : String(error));
    } finally {
      window.setTimeout(() => void refreshPerms(), 900);
      setBusy(null);
    }
  };

  const [showDone, setShowDone] = useState(false);

  const finish = () => {
    unlockSfx();
    playSfx("success");
    markOnboarded();
    setShowDone(true);
    // Start tour while gate still covers — shell stays veiled, no blank flash.
    const willTour = !readTourDone();
    if (willTour) {
      window.setTimeout(() => requestStartTour(), 180);
    }
    window.setTimeout(() => {
      setShowDone(false);
      setOpen(false);
    }, willTour ? 520 : 400);
  };

  const goEngineOrFinish = () => {
    if (qwenLocal) {
      setStep("engine");
      return;
    }
    finish();
  };

  const useApple = () => {
    updateConfig("asr_provider", "apple");
    void saveConfig({ ...config, asr_provider: "apple" }, { silent: true });
    finish();
  };

  const downloadQwen = async () => {
    const modelId = config.asr_model_id || "Qwen3-ASR-0.6B";
    setDownloading(true);
    setProgress(null);
    try {
      const path = await invoke<string>("download_qwen_asr_model", {
        modelId,
        downloadAligner: false,
      });
      updateConfig("asr_provider", "qwen");
      updateConfig("asr_model_dir", path);
      updateConfig("asr_model_id", modelId);
      toast.success(t("onboarding.modelReadyToast"));
      await loadModel(path);
      await refreshModel();
      finish();
    } catch (error) {
      toast.danger(
        t("onboarding.downloadFailed", {
          msg: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setDownloading(false);
    }
  };

  const useExistingQwen = async () => {
    const next = {
      ...config,
      asr_provider: "qwen" as const,
    };
    updateConfig("asr_provider", "qwen");
    await saveConfig(next, { silent: true });
    if (config.asr_model_dir?.trim()) {
      await loadModel(config.asr_model_dir);
    }
    finish();
  };

  return (
    <Modal isOpen={open} onOpenChange={() => { /* 完成或跳过才可关闭 */ }}>
      <Modal.Backdrop isDismissable={false}>
        <Modal.Container placement="center" size="md">
          <Modal.Dialog
            aria-label={
              step === "perms"
                ? t("onboarding.permsTitle")
                : t("onboarding.engineAria")
            }
            className="w-full max-w-md p-6"
          >
            {/* Enter-only step swap — keyed remount, no exit stacking. */}
            <motion.div
              key={showDone ? "done" : step}
              initial={reduce ? false : { opacity: 0.96, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: duration.fast, ease: easeOut }}
            >
            {showDone ? (
              <div className="flex flex-col items-center justify-center gap-3 py-8">
                <motion.span
                  className="grid place-items-center"
                  initial={reduce ? false : { opacity: 0.92, scale: 0.6 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={reduce ? { duration: 0 } : springBounce}
                >
                  <CheckCircle2 size={36} className="text-accent-soft-foreground" />
                </motion.span>
                <span className="type-section">{t("onboarding.ready")}</span>
              </div>
            ) : step === "perms" ? (
              <>
                <h2 className="type-section">{t("onboarding.permsTitle")}</h2>
                <p className="mt-1 type-meta">{t("onboarding.permsSubtitle")}</p>

                <div className="mt-4">
                  <PermRow
                    index={0}
                    icon={Mic}
                    title={t("onboarding.micTitle")}
                    desc={t("onboarding.micDesc")}
                    granted={perms?.microphone ?? false}
                    busy={busy === "microphone"}
                    onAuthorize={() => void requestPerm("microphone")}
                  />
                  <PermRow
                    index={1}
                    icon={Shield}
                    title={t("onboarding.axTitle")}
                    desc={t("onboarding.axDesc")}
                    granted={perms?.accessibility ?? false}
                    busy={busy === "accessibility"}
                    onAuthorize={() => void requestPerm("accessibility")}
                  />
                  <motion.div
                    className="perm-row"
                    initial={reduce ? false : { opacity: 0.92, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={
                      reduce ? { duration: 0 } : { ...springUI, delay: revealDelay(2) }
                    }
                  >
                    <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-default/40 text-muted">
                      <Keyboard size={16} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="type-ui">{t("onboarding.hotkeysTitle")}</div>
                      <div className="mt-0.5 type-meta">
                        <b className="text-foreground">{config.hotkey_transcribe.label}</b>{" "}
                        {t("onboarding.slotTranscribe")}
                        {" · "}
                        <b className="text-foreground">{config.hotkey_translate.label}</b>{" "}
                        {t("onboarding.slotTranslate")}
                        {" · "}
                        <b className="text-foreground">{config.hotkey_agent?.label ?? "Fn+Space"}</b>{" "}
                        {t("onboarding.slotAgent")}
                      </div>
                    </div>
                    <Link
                      to="/settings?tab=system&sub=hotkeys"
                      className={`shrink-0 font-medium ${QUIET_BTN}`}
                      onClick={finish}
                    >
                      {t("onboarding.change")}
                    </Link>
                  </motion.div>
                </div>

                <div className="mt-5 flex items-center justify-between gap-3">
                  <button
                    type="button"
                    className={QUIET_BTN}
                    onClick={goEngineOrFinish}
                  >
                    {t("onboarding.skip")}
                  </button>
                  <Button variant="primary" className="btn-press" onPress={goEngineOrFinish}>
                    {t("onboarding.continue")}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <h2 className="type-section">{t("onboarding.engineTitle")}</h2>
                <p className="mt-1 type-meta">{t("onboarding.engineSubtitle")}</p>

                <div className="mt-4 flex flex-col gap-3">
                  <motion.div
                    initial={reduce ? false : { opacity: 0.92, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={
                      reduce ? { duration: 0 } : { ...springUI, delay: revealDelay(0) }
                    }
                  >
                    <button
                      type="button"
                      className={cn("onboard-choice", FOCUS_RING)}
                      disabled={downloading}
                      onClick={useApple}
                    >
                      <div className="type-ui">{t("onboarding.appleTitle")}</div>
                      <div className="mt-0.5 type-meta">{t("onboarding.appleDesc")}</div>
                    </button>
                  </motion.div>

                  <motion.div
                    initial={reduce ? false : { opacity: 0.92, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={
                      reduce ? { duration: 0 } : { ...springUI, delay: revealDelay(1) }
                    }
                  >
                  {modelReady ? (
                    <button
                      type="button"
                      className={cn("onboard-choice onboard-choice-accent", FOCUS_RING)}
                      disabled={downloading}
                      onClick={() => void useExistingQwen()}
                    >
                      <div className="type-ui">{t("onboarding.qwenTitle")}</div>
                      <div className="mt-0.5 type-meta">{t("onboarding.qwenInstalledDesc")}</div>
                    </button>
                  ) : (
                    <div className="onboard-choice onboard-choice-accent flex flex-col gap-3">
                      <div>
                        <div className="type-ui">{t("onboarding.qwenTitle")}</div>
                        <div className="mt-0.5 type-meta">{t("onboarding.qwenDownloadDesc")}</div>
                      </div>
                      {downloading && progress ? (
                        <div className="type-meta">{progressLabel(progress)}</div>
                      ) : null}
                      {downloading && progress?.percent != null ? (
                        <div className="update-progress-track">
                          <div
                            className="update-progress-bar"
                            style={
                              {
                                "--progress":
                                  Math.min(100, Math.max(0, progress.percent)) / 100,
                              } as CSSProperties
                            }
                          />
                        </div>
                      ) : null}
                      <Button
                        fullWidth
                        variant="primary"
                        className="btn-press"
                        isPending={downloading}
                        isDisabled={downloading}
                        onPress={() => void downloadQwen()}
                      >
                        <Download size={14} />
                        {downloading
                          ? t("onboarding.downloading")
                          : t("onboarding.downloadAndEnable")}
                      </Button>
                    </div>
                  )}
                  </motion.div>
                </div>

                <div className="mt-5 flex items-center justify-between gap-3">
                  <button
                    type="button"
                    className={QUIET_BTN}
                    disabled={downloading}
                    onClick={() => setStep("perms")}
                  >
                    {t("onboarding.back")}
                  </button>
                  <button
                    type="button"
                    className={QUIET_BTN}
                    disabled={downloading}
                    onClick={useApple}
                  >
                    {t("onboarding.useAppleForNow")}
                  </button>
                </div>
              </>
            )}
            </motion.div>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

function PermRow({
  icon: Icon,
  title,
  desc,
  granted,
  busy,
  onAuthorize,
  index = 0,
}: {
  icon: typeof Mic;
  title: string;
  desc: string;
  granted: boolean;
  busy: boolean;
  onAuthorize: () => void;
  index?: number;
}) {
  const t = useT();
  const reduce = useReducedMotion();
  return (
    <motion.div
      className="perm-row"
      initial={reduce ? false : { opacity: 0.92, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={
        reduce ? { duration: 0 } : { ...springUI, delay: revealDelay(index) }
      }
    >
      <div
        className={cn(
          "grid h-10 w-10 shrink-0 place-items-center rounded-xl",
          granted
            ? "bg-foreground/[0.06] text-foreground"
            : "bg-default/40 text-muted",
        )}
      >
        <Icon size={16} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="type-ui">{title}</div>
        <div className="mt-0.5 type-meta">{desc}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className={cn("perm-status", granted ? "perm-status-ok" : "perm-status-off")}>
          {granted ? <CheckCircle2 size={12} /> : <CircleAlert size={12} />}
          {granted ? t("onboarding.granted") : t("onboarding.notGranted")}
        </span>
        {!granted ? (
          <Button size="sm" variant="secondary" isDisabled={busy} onPress={onAuthorize}>
            {t("onboarding.authorize")}
          </Button>
        ) : null}
      </div>
    </motion.div>
  );
}
