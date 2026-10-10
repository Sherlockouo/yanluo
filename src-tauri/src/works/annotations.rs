//! Works annotations (原文批注): highlights and comments anchored to transcript
//! word indices. `annotations.json` is the source of truth; `mem.md` is
//! re-rendered from it on every change so the folder stays shareable.

use serde::{Deserialize, Serialize};

use super::{atomic_write, format_anchor, resolve_work_dir, write_json};
use crate::config::AppConfig;

pub(crate) const KIND_HIGHLIGHT: &str = "highlight";
pub(crate) const KIND_COMMENT: &str = "comment";
const HIGHLIGHT_COLORS: [&str; 4] = ["yellow", "green", "blue", "pink"];

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct Annotation {
    pub(crate) id: String,
    /// "highlight" | "comment"
    pub(crate) kind: String,
    /// Highlight colour (empty for pure comments).
    #[serde(default)]
    pub(crate) color: String,
    /// Selected original text.
    pub(crate) quote: String,
    /// Inclusive range over the timed transcript's word indices.
    pub(crate) word_start: usize,
    pub(crate) word_end: usize,
    pub(crate) start_time: f64,
    /// Comment body (comments only; may be empty for highlights).
    #[serde(default)]
    pub(crate) text: String,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct AnnotationDraft {
    pub(crate) kind: String,
    #[serde(default)]
    pub(crate) color: String,
    pub(crate) quote: String,
    pub(crate) word_start: usize,
    pub(crate) word_end: usize,
    pub(crate) start_time: f64,
    #[serde(default)]
    pub(crate) text: String,
}

#[derive(Default, Serialize, Deserialize)]
struct AnnotationFile {
    #[serde(default)]
    items: Vec<Annotation>,
}

fn annotations_path(dir: &std::path::Path) -> std::path::PathBuf {
    dir.join("annotations.json")
}

fn load_items(dir: &std::path::Path) -> Result<Vec<Annotation>, String> {
    let path = annotations_path(dir);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("读取批注失败: {e}"))?;
    let file: AnnotationFile =
        serde_json::from_str(&raw).map_err(|e| format!("解析批注失败: {e}"))?;
    Ok(file.items)
}

/// Persist annotations and refresh `mem.md`. Caller holds no state locks.
fn save_items(dir: &std::path::Path, title: &str, items: &[Annotation]) -> Result<(), String> {
    write_json(
        &annotations_path(dir),
        &AnnotationFile {
            items: items.to_vec(),
        },
    )?;
    atomic_write(
        &dir.join("mem.md"),
        render_mem_md(title, items).as_bytes(),
    )
}

pub(crate) fn list(config: &AppConfig, work_id: &str) -> Result<Vec<Annotation>, String> {
    let (dir, _) = resolve_work_dir(config, work_id)?;
    load_items(&dir)
}

pub(crate) fn add(
    config: &AppConfig,
    work_id: &str,
    draft: AnnotationDraft,
) -> Result<Annotation, String> {
    validate(&draft)?;
    let (dir, work) = resolve_work_dir(config, work_id)?;
    let mut items = load_items(&dir)?;
    let now = chrono::Utc::now().to_rfc3339();
    let annotation = Annotation {
        id: format!("a{}", chrono::Utc::now().timestamp_millis()),
        kind: draft.kind.clone(),
        color: if draft.kind == KIND_HIGHLIGHT {
            draft.color.clone()
        } else {
            String::new()
        },
        quote: draft.quote.trim().to_string(),
        word_start: draft.word_start,
        word_end: draft.word_end,
        start_time: draft.start_time.max(0.0),
        text: draft.text.trim().to_string(),
        created_at: now.clone(),
        updated_at: now,
    };
    items.push(annotation.clone());
    save_items(&dir, &work.title, &items)?;
    Ok(annotation)
}

/// Edit a comment body or a highlight colour. Fields left as None are kept.
pub(crate) fn update(
    config: &AppConfig,
    work_id: &str,
    annotation_id: &str,
    text: Option<String>,
    color: Option<String>,
) -> Result<(), String> {
    let (dir, work) = resolve_work_dir(config, work_id)?;
    let mut items = load_items(&dir)?;
    let item = items
        .iter_mut()
        .find(|a| a.id == annotation_id)
        .ok_or_else(|| "批注不存在".to_string())?;
    if let Some(text) = text {
        if item.kind != KIND_COMMENT {
            return Err("只有评论可以编辑正文".into());
        }
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Err("评论内容为空".into());
        }
        item.text = trimmed.to_string();
    }
    if let Some(color) = color {
        if item.kind != KIND_HIGHLIGHT || !HIGHLIGHT_COLORS.contains(&color.as_str()) {
            return Err("无效的高亮颜色".into());
        }
        item.color = color;
    }
    item.updated_at = chrono::Utc::now().to_rfc3339();
    save_items(&dir, &work.title, &items)
}

