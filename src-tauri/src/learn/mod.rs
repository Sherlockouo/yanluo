//! 纠错学习自动闭环 — 独立知识库模块
//!
//! 自动从 HUD/出稿页/历史页编辑中提取纠错候选，持久化为 `learn-knowledge.json`，
//! 并在转写时通过确定性替换和 refine few-shot 注入生效。

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::sync::Mutex;

use crate::config::app_data_dir;

pub(crate) mod diff;

pub(crate) use diff::extract_correction_pairs;

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct CorrectionPair {
    pub(crate) id: String,
    pub(crate) wrong: String,
    pub(crate) right: String,
    /// "auto_hud" | "auto_draft" | "manual" | "ai_distill"
    pub(crate) source: String,
    /// 0.0–1.0
    pub(crate) confidence: f32,
    /// diff 中出现次数（频率门控）
    pub(crate) occurrence_count: u32,
    /// 实际替换命中次数
    pub(crate) hit_count: u32,
    pub(crate) enabled: bool,
    pub(crate) created_at: String,
    pub(crate) last_seen_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct LearnKnowledge {
    pub(crate) pairs: Vec<CorrectionPair>,
    pub(crate) version: u32,
}

impl Default for LearnKnowledge {
    fn default() -> Self {
        Self {
            pairs: Vec::new(),
            version: 1,
        }
    }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

fn knowledge_path() -> std::path::PathBuf {
    app_data_dir().join("learn-knowledge.json")
}

pub(crate) fn load_knowledge_from_disk() -> LearnKnowledge {
    fs::read_to_string(knowledge_path())
        .ok()
        .and_then(|data| serde_json::from_str(&data).ok())
        .unwrap_or_default()
}

pub(crate) fn save_knowledge_to_disk(knowledge: &LearnKnowledge) -> Result<(), String> {
    fs::create_dir_all(app_data_dir()).map_err(|e| e.to_string())?;
    let data = serde_json::to_string_pretty(knowledge).map_err(|e| e.to_string())?;
    fs::write(knowledge_path(), data).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Knowledge state (held in AsrEngine alongside config/history)
// ---------------------------------------------------------------------------

pub(crate) struct LearnState {
    pub(crate) knowledge: Mutex<LearnKnowledge>,
    /// Accumulated hit_count increments to flush at end of transcription.
    pub(crate) pending_hits: Mutex<Vec<(String, u32)>>,
}

impl LearnState {
    pub(crate) fn new() -> Self {
        let mut knowledge = load_knowledge_from_disk();
        // Migration: import existing config.vocabulary pairs on first load
        // (done externally in AsrEngine::new after config is loaded)
        if knowledge.version == 0 {
            knowledge.version = 1;
        }
        Self {
            knowledge: Mutex::new(knowledge),
            pending_hits: Mutex::new(Vec::new()),
        }
    }

    /// Migrate vocab pairs from config.vocabulary into knowledge base.
    /// Called once at startup. Only imports pairs (wrong=right), not plain terms.
    pub(crate) fn migrate_from_vocabulary(&self, vocabulary: &[String]) {
        let mut kb = match self.knowledge.lock() {
            Ok(kb) => kb,
            Err(_) => return,
        };
        let existing: HashSet<(String, String)> = kb
            .pairs
            .iter()
            .map(|p| (p.wrong.clone(), p.right.clone()))
            .collect();

        let now = chrono::Utc::now().to_rfc3339();
        for raw in vocabulary {
            let term = raw.trim();
            if term.is_empty() {
                continue;
            }
            let pair_opt = term
                .split_once('=')
                .or_else(|| term.split_once('→'))
                .or_else(|| term.split_once("->"));
            if let Some((wrong, right)) = pair_opt {
                let w = wrong.trim().to_string();
                let r = right.trim().to_string();
                if w.is_empty() || r.is_empty() {
                    continue;
                }
                if existing.contains(&(w.clone(), r.clone())) {
                    continue;
                }
                kb.pairs.push(CorrectionPair {
                    id: generate_pair_id(),
                    wrong: w,
                    right: r,
                    source: "manual".into(),
                    confidence: 1.0,
                    occurrence_count: 1,
                    hit_count: 0,
                    enabled: true,
                    created_at: now.clone(),
                    last_seen_at: now.clone(),
                });
            }
        }
        let _ = save_knowledge_to_disk(&kb);
    }

    /// Upsert a correction pair. Dedup by (wrong, right).
    /// Returns the pair id.
    pub(crate) fn upsert_pair(
        &self,
        wrong: &str,
        right: &str,
        source: &str,
        confidence: f32,
    ) -> Option<String> {
        let mut kb = self.knowledge.lock().ok()?;
        let now = chrono::Utc::now().to_rfc3339();

        // Find existing
        if let Some(existing) = kb
            .pairs
            .iter_mut()
            .find(|p| p.wrong == wrong && p.right == right)
        {
            existing.occurrence_count += 1;
            existing.last_seen_at = now;
            // Boost confidence on re-occurrence (cap at 1.0)
            existing.confidence = (existing.confidence + 0.1).min(1.0);
            let id = existing.id.clone();
            let _ = save_knowledge_to_disk(&kb);
            return Some(id);
        }

        // New pair
        let id = generate_pair_id();
        kb.pairs.push(CorrectionPair {
            id: id.clone(),
            wrong: wrong.to_string(),
            right: right.to_string(),
            source: source.to_string(),
            confidence,
            occurrence_count: 1,
            hit_count: 0,
            enabled: true,
            created_at: now.clone(),
            last_seen_at: now,
        });

        // Capacity limit: 500 pairs max, evict lowest confidence*recency
        enforce_capacity(&mut kb);
        let _ = save_knowledge_to_disk(&kb);
        Some(id)
    }

    /// Get pairs eligible for deterministic replacement:
    /// occurrence_count >= 2, confidence >= 0.6, enabled
    pub(crate) fn deterministic_pairs(&self) -> Vec<(String, String)> {
        let kb = match self.knowledge.lock() {
            Ok(kb) => kb,
            Err(_) => return Vec::new(),
        };
        kb.pairs
            .iter()
            .filter(|p| p.enabled && p.occurrence_count >= 2 && p.confidence >= 0.6)
            .map(|p| (p.wrong.clone(), p.right.clone()))
            .collect()
    }

    /// Get all enabled pairs for few-shot injection.
    pub(crate) fn all_enabled_pairs(&self) -> Vec<CorrectionPair> {
        let kb = match self.knowledge.lock() {
            Ok(kb) => kb,
            Err(_) => return Vec::new(),
        };
        kb.pairs.iter().filter(|p| p.enabled).cloned().collect()
    }

    /// Record a hit (replacement applied). Batched — flush later.
    pub(crate) fn record_hit(&self, wrong: &str, right: &str) {
        if let Ok(mut hits) = self.pending_hits.lock() {
            // Use wrong=right as key
            let key = format!("{}={}", wrong, right);
            if let Some(entry) = hits.iter_mut().find(|(k, _)| k == &key) {
                entry.1 += 1;
            } else {
                hits.push((key, 1));
            }
        }
    }

    /// Flush pending hits to knowledge base. Call after transcription completes.
    pub(crate) fn flush_hits(&self) {
        let pending = {
            let mut hits = match self.pending_hits.lock() {
                Ok(h) => h,
                Err(_) => return,
            };
            std::mem::take(&mut *hits)
        };
        if pending.is_empty() {
            return;
        }
        let mut kb = match self.knowledge.lock() {
            Ok(kb) => kb,
            Err(_) => return,
        };
        for (key, count) in pending {
            // key is "wrong=right"
            if let Some(idx) = key.find('=') {
                let wrong = &key[..idx];
                let right = &key[idx + 1..];
                if let Some(pair) = kb
                    .pairs
                    .iter_mut()
                    .find(|p| p.wrong == wrong && p.right == right)
                {
                    pair.hit_count += count;
                }
            }
        }
        let _ = save_knowledge_to_disk(&kb);
    }

    /// Get full knowledge for management UI.
    pub(crate) fn get_knowledge(&self) -> LearnKnowledge {
        self.knowledge
            .lock()
            .map(|kb| kb.clone())
            .unwrap_or_default()
    }

    /// Toggle enabled state.
    pub(crate) fn set_pair_enabled(&self, id: &str, enabled: bool) -> Result<(), String> {
        let mut kb = self.knowledge.lock().map_err(|e| e.to_string())?;
        let pair = kb
            .pairs
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or_else(|| "pair not found".to_string())?;
        pair.enabled = enabled;
        save_knowledge_to_disk(&kb)
    }

    /// Delete a pair.
    pub(crate) fn delete_pair(&self, id: &str) -> Result<(), String> {
        let mut kb = self.knowledge.lock().map_err(|e| e.to_string())?;
        let len_before = kb.pairs.len();
        kb.pairs.retain(|p| p.id != id);
        if kb.pairs.len() == len_before {
            return Err("pair not found".into());
        }
        save_knowledge_to_disk(&kb)
    }
}

// ---------------------------------------------------------------------------
// Relevance matching for few-shot injection
// ---------------------------------------------------------------------------

/// Select the most relevant pairs for the current ASR text.
/// Returns formatted pair lines + optional sentence few-shot supplement.
pub(crate) fn select_relevant_pairs<'a>(
    text: &str,
    all_pairs: &'a [CorrectionPair],
    max_pairs: usize,
) -> Vec<&'a CorrectionPair> {
    if text.is_empty() || all_pairs.is_empty() {
        return Vec::new();
    }

    let mut scored: Vec<(usize, f32)> = Vec::with_capacity(all_pairs.len());
    let text_lower = text.to_lowercase();

    for (idx, pair) in all_pairs.iter().enumerate() {
        // Substring match = highest relevance
        if text_lower.contains(&pair.wrong.to_lowercase()) {
            scored.push((idx, 100.0));
            continue;
        }
        // Bigram overlap scoring
        let overlap = bigram_overlap(&pair.wrong, text);
        if overlap > 0.0 {
            scored.push((idx, overlap));
        }
    }

    // Sort by score descending
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(max_pairs);

    scored.iter().map(|(idx, _)| &all_pairs[*idx]).collect()
}

/// Build the compact pair list for refine prompt injection.
/// Format:
/// ```text
/// 纠错习惯（按此修正）：
/// 配森 → Python
/// 太极 → TypeScript
/// ```
pub(crate) fn build_pair_fewshot_block(pairs: &[&CorrectionPair]) -> String {
    if pairs.is_empty() {
        return String::new();
    }
    let mut lines: Vec<String> = Vec::with_capacity(pairs.len());
    for p in pairs {
        lines.push(format!("{} → {}", p.wrong, p.right));
    }
    format!("纠错习惯（按此修正）：\n{}", lines.join("\n"))
}

/// Select relevant sentence-level few-shot cases using bigram overlap.
/// Returns top N cases sorted by relevance.
pub(crate) fn select_relevant_sentence_cases<'a>(
    text: &str,
    cases: &'a [crate::transcription::FewShotCase],
    max_cases: usize,
) -> Vec<&'a crate::transcription::FewShotCase> {
    if text.is_empty() || cases.is_empty() || max_cases == 0 {
        return Vec::new();
    }

    let mut scored: Vec<(usize, f32)> = Vec::with_capacity(cases.len());
    for (idx, case) in cases.iter().enumerate() {
        let overlap = bigram_overlap(&case.asr, text);
        if overlap > 0.0 {
            scored.push((idx, overlap));
        }
    }

    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(max_cases);

    scored.iter().map(|(idx, _)| &cases[*idx]).collect()
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize)]
pub(crate) struct LearnStats {
    pub(crate) total_pairs: usize,
    pub(crate) enabled_pairs: usize,
    pub(crate) deterministic_pairs: usize,
    pub(crate) total_hits: u64,
    pub(crate) week_hits: u64,
    pub(crate) top_sources: Vec<(String, usize)>,
    /// Top pairs by hit_count (for the settings dashboard).
    pub(crate) top_pairs: Vec<TopPairInfo>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct TopPairInfo {
    pub(crate) wrong: String,
    pub(crate) right: String,
    pub(crate) hit_count: u32,
}

pub(crate) fn compute_stats(knowledge: &LearnKnowledge) -> LearnStats {
    let total_pairs = knowledge.pairs.len();
    let enabled_pairs = knowledge.pairs.iter().filter(|p| p.enabled).count();
    let deterministic_pairs = knowledge
        .pairs
        .iter()
        .filter(|p| p.enabled && p.occurrence_count >= 2 && p.confidence >= 0.6)
        .count();
    let total_hits: u64 = knowledge.pairs.iter().map(|p| p.hit_count as u64).sum();

    // Week hits: pairs whose last_seen_at is within 7 days
    let week_ago = chrono::Utc::now() - chrono::Duration::days(7);
    let week_hits: u64 = knowledge
        .pairs
        .iter()
        .filter(|p| {
            chrono::DateTime::parse_from_rfc3339(&p.last_seen_at)
                .map(|dt| dt > week_ago)
                .unwrap_or(false)
        })
        .map(|p| p.hit_count as u64)
        .sum();

    // Source breakdown
    let mut source_counts: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    for p in &knowledge.pairs {
        *source_counts.entry(p.source.clone()).or_insert(0) += 1;
    }
    let mut top_sources: Vec<(String, usize)> = source_counts.into_iter().collect();
    top_sources.sort_by(|a, b| b.1.cmp(&a.1));

    // Top pairs by hit_count (enabled only), for the dashboard
    let mut by_hits: Vec<&CorrectionPair> = knowledge.pairs.iter().filter(|p| p.enabled).collect();
    by_hits.sort_by(|a, b| b.hit_count.cmp(&a.hit_count));
    let top_pairs: Vec<TopPairInfo> = by_hits
        .into_iter()
        .take(5)
        .map(|p| TopPairInfo {
            wrong: p.wrong.clone(),
            right: p.right.clone(),
            hit_count: p.hit_count,
        })
        .collect();

    LearnStats {
        total_pairs,
        enabled_pairs,
        deterministic_pairs,
        total_hits,
        week_hits,
        top_sources,
        top_pairs,
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Character bigram overlap between two strings (Dice coefficient).
pub(crate) fn bigram_overlap(a: &str, b: &str) -> f32 {
    let bigrams_a = char_bigrams(a);
    let bigrams_b = char_bigrams(b);
    if bigrams_a.is_empty() || bigrams_b.is_empty() {
        return 0.0;
    }
    let set_a: HashSet<&(char, char)> = bigrams_a.iter().collect();
    let set_b: HashSet<&(char, char)> = bigrams_b.iter().collect();
    let intersection = set_a.intersection(&set_b).count();
    (2.0 * intersection as f32) / (set_a.len() + set_b.len()) as f32
}

fn char_bigrams(s: &str) -> Vec<(char, char)> {
    let chars: Vec<char> = s.chars().filter(|c| !c.is_whitespace()).collect();
    if chars.len() < 2 {
        return Vec::new();
    }
    chars.windows(2).map(|w| (w[0], w[1])).collect()
}

fn generate_pair_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    // Add random suffix to avoid collision
    let rand: u32 = (ts as u32).wrapping_mul(1103515245).wrapping_add(12345) >> 16;
    format!("lp-{}-{:04x}", ts, rand & 0xFFFF)
}

const MAX_PAIRS_CAPACITY: usize = 500;

/// Evict lowest-scoring pairs when over capacity.
fn enforce_capacity(kb: &mut LearnKnowledge) {
    if kb.pairs.len() <= MAX_PAIRS_CAPACITY {
        return;
    }
    // Score = confidence * recency_factor
    let now = chrono::Utc::now();
    let mut scored: Vec<(usize, f32)> = kb
        .pairs
        .iter()
        .enumerate()
        .map(|(idx, p)| {
            let age_days = chrono::DateTime::parse_from_rfc3339(&p.last_seen_at)
                .map(|dt| (now - dt.with_timezone(&chrono::Utc)).num_days().max(0) as f32)
                .unwrap_or(365.0);
            let recency = 1.0 / (1.0 + age_days / 30.0);
            (idx, p.confidence * recency)
        })
        .collect();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    // Keep top MAX_PAIRS_CAPACITY
    let keep_indices: HashSet<usize> = scored
        .iter()
        .take(MAX_PAIRS_CAPACITY)
        .map(|(idx, _)| *idx)
        .collect();
    let mut idx = 0;
    kb.pairs.retain(|_| {
        let keep = keep_indices.contains(&idx);
        idx += 1;
        keep
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bigram_overlap() {
        // Identical strings should have overlap = 1.0
        let score = bigram_overlap("Python", "Python");
        assert!((score - 1.0).abs() < 0.001);

        // Completely different
        let score = bigram_overlap("abc", "xyz");
        assert_eq!(score, 0.0);

        // Partial overlap
        let score = bigram_overlap("配森", "我用配森写代码");
        assert!(score > 0.0);
    }

    #[test]
    fn test_select_relevant_pairs() {
        let pairs = vec![
            CorrectionPair {
                id: "1".into(),
                wrong: "配森".into(),
                right: "Python".into(),
                source: "auto_hud".into(),
                confidence: 0.85,
                occurrence_count: 3,
                hit_count: 5,
                enabled: true,
                created_at: "2026-01-01T00:00:00Z".into(),
                last_seen_at: "2026-01-01T00:00:00Z".into(),
            },
            CorrectionPair {
                id: "2".into(),
                wrong: "太极".into(),
                right: "TypeScript".into(),
                source: "auto_hud".into(),
                confidence: 0.8,
                occurrence_count: 2,
                hit_count: 2,
                enabled: true,
                created_at: "2026-01-01T00:00:00Z".into(),
                last_seen_at: "2026-01-01T00:00:00Z".into(),
            },
            CorrectionPair {
                id: "3".into(),
                wrong: "瑞思特".into(),
                right: "Rust".into(),
                source: "manual".into(),
                confidence: 1.0,
                occurrence_count: 1,
                hit_count: 0,
                enabled: true,
                created_at: "2026-01-01T00:00:00Z".into(),
                last_seen_at: "2026-01-01T00:00:00Z".into(),
            },
        ];

        // Text contains "配森" → should be selected first (substring match)
        let text = "我用配森写了一个程序";
        let selected = select_relevant_pairs(text, &pairs, 12);
        assert!(!selected.is_empty());
        assert_eq!(selected[0].wrong, "配森");
    }

    #[test]
    fn test_enforce_capacity() {
        let mut kb = LearnKnowledge {
            pairs: Vec::new(),
            version: 1,
        };
        let now = chrono::Utc::now().to_rfc3339();
        for i in 0..510 {
            kb.pairs.push(CorrectionPair {
                id: format!("p-{}", i),
                wrong: format!("wrong{}", i),
                right: format!("right{}", i),
                source: "test".into(),
                confidence: if i < 500 { 0.5 } else { 0.1 },
                occurrence_count: 1,
                hit_count: 0,
                enabled: true,
                created_at: now.clone(),
                last_seen_at: now.clone(),
            });
        }
        enforce_capacity(&mut kb);
        assert!(kb.pairs.len() <= MAX_PAIRS_CAPACITY);
    }
}
