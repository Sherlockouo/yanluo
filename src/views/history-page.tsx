import { Button, Chip } from "@heroui/react";
import { CheckCircle2, Clipboard, Sparkles, Trash2 } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { PageHeader, PageShell, SectionCard } from "@/components/shared/page-shell";
import { useApp } from "@/app-context";

export function HistoryPage() {
  const { history, clearHistory } = useApp();

  return (
    <PageShell>
      <PageHeader
        title="历史"
        subtitle="最近的识别结果，最多保留 200 条。转写页产生的记录会附带音频。"
        action={
          <Button size="sm" variant="danger" onPress={() => void clearHistory()}>
            <Trash2 size={16} />
            清空历史
          </Button>
        }
      />

      <div className="grid gap-3">
        {history.length === 0 && (
          <SectionCard>
            <div className="grid min-h-[200px] place-items-center text-sm text-muted">
              还没有识别记录
            </div>
          </SectionCard>
        )}

        {history.map((entry) => {
          const audioSrc = entry.audio_path
            ? convertFileSrc(entry.audio_path)
            : null;
          return (
            <SectionCard key={entry.id} className="!p-4">
              <div className="flex items-start gap-4">
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                    <span>{new Date(entry.created_at).toLocaleString()}</span>
                    <span>{entry.duration_seconds.toFixed(1)}s</span>
                    <span>
                      {(entry.source ?? "fn") === "transcribe" ? "转写" : "Fn"}
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-foreground">
                    {entry.text || "（空）"}
                  </p>
                  <Chip
                    size="sm"
                    variant="soft"
                    color={entry.refined ? "accent" : "default"}
                  >
                    <Chip.Label className="inline-flex items-center gap-1.5">
                      {entry.refined ? (
                        <Sparkles size={12} />
                      ) : (
                        <CheckCircle2 size={12} />
                      )}
                      {entry.language || "zh-CN"}
                      {entry.refined ? " · refined" : ""}
                    </Chip.Label>
                  </Chip>
                  {audioSrc ? (
                    <audio
                      className="mt-2 w-full"
                      controls
                      preload="none"
                      src={audioSrc}
                    />
                  ) : null}
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  className="shrink-0"
                  onPress={() => void navigator.clipboard.writeText(entry.text)}
                >
                  <Clipboard size={16} />
                  复制
                </Button>
              </div>
            </SectionCard>
          );
        })}
      </div>
    </PageShell>
  );
}
