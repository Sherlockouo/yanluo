import { Component, Show, onMount } from "solid-js";
import { appState, appActions, type AsrMode } from "../store";
import { cn } from "../lib/cn";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  HiOutlineSignal,
  HiOutlineDocumentArrowUp,
  HiOutlineCog6Tooth,
  HiOutlineCpuChip,
  HiOutlineFolderOpen,
} from "solid-icons/hi";

/**
 * Left sidebar — mode switcher + settings + engine status.
 */
export const Sidebar: Component = () => {
  onMount(() => {
    // Listen for model-loaded event from backend
    listen("model-loaded", () => {
      appActions.setModelLoaded(true);
      appActions.setModelLoading(false);
      appActions.showToast("Model loaded");
    });
    // On mount, try to load the default model path
    invoke("set_model_dir", { path: appState.modelDir }).catch(() => {});
  });

  const handleBrowse = async () => {
    const selected = await open({ directory: true, multiple: false, title: "Select model directory" });
    if (selected && typeof selected === "string") {
      appActions.setModelDir(selected);
      appActions.setModelLoaded(false);
      invoke("set_model_dir", { path: selected });
    }
  };

  const handleLoad = async () => {
    appActions.setModelLoading(true);
    try {
      await invoke("load_model");
    } catch (e) {
      appActions.setModelLoading(false);
      appActions.showToast(`Load failed: ${e}`);
    }
  };

  return (
    <aside class="flex flex-col h-screen bg-surface-sidebar border-r border-border overflow-hidden">
      {/* Brand */}
      <div class="flex items-center gap-2 px-4 pt-4 pb-3">
        <div class="w-7 h-7 rounded-lg bg-accent/10 flex items-center justify-center">
          <HiOutlineSignal class="w-4 h-4 text-accent" />
        </div>
        <h1 class="text-sm font-semibold text-content-primary">ASR Workshop</h1>
      </div>

      {/* Mode switcher */}
      <div class="px-3 pb-3">
        <ModeButton
          mode="stream"
          icon={<HiOutlineSignal class="w-4 h-4" />}
          label="实时流式"
          desc="边录边转"
        />
        <ModeButton
          mode="offline"
          icon={<HiOutlineDocumentArrowUp class="w-4 h-4" />}
          label="离线文件"
          desc="上传音频"
        />
      </div>

      {/* Settings */}
      <div class="px-4 py-3 border-t border-border">
        <div class="flex items-center gap-2 mb-2.5">
          <HiOutlineCog6Tooth class="w-3.5 h-3.5 text-content-tertiary" />
          <span class="text-2xs font-medium text-content-tertiary uppercase tracking-wide">
            Settings
          </span>
        </div>

        {/* Model dir + Browse */}
        <div class="space-y-1.5 mb-3">
          <label class="text-xs text-content-secondary">Model directory</label>
          <div class="flex gap-1">
            <input
              type="text"
              class="input-field text-xs font-mono flex-1"
              placeholder="/path/to/Qwen3-ASR-0.6B"
              value={appState.modelDir}
              onInput={(e) => {
                appActions.setModelDir(e.currentTarget.value);
                appActions.setModelLoaded(false);
                invoke("set_model_dir", { path: e.currentTarget.value });
              }}
              onChange={(e) => {
                // fallback: sync on blur
                invoke("set_model_dir", { path: e.currentTarget.value });
              }}
            />
            <button class="btn-icon !p-2 shrink-0" onClick={handleBrowse} title="Browse...">
              <HiOutlineFolderOpen class="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Load button */}
        <button
          class={cn(
            "btn-primary w-full text-xs",
            appState.modelLoading && "animate-pulse"
          )}
          onClick={handleLoad}
          disabled={appState.modelLoading || !appState.modelDir}
        >
          <Show
            when={appState.modelLoading}
            fallback="Load Model"
          >
            Loading...
          </Show>
        </button>

        {/* Language */}
        <div class="space-y-1.5 mt-3">
          <label class="text-xs text-content-secondary">Language</label>
          <select
            class="select-field text-xs"
            value={appState.language ?? ""}
            onChange={(e) =>
              appActions.setLanguage(e.currentTarget.value || null)
            }
          >
            <option value="">Auto-detect</option>
            <option value="chinese">Chinese</option>
            <option value="english">English</option>
            <option value="cantonese">Cantonese</option>
            <option value="japanese">Japanese</option>
            <option value="korean">Korean</option>
            <option value="french">French</option>
            <option value="german">German</option>
            <option value="spanish">Spanish</option>
            <option value="russian">Russian</option>
          </select>
        </div>
      </div>

      {/* Engine status */}
      <div class="px-4 py-3 border-t border-border">
        <div class="flex items-center gap-2 mb-2">
          <HiOutlineCpuChip class="w-3.5 h-3.5 text-content-tertiary" />
          <span class="text-2xs font-medium text-content-tertiary uppercase tracking-wide">
            Engine
          </span>
        </div>
        <EngineStatus />
      </div>

      {/* Spacer */}
      <div class="flex-1" />

      {/* Footer */}
      <div class="px-4 py-3 border-t border-border">
        <p class="text-2xs text-content-tertiary leading-relaxed">
          Qwen3-ASR · MLX backend
          <br />
          Rust + Tauri + SolidJS
        </p>
      </div>
    </aside>
  );
};

const ModeButton: Component<{
  mode: AsrMode;
  icon: any;
  label: string;
  desc: string;
}> = (props) => {
  const active = () => appState.mode === props.mode;
  return (
    <button
      class={cn(
        "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-150 text-left mb-0.5",
        active()
          ? "bg-accent/10 text-accent"
          : "text-content-secondary hover:bg-surface-secondary hover:text-content-primary"
      )}
      onClick={() => appActions.setMode(props.mode)}
    >
      <span class={cn("shrink-0", active() ? "text-accent" : "text-content-tertiary")}>
        {props.icon}
      </span>
      <span class="flex-1 min-w-0">
        <span class="block text-sm font-medium">{props.label}</span>
        <span class="block text-2xs text-content-tertiary">{props.desc}</span>
      </span>
    </button>
  );
};

const EngineStatus: Component = () => {
  return (
    <div class="flex items-center gap-2">
      <span
        class={cn(
          "w-2 h-2 rounded-full",
          appState.modelLoaded
            ? "bg-green-500"
            : appState.modelLoading
              ? "bg-yellow-500 animate-pulse"
              : "bg-content-tertiary/40"
        )}
      />
      <span class="text-xs text-content-secondary">
        {appState.modelLoading
          ? "Loading..."
          : appState.modelLoaded
            ? "Ready"
            : "Not loaded"}
      </span>
    </div>
  );
};
