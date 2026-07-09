import { Button, Chip, Input, Label, TextField } from "@heroui/react";
import { Plus, Save, X } from "lucide-react";
import { PageHeader, PageShell, SectionCard } from "@/components/shared/page-shell";
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
        subtitle="添加专有名词、技术术语、人名或项目名，提升识别与纠错准确率。"
      />

      <SectionCard className="max-w-3xl flex flex-col gap-5">
        <div className="flex items-end gap-2">
          <TextField
            fullWidth
            variant="secondary"
            value={newTerm}
            onChange={setNewTerm}
          >
            <Label>新词条</Label>
            <Input
              placeholder="Python / JSON / MySQL / 项目名 …"
              onKeyDown={(e) => {
                if (e.key === "Enter") addTerm();
              }}
            />
          </TextField>
          <Button variant="primary" onPress={addTerm}>
            <Plus size={15} /> 添加
          </Button>
        </div>

        <div className="flex min-h-[180px] flex-wrap content-start gap-2 rounded-2xl border border-border bg-surface-secondary/50 p-4">
          {config.vocabulary.length === 0 ? (
            <div className="grid w-full place-items-center py-10 text-sm text-muted">
              还没有词库条目
            </div>
          ) : (
            config.vocabulary.map((term) => (
              <button
                key={term}
                type="button"
                className="group"
                onClick={() =>
                  void saveVocabulary(config.vocabulary.filter((t) => t !== term))
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
                    <X size={11} className="opacity-60" />
                  </Chip.Label>
                </Chip>
              </button>
            ))
          )}
        </div>

        <Button fullWidth variant="secondary" onPress={() => void saveConfig()}>
          <Save size={15} /> 保存词库
        </Button>
      </SectionCard>
    </PageShell>
  );
}
