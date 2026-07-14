import { useState } from "react";
import { Button, Chip, Input, Label, TextField } from "@heroui/react";
import { BookOpen, Plus, X } from "lucide-react";
import {
  EmptyState,
  PageHeader,
  PageShell,
  Reveal,
  SoftCollapse,
} from "@/components/shared/page-shell";
import { useApp } from "@/app-context";

export function VocabularyPage() {
  const { config, newTerm, setNewTerm, addTerm, saveVocabulary } = useApp();
  const [addOpen, setAddOpen] = useState(config.vocabulary.length === 0);
  const terms = config.vocabulary;

  return (
    <PageShell className="max-w-2xl">
      <PageHeader
        title="词库"
        status={terms.length ? `${terms.length} 条` : undefined}
        action={
          <Button
            size="sm"
            variant={addOpen ? "primary" : "secondary"}
            onPress={() => setAddOpen((v) => !v)}
          >
            <Plus size={14} />
            添加
          </Button>
        }
      />

      <SoftCollapse open={addOpen}>
        <div className="surface-card mb-1 flex items-end gap-2 p-4">
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
          <Button
            variant="primary"
            className="btn-press shrink-0"
            onPress={addTerm}
          >
            <Plus size={16} />
            添加
          </Button>
        </div>
      </SoftCollapse>

      {terms.length === 0 ? (
        <EmptyState title="还没有词条" icon={<BookOpen size={18} />} />
      ) : (
        <div className="flex min-h-[200px] flex-wrap content-start gap-2">
          {terms.map((term, i) => (
            <Reveal key={term} index={i}>
              <button
                type="button"
                className="group"
                onClick={() =>
                  void saveVocabulary(terms.filter((t) => t !== term))
                }
                title="删除"
              >
                <Chip
                  size="sm"
                  variant="soft"
                  className="transition group-hover:bg-danger/15 group-hover:text-danger"
                >
                  <Chip.Label className="inline-flex items-center gap-1.5 type-ui !font-normal">
                    {term}
                    <X size={11} className="opacity-50" />
                  </Chip.Label>
                </Chip>
              </button>
            </Reveal>
          ))}
        </div>
      )}
    </PageShell>
  );
}