pub(crate) fn delete(config: &AppConfig, work_id: &str, annotation_id: &str) -> Result<(), String> {
    let (dir, work) = resolve_work_dir(config, work_id)?;
    let mut items = load_items(&dir)?;
    let before = items.len();
    items.retain(|a| a.id != annotation_id);
    if items.len() == before {
        return Err("批注不存在".into());
    }
    save_items(&dir, &work.title, &items)
}

fn validate(draft: &AnnotationDraft) -> Result<(), String> {
    if draft.quote.trim().is_empty() {
        return Err("选中的原文为空".into());
    }
    if draft.word_start > draft.word_end {
        return Err("无效的选区范围".into());
    }
    match draft.kind.as_str() {
        KIND_HIGHLIGHT => {
            if !HIGHLIGHT_COLORS.contains(&draft.color.as_str()) {
                return Err("无效的高亮颜色".into());
            }
        }
        KIND_COMMENT => {
            if draft.text.trim().is_empty() {
                return Err("评论内容为空".into());
            }
        }
        _ => return Err("未知的批注类型".into()),
    }
    Ok(())
}

fn color_label(color: &str) -> &'static str {
    match color {
        "green" => "绿色",
        "blue" => "蓝色",
        "pink" => "粉色",
        _ => "黄色",
    }
}

/// Render `mem.md`: 原文 + 评论 and 原文 + 高亮, both ordered by playback time.
pub(crate) fn render_mem_md(title: &str, items: &[Annotation]) -> String {
    let mut sorted: Vec<&Annotation> = items.iter().collect();
    sorted.sort_by(|a, b| {
        a.start_time
            .total_cmp(&b.start_time)
            .then(a.word_start.cmp(&b.word_start))
    });
    let quote_block = |quote: &str| {
        quote
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    };

    let mut out = format!("# {title}\n\n");

    out.push_str("## 原文 + 评论\n\n");
    let mut any = false;
    for a in sorted.iter().filter(|a| a.kind == KIND_COMMENT) {
        any = true;
        out.push_str(&format!(
            "### [{}]\n\n> {}\n\n{}\n\n",
            format_anchor(a.start_time),
            quote_block(&a.quote),
            a.text.trim()
        ));
    }
    if !any {
        out.push_str("_暂无评论_\n\n");
    }

    out.push_str("## 原文 + 高亮\n\n");
    let mut any = false;
    for a in sorted.iter().filter(|a| a.kind == KIND_HIGHLIGHT) {
        any = true;
        out.push_str(&format!(
            "### [{}] · {}高亮\n\n> {}\n\n",
            format_anchor(a.start_time),
            color_label(&a.color),
            quote_block(&a.quote)
        ));
    }
    if !any {
        out.push_str("_暂无高亮_\n");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, kind: &str, color: &str, start: f64, quote: &str, text: &str) -> Annotation {
        Annotation {
            id: id.into(),
            kind: kind.into(),
            color: color.into(),
            quote: quote.into(),
            word_start: 0,
            word_end: 0,
            start_time: start,
            text: text.into(),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn mem_md_splits_comments_and_highlights_by_time() {
        let items = vec![
            item("b", KIND_HIGHLIGHT, "green", 13.0, "第二句", ""),
            item("a", KIND_COMMENT, "", 65.0, "第一句\n换行", "这里有疑问"),
            item("c", KIND_HIGHLIGHT, "yellow", 5.0, "开头", ""),
        ];
        let md = render_mem_md("产品评审", &items);
        assert!(md.starts_with("# 产品评审\n"));
        assert!(md.contains("## 原文 + 评论\n\n### [01:05]\n\n> 第一句 换行\n\n这里有疑问"));
        let yellow = md.find("[00:05] · 黄色高亮").unwrap();
        let green = md.find("[00:13] · 绿色高亮").unwrap();
        assert!(yellow < green);
    }

    #[test]
    fn mem_md_marks_empty_sections() {
        let md = render_mem_md("空", &[]);
        assert!(md.contains("_暂无评论_"));
        assert!(md.contains("_暂无高亮_"));
    }

    #[test]
    fn draft_validation_rules() {
        let base = AnnotationDraft {
            kind: KIND_HIGHLIGHT.into(),
            color: "yellow".into(),
            quote: "原文".into(),
            word_start: 0,
            word_end: 1,
            start_time: 0.0,
            text: String::new(),
        };
        assert!(validate(&base).is_ok());
        assert!(validate(&AnnotationDraft { color: "red".into(), ..base.clone() }).is_err());
        assert!(validate(&AnnotationDraft { quote: "  ".into(), ..base.clone() }).is_err());
        assert!(validate(&AnnotationDraft { word_start: 3, word_end: 1, ..base.clone() }).is_err());
        assert!(validate(&AnnotationDraft {
            kind: KIND_COMMENT.into(),
            color: String::new(),
            text: " ".into(),
            ..base
        })
        .is_err());
    }
}
