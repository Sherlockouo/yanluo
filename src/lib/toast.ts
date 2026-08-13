import { toast as herouiToast } from "@heroui/react";

/** Success / info — flash and go (model load, download done). */
export const TOAST_FAST_MS = 1800;
/** Errors / warnings that need a beat more reading time. */
export const TOAST_ALERT_MS = 3200;

type Content = string;
type Opts = { timeout?: number };

/** Prefer this over raw `@heroui/react` toast — short default dismiss. */
export const toast = {
  success: (content: Content, opts?: Opts) =>
    herouiToast.success(content, { timeout: opts?.timeout ?? TOAST_FAST_MS }),
  danger: (content: Content, opts?: Opts) =>
    herouiToast.danger(content, { timeout: opts?.timeout ?? TOAST_ALERT_MS }),
  warning: (content: Content, opts?: Opts) =>
    herouiToast.warning(content, { timeout: opts?.timeout ?? TOAST_ALERT_MS }),
  info: (content: Content, opts?: Opts) =>
    herouiToast.info(content, { timeout: opts?.timeout ?? TOAST_FAST_MS }),
};
