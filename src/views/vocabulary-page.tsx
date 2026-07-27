import { useState } from "react";
import { Link } from "react-router-dom";
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
import { useT } from "@/lib/i18n";
import { useApp } from "@/app-context";

/** Vocabulary entries. Used standalone or embedded in 设置 → 词库. */
export function VocabularyPage({ embedded = false }: { embedded?: boolean } = {}) {
  const t = useT();
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
      {t("vocab.add")}
    </Button>
  );

  const content = (
    <>
      {embedded ? (
        <PanelHeader
          status={terms.length ? t("vocab.count", { n: terms.length }) : undefined}
          action={headerAction}
        />
      ) : (
        <PageHeader
          title={t("vocab.title")}
          status={terms.length ? t("vocab.count", { n: terms.length }) : undefined}
          action={headerAction}
        />
      )}

      <p className="type-meta text-muted mb-1 px-1">
        {t("vocab.descPrefix")}{" "}
        <Link to="/settings?tab=refine" className="text-accent-soft-foreground hover:underline">
          {t("vocab.descLink")}
        </Link>
      </p>

      <SoftCollapse open={addOpen}>
        <div className="surface-card mb-1 flex items-end gap-2 p-4">
          <TextField
            fullWidth
            variant="secondary"
            value={newTerm}
            onChange={setNewTerm}
          >
            <Label>{t("vocab.termLabel")}</Label>
            <Input
              placeholder={t("vocab.termPlaceholder")}
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
            {t("vocab.add")}
          </Button>
        </div>
      </SoftCollapse>

      {terms.length === 0 ? (
        <EmptyState title={t("vocab.emptyTitle")} icon={<BookOpen size={18} />} />
      ) : (
        <div className="flex min-h-[200px] flex-wrap content-start gap-2">
          {terms.map((term, i) => (
            <Reveal key={term} index={i}>
              <Button
                variant="ghost"
                className="group h-auto min-h-0 p-0 shadow-none"
                aria-label={t("vocab.deleteAria", { term })}
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
