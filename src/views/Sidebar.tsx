import { Component, Show } from "solid-js";
import { appState, appActions, type AsrMode } from "../store";
import { cn } from "../lib/cn";
import {
  HiOutlineSignal,
  HiOutlineDocumentArrowUp,
  HiOutlineCog6Tooth,
  HiOutlineCpuChip,
} from "solid-icons/hi";

/**
 * Left sidebar — mode switcher + settings + engine status.
 */
export const Sidebar: Component = () => {
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

        {/* Model dir */}
        <div class="space-y-1.5 mb-3">
          <label class="text-xs text-content-secondary">Model directory</label>
          <input
            type="text"
            class="input-field text-xs font-mono"
            placeholder="/path/to/Qwen3-ASR-0.6B"
            value={appState.modelDir}
            onInput={(e) => appActions.setModelDir(e.currentTarget.value)}
          />
        </div>

        {/* Language */}
        <div class="space-y-1.5">
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
  // TODO: wire to real engine status from Rust
  const ready = () => appState.modelDir.trim().length > 0;
  return (
    <div class="flex items-center gap-2">
      <span
        class={cn(
          "w-2 h-2 rounded-full",
          ready() ? "bg-green-500" : "bg-content-tertiary/40"
        )}
      />
      <Show
        when={ready()}
        fallback={<span class="text-xs text-content-tertiary">Not configured</span>}
      >
        <span class="text-xs text-content-secondary">Ready</span>
      </Show>
    </div>
  );
};
