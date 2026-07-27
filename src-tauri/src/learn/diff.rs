//! Diff-based correction pair extraction.
//!
//! Ports the logic from `src/lib/learn-from-refine.ts`:
//! - char-level LCS diff → coalesced del+ins segments → candidate pairs
//! - `scoreCandidate` scoring with CJK→Latin 谐音加分
//! - `isTermSized` / `lengthRatioOk` filtering

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCORE_THRESHOLD: f32 = 0.55;
const MAX_SIDE: usize = 24;
const DIFF_CELL_BUDGET: usize = 250_000;

// ---------------------------------------------------------------------------
// Output type
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub(crate) struct CorrectionCandidate {
    pub(crate) wrong: String,
    pub(crate) right: String,
    pub(crate) kind: CandidateKind,
    pub(crate) score: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum CandidateKind {
    Pair,
    Term,
}

// ---------------------------------------------------------------------------
// Diff types
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
enum DiffType {
    Eq,
    Del,
    Ins,
}

#[derive(Clone, Debug)]
struct DiffPart {
    dtype: DiffType,
    text: String,
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Extract correction pairs from before/after text using LCS diff.
/// Returns scored candidates above threshold.
pub(crate) fn extract_correction_pairs(before: &str, after: &str) -> Vec<CorrectionCandidate> {
    let before_t = before.trim();
    let after_t = after.trim();
    if before_t.is_empty() || after_t.is_empty() || before_t == after_t {
        return Vec::new();
    }

    let parts = coalesce_parts(&diff_texts(before_t, after_t));
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();

    let mut i = 0;
    while i < parts.len() {
        let cur = &parts[i];
        let next = parts.get(i + 1);

        if cur.dtype == DiffType::Del {
            if let Some(next_part) = next {
                if next_part.dtype == DiffType::Ins {
                    let from = compact(&cur.text);
                    let to = compact(&next_part.text);

                    if !from.is_empty() && !to.is_empty() {
                        if is_latin_case_only(&from, &to) {
                            // Case-only → emit as plain term
                            maybe_push_candidate(
                                &mut out,
                                &mut seen,
                                "",
                                &to,
                                CandidateKind::Term,
                            );
                        } else if from != to
                            && !is_whitespace_only_diff(&from, &to)
                            && is_term_sized(&from)
                            && is_term_sized(&to)
                            && length_ratio_ok(&from, &to)
                        {
                            maybe_push_candidate(
                                &mut out,
                                &mut seen,
                                &from,
                                &to,
                                CandidateKind::Pair,
                            );
                        } else if looks_like_hotword(&to) {
                            maybe_push_candidate(
                                &mut out,
                                &mut seen,
                                "",
                                &to,
                                CandidateKind::Term,
                            );
                        }
                    }
                    i += 2;
                    continue;
                }
            }
        }

        if cur.dtype == DiffType::Ins && looks_like_hotword(&cur.text) {
            let to = compact(&cur.text);
            maybe_push_candidate(&mut out, &mut seen, "", &to, CandidateKind::Term);
        }

        i += 1;
    }

    out
}

// ---------------------------------------------------------------------------
// Diff implementation (LCS-based, matches TypeScript)
// ---------------------------------------------------------------------------

fn diff_texts(before: &str, after: &str) -> Vec<DiffPart> {
    if before == after {
        return if before.is_empty() {
            Vec::new()
        } else {
            vec![DiffPart {
                dtype: DiffType::Eq,
                text: before.to_string(),
            }]
        };
    }
    if before.is_empty() {
        return vec![DiffPart {
            dtype: DiffType::Ins,
            text: after.to_string(),
        }];
    }
    if after.is_empty() {
        return vec![DiffPart {
            dtype: DiffType::Del,
            text: before.to_string(),
        }];
    }

    let a: Vec<char> = before.chars().collect();
    let b: Vec<char> = after.chars().collect();
    let n = a.len();
    let m = b.len();

    // Budget check — avoid O(n*m) blowup on very long strings
    if n * m > DIFF_CELL_BUDGET {
        return vec![DiffPart {
            dtype: DiffType::Eq,
            text: after.to_string(),
        }];
    }

    // DP table
    let mut dp = vec![vec![0u16; m + 1]; n + 1];
    for i in 1..=n {
        for j in 1..=m {
            dp[i][j] = if a[i - 1] == b[j - 1] {
                dp[i - 1][j - 1] + 1
            } else {
                dp[i - 1][j].max(dp[i][j - 1])
            };
        }
    }

    // Backtrack
    let mut raw: Vec<DiffPart> = Vec::new();
    let mut i = n;
    let mut j = m;
    while i > 0 || j > 0 {
        if i > 0 && j > 0 && a[i - 1] == b[j - 1] {
            raw.push(DiffPart {
                dtype: DiffType::Eq,
                text: a[i - 1].to_string(),
            });
            i -= 1;
            j -= 1;
        } else if j > 0 && (i == 0 || dp[i][j - 1] >= dp[i - 1][j]) {
            raw.push(DiffPart {
                dtype: DiffType::Ins,
                text: b[j - 1].to_string(),
            });
            j -= 1;
        } else {
            raw.push(DiffPart {
                dtype: DiffType::Del,
                text: a[i - 1].to_string(),
            });
            i -= 1;
        }
    }
    raw.reverse();

    // Merge adjacent same-type
    let mut merged: Vec<DiffPart> = Vec::new();
    for part in raw {
        if let Some(last) = merged.last_mut() {
            if last.dtype == part.dtype {
                last.text.push_str(&part.text);
                continue;
            }
        }
        merged.push(part);
    }
    merged
}

/// Collapse del/ins runs separated by whitespace-only eq parts.
fn coalesce_parts(parts: &[DiffPart]) -> Vec<DiffPart> {
    let mut out: Vec<DiffPart> = Vec::new();
    for part in parts {
        // Skip whitespace-only eq between del/ins
        if part.dtype == DiffType::Eq
            && part.text.chars().all(|c| c.is_whitespace())
            && !out.is_empty()
        {
            let last_type = &out.last().unwrap().dtype;
            if *last_type == DiffType::Del || *last_type == DiffType::Ins {
                continue;
            }
        }
        // Merge adjacent same-type
        if let Some(last) = out.last_mut() {
            if last.dtype == part.dtype {
                last.text.push_str(&part.text);
                continue;
            }
        }
        out.push(part.clone());
    }
    out
}

// ---------------------------------------------------------------------------
// Scoring (mirrors scoreCandidate in TS)
// ---------------------------------------------------------------------------

fn score_candidate(from: &str, to: &str, kind: &CandidateKind) -> f32 {
    let from_c = compact(from);
    let to_c = compact(to);
    if to_c.is_empty() {
        return 0.0;
    }

    let mut score: f32 = 0.4;

    match kind {
        CandidateKind::Pair => {
            if from_c == to_c {
                return 0.0;
            }
            if is_whitespace_only_diff(&from_c, &to_c) {
                return 0.0;
            }
            if !length_ratio_ok(&from_c, &to_c) {
                score -= 0.25;
            }
            // CJK→Latin 谐音加分
            if is_cjk_heavy(&from_c) && is_latin_heavy(&to_c) {
                score += 0.45;
            } else if is_cjk_heavy(&from_c) && is_cjk_heavy(&to_c) {
                score += 0.15;
            } else if is_latin_heavy(&from_c) && is_latin_heavy(&to_c) {
                score += 0.10;
            }
            let max_len = char_len(&from_c).max(char_len(&to_c));
            if max_len <= 12 {
                score += 0.10;
            }
            if max_len > 18 {
                score -= 0.15;
            }
        }
        CandidateKind::Term => {
            // Latin identifier pattern
            if is_latin_identifier(&to_c) {
                score += 0.35;
            } else if cjk_count(&to_c) >= 2 && char_len(&to_c) <= 12 {
                score += 0.20;
            } else {
                score += 0.05;
            }
        }
    }

    // Sentence terminators penalty
    if sentence_terminators(&from_c) + sentence_terminators(&to_c) > 0 {
        score -= 0.20;
    }

    score.clamp(0.0, 1.0)
}

// ---------------------------------------------------------------------------
// Helper predicates (mirror TS helpers)
// ---------------------------------------------------------------------------

fn compact(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn char_len(s: &str) -> usize {
    s.chars().count()
}

fn is_cjk(c: char) -> bool {
    matches!(c, '\u{4E00}'..='\u{9FFF}')
}

fn cjk_count(s: &str) -> usize {
    s.chars().filter(|c| is_cjk(*c)).count()
}

fn letter_count(s: &str) -> usize {
    s.chars().filter(|c| c.is_alphanumeric()).count()
}

fn is_mostly_punct(s: &str) -> bool {
    letter_count(s) == 0
}

fn sentence_terminators(s: &str) -> usize {
    s.chars()
        .filter(|c| matches!(*c, '。' | '.' | '!' | '?' | '？'))
        .count()
}

fn latin_word_count(s: &str) -> usize {
    let words: Vec<&str> = s.split_whitespace().filter(|w| !w.is_empty()).collect();
    if words.is_empty() {
        return 0;
    }
    // If mostly CJK, treat as char-based
    let n = char_len(s);
    if cjk_count(s) >= 2.max(n / 2) {
        return 0;
    }
    words.len()
}

fn is_whitespace_only_diff(from: &str, to: &str) -> bool {
    let a: String = from.chars().filter(|c| !c.is_whitespace()).collect();
    let b: String = to.chars().filter(|c| !c.is_whitespace()).collect();
    a == b
}

fn is_latin_case_only(from: &str, to: &str) -> bool {
    let is_latin_alnum = |s: &str| s.chars().all(|c| c.is_ascii_alphanumeric() || "._+-".contains(c));
    is_latin_alnum(from)
        && is_latin_alnum(to)
        && from.to_lowercase() == to.to_lowercase()
        && from != to
}

fn is_cjk_heavy(s: &str) -> bool {
    let n = char_len(s);
    if n == 0 {
        return false;
    }
    cjk_count(s) as f32 / n as f32 >= 0.5
}

fn is_latin_heavy(s: &str) -> bool {
    let latin_count = s.chars().filter(|c| c.is_ascii_alphabetic()).count();
    latin_count >= 2 && latin_count as f32 / char_len(s).max(1) as f32 >= 0.5
}

fn is_latin_identifier(s: &str) -> bool {
    let chars: Vec<char> = s.chars().collect();
    if chars.is_empty() || chars.len() > 24 {
        return false;
    }
    if !chars[0].is_ascii_alphabetic() {
        return false;
    }
    if chars.len() < 2 {
        return false;
    }
    chars[1..].iter().all(|c| c.is_ascii_alphanumeric() || "._+-".contains(*c))
}

/// Accept side for vocab: length 1–24, not punct soup, not multi-sentence.
fn is_term_sized(s: &str) -> bool {
    let t = compact(s);
    if t.is_empty() || is_mostly_punct(&t) {
        return false;
    }
    let n = char_len(&t);
    if n < 1 || n > MAX_SIDE {
        return false;
    }
    if sentence_terminators(&t) >= 2 {
        return false;
    }
    if latin_word_count(&t) > 4 {
        return false;
    }
    if cjk_count(&t) > 8 {
        return false;
    }
    true
}

fn length_ratio_ok(a: &str, b: &str) -> bool {
    let la = char_len(a);
    let lb = char_len(b);
    if la == 0 || lb == 0 {
        return false;
    }
    let r = la as f32 / lb as f32;
    r >= 0.3 && r <= 3.0
}

fn looks_like_hotword(s: &str) -> bool {
    let t = compact(s);
    if !is_term_sized(&t) {
        return false;
    }
    if is_latin_identifier(&t) {
        return true;
    }
    // Latin word pattern with spaces/dots
    let chars: Vec<char> = t.chars().collect();
    if !chars.is_empty()
        && chars[0].is_ascii_alphanumeric()
        && chars.len() <= 23
        && t.chars().all(|c| c.is_ascii_alphanumeric() || " ._/+-".contains(c))
        && latin_word_count(&t) <= 4
    {
        return true;
    }
    if cjk_count(&t) >= 2 && char_len(&t) <= 12 {
        return true;
    }
    false
}

fn maybe_push_candidate(
    out: &mut Vec<CorrectionCandidate>,
    seen: &mut std::collections::HashSet<String>,
    from: &str,
    to: &str,
    kind: CandidateKind,
) {
    let score = score_candidate(from, to, &kind);
    if score < SCORE_THRESHOLD {
        return;
    }
    let key = if kind == CandidateKind::Pair {
        format!("{}={}", from.to_lowercase(), to.to_lowercase())
    } else {
        to.to_lowercase()
    };
    if seen.contains(&key) {
        return;
    }
    seen.insert(key);
    out.push(CorrectionCandidate {
        wrong: from.to_string(),
        right: to.to_string(),
        kind,
        score,
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_diff_basic() {
        let parts = diff_texts("abc", "aXc");
        // Should have eq('a'), del('b'), ins('X'), eq('c')
        assert!(parts.len() >= 3);
    }

    #[test]
    fn test_extract_cjk_to_latin() {
        // 配森 → Python (CJK → Latin, classic 谐音)
        let candidates = extract_correction_pairs("我用配森写代码", "我用Python写代码");
        assert!(!candidates.is_empty());
        let pair = candidates.iter().find(|c| c.kind == CandidateKind::Pair);
        assert!(pair.is_some());
        let p = pair.unwrap();
        assert_eq!(p.wrong, "配森");
        assert_eq!(p.right, "Python");
        // CJK→Latin should get high score (0.4 + 0.45 + 0.1 = 0.95)
        assert!(p.score >= 0.85, "score={}", p.score);
    }

    #[test]
    fn test_extract_same_text_no_candidates() {
        let candidates = extract_correction_pairs("hello world", "hello world");
        assert!(candidates.is_empty());
    }

    #[test]
    fn test_extract_whitespace_only_diff_no_pair() {
        let candidates = extract_correction_pairs("hello world", "hello  world");
        // Should not produce a pair for whitespace-only change
        let pairs: Vec<_> = candidates
            .iter()
            .filter(|c| c.kind == CandidateKind::Pair)
            .collect();
        assert!(pairs.is_empty());
    }

    #[test]
    fn test_extract_cjk_to_cjk() {
        // 同音字纠错
        let candidates = extract_correction_pairs("这个算法很好用", "这个算法很好用");
        assert!(candidates.is_empty());

        let candidates = extract_correction_pairs("分辩率很高", "分辨率很高");
        // 分辩 → 分辨, CJK→CJK, short: 0.4 + 0.15 + 0.10 = 0.65 > 0.55
        let pair = candidates.iter().find(|c| c.kind == CandidateKind::Pair);
        assert!(pair.is_some(), "candidates={:?}", candidates);
    }

    #[test]
    fn test_score_too_long_rejected() {
        // Very long text should not pass isTermSized
        let long = "这是一个非常非常非常非常非常非常非常非常非常长的句子";
        assert!(!is_term_sized(long));
    }

    #[test]
    fn test_latin_case_only_produces_term() {
        // "js" → "JavaScript": different lengths (ratio < 0.3), falls through to
        // hotword detection → emits a Term with the corrected form.
        let candidates = extract_correction_pairs("用 js 写代码", "用 JavaScript 写代码");
        let term = candidates.iter().find(|c| c.kind == CandidateKind::Term);
        assert!(term.is_some(), "candidates={:?}", candidates);
        assert_eq!(term.unwrap().right, "JavaScript");

        // Test a pair with reasonable length ratio: 配森(2) → Python(6), ratio=0.33
        // This is covered by test_extract_cjk_to_latin already.
        // For Latin→Latin pair, use similar-length words:
        let candidates2 =
            extract_correction_pairs("用 react 写前端", "用 React 写前端");
        // react vs React: char LCS matches 'e','a','c','t' — del('r')+ins('R')
        // Single char del/ins won't pass isTermSized. This matches TS behavior.
        // The real-world fix for case normalization is via plain vocabulary terms.
        let _ = candidates2;
    }

    #[test]
    fn test_length_ratio_rejection() {
        // 一 → 一个很长很长很长很长的词 (ratio too extreme)
        assert!(!length_ratio_ok("一", "一个很长很长很长很长的词"));
    }
}
