import { useState } from "react";
import { Button, Chip, Input, Label, TextField } from "@heroui/react";
import { BookOpen, Plus, X } from "lucide-react";
import {
  EmptyState,
  PageHeader,
  PageShell,
  PanelHeader,
  Reveal,
  SoftCollapse,
} from "@/components/shared/page-shell";
import { useApp } from "@/app-context";

/** Vocabulary entries. Used standalone or embedded in 设置 → 词库. */
export function VocabularyPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { config, newTerm, setNewTerm, addTerm, saveVocabulary } = useApp();
  const [addOpen, setAddOpen] = useState(config.vocabulary.length === 0);
  const terms = config.vocabulary;

  const headerAction = (
    <Button
      size="sm"
      variant="secondary"
      onPress={() => setAddOpen((v) => !v)}
    >
      <Plus size={14} />
      添加
    </Button>
  );

  const content = (
    <>
      {embedded ? (
        <PanelHeader
          status={terms.length ? `${terms.length} 条` : undefined}
          action={headerAction}
        />
      ) : (
        <PageHeader
          title="词库"
          status={terms.length ? `${terms.length} 条` : undefined}
          action={headerAction}
        />
      )}

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
              <Button
                variant="ghost"
                className="group h-auto min-h-0 p-0 shadow-none"
                aria-label={`删除 ${term}`}
                onPress={() =>
                  void saveVocabulary(terms.filter((t) => t !== term))
                }
              >
                <Chip
                  size="sm"
                  variant="soft"
                  className="transition group-hover:bg-danger/15 group-hover:text-danger group-data-[hovered=true]:bg-danger/15 group-data-[hovered=true]:text-danger"
                >
                  <Chip.Label className="inline-flex items-center gap-1.5 type-ui !font-normal">
                    {term}
                    <X size={11} className="opacity-50" />
                  </Chip.Label>
                </Chip>
              </Button>
            </Reveal>
          ))}
        </div>
      )}
    </>
  );

  if (embedded) return content;
  return <PageShell className="max-w-2xl">{content}</PageShell>;
}
