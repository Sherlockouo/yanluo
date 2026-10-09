import { useState } from "react";
import { Link } from "react-router-dom";
import { Button, Input, Label, TextField } from "@heroui/react";
import { BookOpen, Pencil, Plus, Trash2 } from "lucide-react";
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
import {
  parseVocabularyEntry,
  validateVocabularyDraft,
  type VocabularyError,
} from "@/lib/vocabulary";

/** Vocabulary entries. Used standalone or embedded in 设置 → 词库. */
export function VocabularyPage({ embedded = false }: { embedded?: boolean } = {}) {
  const t = useT();
  const { config, saveVocabulary } = useApp();
  const [addOpen, setAddOpen] = useState(config.vocabulary.length === 0);
  const [standard, setStandard] = useState("");
  const [alias, setAlias] = useState("");
  const [editingIndex, setEditingIndex] = useState(-1);
  const [error, setError] = useState<VocabularyError | "saveFailed" | null>(null);
  const terms = config.vocabulary;

  const resetForm = () => {
    setStandard("");
    setAlias("");
    setEditingIndex(-1);
    setError(null);
  };

  const startEdit = (index: number) => {
    const draft = parseVocabularyEntry(terms[index]);
    setStandard(draft.standard);
    setAlias(draft.alias);
    setEditingIndex(index);
    setError(null);
    setAddOpen(true);
  };

  const saveDraft = async () => {
    const checked = validateVocabularyDraft({ standard, alias }, terms, editingIndex);
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    const next = [...terms];
    if (editingIndex >= 0) next[editingIndex] = checked.entry;
    else next.unshift(checked.entry);
    try {
      await saveVocabulary(next);
      resetForm();
      setAddOpen(false);
    } catch {
      setError("saveFailed");
    }
  };

  const remove = async (index: number) => {
    try {
      await saveVocabulary(terms.filter((_, i) => i !== index));
      if (editingIndex === index) resetForm();
    } catch {
      setError("saveFailed");
    }
  };

  const headerAction = (
    <Button
      size="sm"
      variant="secondary"
      onPress={() => {
        if (addOpen) resetForm();
        setAddOpen((v) => !v);
      }}
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
        {t("vocab.descPrefix")} {" "}
        <Link to="/settings?tab=refine" className="text-accent-soft-foreground hover:underline">
          {t("vocab.descLink")}
        </Link>
      </p>
      <p className="type-meta text-muted mb-1 px-1">{t("vocab.engineHint")}</p>

      <SoftCollapse open={addOpen}>
        <div className="surface-card mb-1 grid gap-3 p-4 sm:grid-cols-2">
          <TextField fullWidth variant="secondary" value={standard} onChange={(value) => {
            setStandard(value);
            setError(null);
          }}>
            <Label>{t("vocab.standardLabel")}</Label>
            <Input
              placeholder={t("vocab.standardPlaceholder")}
              aria-invalid={Boolean(error)}
              onKeyDown={(e) => { if (e.key === "Enter") void saveDraft(); }}
            />
          </TextField>
          <TextField fullWidth variant="secondary" value={alias} onChange={(value) => {
            setAlias(value);
            setError(null);
          }}>
            <Label>{t("vocab.aliasLabel")}</Label>
            <Input
              placeholder={t("vocab.aliasPlaceholder")}
              aria-invalid={Boolean(error)}
              onKeyDown={(e) => { if (e.key === "Enter") void saveDraft(); }}
            />
          </TextField>
          {error ? (
            <p role="alert" className="type-meta text-danger sm:col-span-2">
              {t(`vocab.error.${error}`)}
            </p>
          ) : null}
          <div className="flex justify-end gap-2 sm:col-span-2">
            {editingIndex >= 0 ? (
              <Button size="sm" variant="ghost" onPress={resetForm}>{t("vocab.cancel")}</Button>
            ) : null}
            <Button size="sm" variant="primary" className="btn-press" onPress={() => void saveDraft()}>
              {editingIndex >= 0 ? null : <Plus size={16} />}
              {editingIndex >= 0 ? t("vocab.save") : t("vocab.add")}
            </Button>
          </div>
        </div>
      </SoftCollapse>

      {terms.length === 0 ? (
        <EmptyState title={t("vocab.emptyTitle")} icon={<BookOpen size={18} />} />
      ) : (
        <div className="flex min-h-[200px] flex-col gap-2">
          {terms.map((term, i) => {
            const parsed = parseVocabularyEntry(term);
            return (
              <Reveal key={term} index={i}>
                <div className="surface-card flex items-center justify-between gap-3 px-4 py-3 transition-colors duration-150 hover:bg-[color-mix(in_oklab,var(--foreground)_2.5%,var(--surface))]">
                  <div className="min-w-0">
                    <div className="type-ui truncate">{parsed.standard}</div>
                    <div className="type-meta text-muted truncate">
                      {parsed.alias ? `${parsed.alias} → ${parsed.standard}` : t("vocab.standardOnly")}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button isIconOnly size="sm" variant="ghost" className="text-muted transition-colors hover:text-foreground data-[hovered=true]:text-foreground" aria-label={t("vocab.editAria", { term })} onPress={() => startEdit(i)}>
                      <Pencil size={14} />
                    </Button>
                    <Button isIconOnly size="sm" variant="ghost" className="text-muted transition-colors hover:text-danger data-[hovered=true]:text-danger" aria-label={t("vocab.deleteAria", { term })} onPress={() => void remove(i)}>
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </div>
              </Reveal>
            );
          })}
        </div>
      )}
    </>
  );

  if (embedded) return content;
  return <PageShell className="max-w-2xl">{content}</PageShell>;
}
