import React from "react";
import { createRoot } from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { App } from "./App";
import { I18nProvider } from "./lib/i18n";
import "./global.css";

const root = document.getElementById("app");
if (!root) throw new Error("Root element #app not found");

/** Show main only after first paint — window starts `visible: false`. */
async function revealMainWindow() {
  try {
    const win = getCurrentWindow();
    if (win.label !== "main") return;
    await win.show();
    await win.setFocus();
  } catch {
    /* browser / non-tauri */
  }
}

function dismissBootShell() {
  const shell = document.getElementById("boot-shell");
  if (!shell) return;
  shell.setAttribute("data-gone", "1");
  window.setTimeout(() => shell.remove(), 240);
}

createRoot(root).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>,
);

// Double rAF: layout + paint of React tree, then reveal.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    dismissBootShell();
    void revealMainWindow();
  });
});
