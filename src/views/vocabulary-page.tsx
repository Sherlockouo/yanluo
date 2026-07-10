import { Button, Chip, Input, Label, TextField } from "@heroui/react";
import { Plus, Save, X } from "lucide-react";
import {
  EmptyState,
  PageHeader,
  PageShell,
  SectionCard,
} from "@/components/shared/page-shell";
import { useApp } from "@/app-context";

export function VocabularyPage() {
  const {
    config,
    newTerm,
    setNewTerm,
    addTerm,
    saveVocabulary,
    saveConfig,
  } = useApp();

  return (
    <PageShell>
      <PageHeader
        title="词库"
        subtitle="识别后替换。例：配森=Python"
      />

      <SectionCard className="max-w-2xl flex flex-col gap-5">
        <div className="flex items-end gap-2">
          <TextField
            fullWidth
            variant="secondary"
            value={newTerm}
            onChange={setNewTerm}
          >
            <Label>词条</Label>
            <Input
              placeholder="Python / 配森=Python"
              onKeyDown={(e) => {
                if (e.key === "Enter") addTerm();
              }}
            />
          </TextField>
          <Button variant="primary" onPress={addTerm}>
            <Plus size={16} />
            添加
          </Button>
        </div>

        <div className="flex min-h-[160px] flex-wrap content-start gap-2 rounded-2xl border border-border bg-surface-secondary/40 p-4">
          {config.vocabulary.length === 0 ? (
            <EmptyState
              title="还没有词条"
              description="添加术语或「错词=正确」映射。"
            />
          ) : (
            config.vocabulary.map((term) => (
              <button
                key={term}
                type="button"
                className="group"
                onClick={() =>
                  void saveVocabulary(
                    config.vocabulary.filter((t) => t !== term),
                  )
                }
                title="点击删除"
              >
                <Chip
                  size="sm"
                  variant="soft"
                  className="transition group-hover:bg-danger/15 group-hover:text-danger"
                >
                  <Chip.Label className="inline-flex items-center gap-1.5">
                    {term}
                    <X size={11} className="opacity-50" />
                  </Chip.Label>
                </Chip>
              </button>
            ))
          )}
        </div>

        <Button fullWidth variant="secondary" onPress={() => void saveConfig()}>
          <Save size={16} />
          保存
        </Button>
      </SectionCard>
    </PageShell>
  );
}
