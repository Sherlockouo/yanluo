import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Link } from "react-router-dom";
import { Button } from "@heroui/react";
import { invoke } from "@tauri-apps/api/core";
import { CheckCircle2, CircleAlert, Keyboard, Mic, Shield } from "lucide-react";
import { cn } from "@/lib/cn";
import { duration, easeOut, springBounce } from "@/lib/motion";
import { useApp } from "@/app-context";
import { ONBOARD_STORAGE_KEY } from "@/lib/first-run";
import { readTourDone, requestStartTour } from "@/components/spotlight-tour";

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
type PermRequestResult = { granted: boolean; open_settings: boolean };

/**
 * Quiet one-job first-run sheet — mic + 辅助功能 + 热键, then spotlight tour.
 */
export function OnboardingGate() {
  const { config } = useApp();
  const [open, setOpen] = useState(false);
  const [perms, setPerms] = useState<MiniPerms | null>(null);
  const [busy, setBusy] = useState<PermKind | null>(null);

  useEffect(() => {
    const id = window.requestAnimationFrame(() => {
      if (!readOnboarded()) setOpen(true);
    });
    return () => window.cancelAnimationFrame(id);
  }, []);

  const refreshPerms = useCallback(async () => {
    try {
      const status = await invoke<MiniPerms>("get_permission_status");
      setPerms({ microphone: status.microphone, accessibility: status.accessibility });
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (open) void refreshPerms();
  }, [open, refreshPerms]);

  const requestPerm = async (kind: PermKind) => {
    if (busy) return;
    setBusy(kind);
    try {
      const result = await invoke<PermRequestResult>("request_permission", { kind });
      if (result.open_settings) {
        await invoke("open_permission_settings", { kind }).catch(() => {});
      }
    } catch {
      /* ignore */
    } finally {
      window.setTimeout(() => void refreshPerms(), 900);
      setBusy(null);
    }
  };

  const finish = () => {
    markOnboarded();
    setOpen(false);
    if (!readTourDone()) {
      window.setTimeout(() => requestStartTour(), 280);
    }
  };

  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div
          key="onboard-backdrop"
          className="trm-backdrop fixed inset-0 z-50 flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: duration.normal, ease: easeOut }}
        >
          <motion.div
            key="onboard-panel"
            role="dialog"
            aria-modal="true"
            aria-label="开始之前"
            className="flex w-full max-w-md flex-col overflow-hidden rounded-2xl bg-surface p-6 shadow-2xl"
            initial={{ opacity: 0, scale: 0.95, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            transition={springBounce}
          >
            <h2 className="type-section">开始之前</h2>
            <p className="mt-1 type-meta">三步授权，说完就有稿</p>

            <div className="mt-4">
              <PermRow
                icon={Mic}
                title="麦克风权限"
                desc="录制你的声音"
                granted={perms?.microphone ?? false}
                busy={busy === "microphone"}
                onAuthorize={() => void requestPerm("microphone")}
              />
              <PermRow
                icon={Shield}
                title="辅助功能"
                desc="粘贴识别结果需要"
                granted={perms?.accessibility ?? false}
                busy={busy === "accessibility"}
                onAuthorize={() => void requestPerm("accessibility")}
              />
              <div className="perm-row">
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-default/40 text-muted">
                  <Keyboard size={16} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="type-ui">确认热键</div>
                  <div className="mt-0.5 type-meta">
                    <b className="text-foreground">{config.hotkey_transcribe.label}</b> 出稿
                    {" · "}
                    <b className="text-foreground">{config.hotkey_translate.label}</b> 翻译
                    {" · "}
                    <b className="text-foreground">{config.hotkey_agent?.label ?? "Fn+Space"}</b> 派活
                  </div>
                </div>
                <Link
                  to="/settings?tab=system&sub=hotkeys"
                  className="shrink-0 font-medium text-[13px] text-muted transition-colors hover:text-foreground"
                  onClick={finish}
                >
                  修改
                </Link>
              </div>
            </div>

            <div className="mt-5 flex items-center justify-between gap-3">
              <button
                type="button"
                className="text-[13px] text-muted transition-colors hover:text-foreground"
                onClick={finish}
              >
                跳过
              </button>
              <Button variant="primary" className="btn-press" onPress={finish}>
                开始使用
              </Button>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

function PermRow({
  icon: Icon,
  title,
  desc,
  granted,
  busy,
  onAuthorize,
}: {
  icon: typeof Mic;
  title: string;
  desc: string;
  granted: boolean;
  busy: boolean;
  onAuthorize: () => void;
}) {
  return (
    <div className="perm-row">
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
          {granted ? "已授权" : "未授权"}
        </span>
        {!granted ? (
          <Button size="sm" variant="secondary" isDisabled={busy} onPress={onAuthorize}>
            去授权
          </Button>
        ) : null}
      </div>
    </div>
  );
}
