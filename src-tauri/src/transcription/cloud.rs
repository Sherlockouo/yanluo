//! 云识别 (cloud ASR) provider dispatch — file/URL transcription only.
//!
//! Live Fn dictation stays on local engines (Qwen / Apple); `start_recording_impl`
//! rejects `AsrProvider::Cloud`. Cloud work is pure network I/O on a spawned
//! thread (never the mlx-worker — invariant #1).
//!
//! Every provider normalizes into the shared `TranscriptionResult`
//! (text / raw_text / segments / alignment via `segments_to_character_alignment`),
//! so downstream (history, works, export) never sees vendor differences.

use serde::Deserialize;
use std::collections::HashMap;
use std::time::{Duration, Instant};

use super::{normalize_language_for_elevenlabs, segments_to_character_alignment, TranscriptionResult};
use crate::audio::samples_to_wav_bytes;
use crate::config::{AppConfig, CloudAsrCredential};
use crate::history::TranscriptSegment;

/// Upload/POST timeout — 16kHz mono WAV is ~1.9MB/min, so hour-long files
/// need real headroom on slow uplinks.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// DashScope async task: poll cadence + overall budget (queue + inference).
const POLL_INTERVAL: Duration = Duration::from_secs(3);
const POLL_BUDGET: Duration = Duration::from_secs(15 * 60);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, serde::Serialize)]
pub(crate) enum CloudAsrProvider {
    #[serde(rename = "elevenlabs")]
    Elevenlabs,
    /// Any OpenAI-compatible `/audio/transcriptions` endpoint (OpenAI, Groq, …).
    #[serde(rename = "openai")]
    OpenAiCompatible,
    /// 阿里云百炼 Paraformer 录音文件识别 (async task API).
    #[serde(rename = "dashscope")]
    DashScope,
}

impl CloudAsrProvider {
    pub(crate) fn from_id(id: &str) -> Option<Self> {
        match id.trim().to_ascii_lowercase().as_str() {
            "elevenlabs" => Some(Self::Elevenlabs),
            "openai" | "openai_compatible" | "groq" => Some(Self::OpenAiCompatible),
            "dashscope" | "aliyun" | "bailian" => Some(Self::DashScope),
            _ => None,
        }
    }

    pub(crate) fn id(&self) -> &'static str {
        match self {
            Self::Elevenlabs => "elevenlabs",
            Self::OpenAiCompatible => "openai",
            Self::DashScope => "dashscope",
        }
    }

    pub(crate) fn display_name(&self) -> &'static str {
        match self {
            Self::Elevenlabs => "ElevenLabs",
            Self::OpenAiCompatible => "OpenAI 兼容",
            Self::DashScope => "阿里云百炼",
        }
    }

    fn default_model(&self) -> &'static str {
        match self {
            Self::Elevenlabs => "scribe_v2",
            Self::OpenAiCompatible => "whisper-1",
            Self::DashScope => "paraformer-v2",
        }
    }

    fn default_base_url(&self) -> &'static str {
        match self {
            Self::Elevenlabs => "https://api.elevenlabs.io",
            Self::OpenAiCompatible => "https://api.openai.com/v1",
            Self::DashScope => "https://dashscope.aliyuncs.com",
        }
    }
}

/// Resolve effective credentials for the active cloud provider:
/// per-provider map first, then legacy flat ElevenLabs fields, then (DashScope
/// only) the 百炼 key already stored in `llm_credentials`, then preset defaults
/// for model/base_url.
fn resolve_credentials(config: &AppConfig, provider: CloudAsrProvider) -> CloudAsrCredential {
    let mut cred = config
        .cloud_asr_credentials
        .get(provider.id())
        .cloned()
        .unwrap_or_default();

    if provider == CloudAsrProvider::Elevenlabs {
        if cred.api_key.trim().is_empty() {
            cred.api_key = config.elevenlabs_api_key.trim().to_string();
        }
        if cred.model.trim().is_empty() {
            cred.model = config.elevenlabs_model.trim().to_string();
        }
    }
    if provider == CloudAsrProvider::DashScope && cred.api_key.trim().is_empty() {
        if let Some(llm) = config.llm_credentials.get("dashscope") {
            cred.api_key = llm.api_key.trim().to_string();
        }
        if cred.api_key.trim().is_empty() && config.llm_provider == "dashscope" {
            cred.api_key = config.llm_api_key.trim().to_string();
        }
    }
    if cred.model.trim().is_empty() {
        cred.model = provider.default_model().into();
    }
    if cred.base_url.trim().is_empty() {
        cred.base_url = provider.default_base_url().into();
    }
    cred
}

fn http_client(timeout: Duration) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(timeout)
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(|e| format!("云识别 HTTP 客户端初始化失败: {e}"))
}

fn http_error(context: &str, response: reqwest::blocking::Response) -> String {
    let status = response.status();
    let body = response.text().unwrap_or_default();
    let body: String = body.chars().take(300).collect();
    if body.trim().is_empty() {
        format!("{context} 请求失败 (HTTP {status})")
    } else {
        format!("{context} 请求失败 (HTTP {status}): {body}")
    }
}

/// Entry point from `transcribe_file`: dispatch on `config.cloud_asr_provider`.
pub(crate) fn transcribe_cloud(
    config: &AppConfig,
    samples: &[f32],
) -> Result<TranscriptionResult, String> {
    let provider = CloudAsrProvider::from_id(&config.cloud_asr_provider)
        .ok_or_else(|| format!("未知的云识别供应商: {}", config.cloud_asr_provider))?;
    let cred = resolve_credentials(config, provider);
    if cred.api_key.trim().is_empty() {
        return Err(format!(
            "未配置 {} 的 API Key — 请到 设置 → 识别 → 云识别 填写",
            provider.display_name()
        ));
    }
    crate::elog::elog!(
        "[cloud-asr] provider={} model={} diarize={} samples={}",
        provider.id(),
        cred.model,
        cred.diarize,
        samples.len()
    );
    let started = Instant::now();
    let result = match provider {
        CloudAsrProvider::Elevenlabs => transcribe_elevenlabs(config, &cred, samples),
        CloudAsrProvider::OpenAiCompatible => transcribe_openai_compatible(config, &cred, samples),
        CloudAsrProvider::DashScope => transcribe_dashscope(config, &cred, samples),
    };
    match &result {
        Ok(r) => crate::elog::elog!(
            "[cloud-asr] {} ok in {:.1}s: chars={} segments={}",
            provider.id(),
            started.elapsed().as_secs_f64(),
            r.text.chars().count(),
            r.segments.len()
        ),
        Err(e) => crate::elog::elog!(
            "[cloud-asr] {} failed in {:.1}s: {e}",
            provider.id(),
            started.elapsed().as_secs_f64()
        ),
    }
    result
}

// ---------------------------------------------------------------------------
// ElevenLabs Scribe
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct ElevenLabsWord {
    text: String,
    start: Option<f64>,
    end: Option<f64>,
    #[serde(rename = "type")]
    kind: Option<String>,
    /// Present when `diarize=true` (e.g. "speaker_0").
    speaker_id: Option<String>,
}

#[derive(Deserialize)]
struct ElevenLabsResponse {
    text: Option<String>,
    language_code: Option<String>,
    words: Option<Vec<ElevenLabsWord>>,
}

fn transcribe_elevenlabs(
    config: &AppConfig,
    cred: &CloudAsrCredential,
    samples: &[f32],
) -> Result<TranscriptionResult, String> {
    let wav = samples_to_wav_bytes(samples)?;
    let part = reqwest::blocking::multipart::Part::bytes(wav)
        .file_name("recording.wav")
        .mime_str("audio/wav")
        .map_err(|e| e.to_string())?;
    let mut form = reqwest::blocking::multipart::Form::new()
        .part("file", part)
        .text("model_id", cred.model.trim().to_string())
        .text("language_code", normalize_language_for_elevenlabs(&config.language))
        .text("tag_audio_events", "false")
        .text("timestamps_granularity", "word");
    if cred.diarize {
        form = form.text("diarize", "true");
    }
    if !config.vocabulary.is_empty() {
        form = form.text("keyterms", config.vocabulary.join(", "));
    }

    let url = format!("{}/v1/speech-to-text", cred.base_url.trim_end_matches('/'));
    let response = http_client(REQUEST_TIMEOUT)?
        .post(&url)
        .header("xi-api-key", cred.api_key.trim())
        .multipart(form)
        .send()
        .map_err(|e| {
            if e.is_timeout() {
                "ElevenLabs 请求超时 — 检查网络或稍后再试".to_string()
            } else {
                format!("ElevenLabs 请求失败: {e}")
            }
        })?;
    if !response.status().is_success() {
        return Err(http_error("ElevenLabs", response));
    }
    let body = response.text().map_err(|e| e.to_string())?;
    parse_elevenlabs_response(
        &body,
        &config.language,
        samples.len() as f64 / 16_000.0,
    )
}

/// Word-level segments keep precise alignment; speaker ids ride along per word
/// so the reader can label paragraphs by speaker change.
fn parse_elevenlabs_response(
    body: &str,
    fallback_language: &str,
    duration_seconds: f64,
) -> Result<TranscriptionResult, String> {
    let parsed: ElevenLabsResponse =
        serde_json::from_str(body).map_err(|e| format!("ElevenLabs 响应解析失败: {e}"))?;
    let mut speakers: HashMap<String, usize> = HashMap::new();
    let text = parsed.text.unwrap_or_default();
    let segments: Vec<TranscriptSegment> = parsed
        .words
        .unwrap_or_default()
        .into_iter()
        .filter(|w| w.kind.as_deref() != Some("spacing"))
        .filter_map(|w| {
            let start = w.start?;
            let end = w.end.unwrap_or(start);
            if w.text.trim().is_empty() {
                return None;
            }
            let speaker = w
                .speaker_id
                .as_deref()
                .map(|raw| canonical_speaker_label(&mut speakers, raw));
            Some(TranscriptSegment {
                text: w.text,
                start,
                end,
                speaker,
            })
        })
        .collect();
    let alignment = if segments.is_empty() {
        None
    } else {
        Some(segments_to_character_alignment(&segments))
    };
    Ok(TranscriptionResult {
        text: text.clone(),
        raw_text: text,
        llm_text: None,
        language: parsed
            .language_code
            .unwrap_or_else(|| fallback_language.to_string()),
        duration_seconds,
        refined: false,
        refine_failed: false,
        error: None,
        segments,
        alignment,
    })
}

// ---------------------------------------------------------------------------
// OpenAI-compatible /audio/transcriptions (OpenAI Whisper, Groq, …)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct OpenAiVerboseSegment {
    start: Option<f64>,
    end: Option<f64>,
    text: Option<String>,
}

#[derive(Deserialize)]
struct OpenAiVerboseWord {
    start: Option<f64>,
    end: Option<f64>,
    word: Option<String>,
}

#[derive(Deserialize)]
struct OpenAiVerboseResponse {
    text: Option<String>,
    language: Option<String>,
    segments: Option<Vec<OpenAiVerboseSegment>>,
    words: Option<Vec<OpenAiVerboseWord>>,
}

fn transcribe_openai_compatible(
    config: &AppConfig,
    cred: &CloudAsrCredential,
    samples: &[f32],
) -> Result<TranscriptionResult, String> {
    let wav = samples_to_wav_bytes(samples)?;
    let part = reqwest::blocking::multipart::Part::bytes(wav)
        .file_name("recording.wav")
        .mime_str("audio/wav")
        .map_err(|e| e.to_string())?;
    let mut form = reqwest::blocking::multipart::Form::new()
        .part("file", part)
        .text("model", cred.model.trim().to_string())
        .text("response_format", "verbose_json")
        // Word where supported (OpenAI, Groq); segment as the common baseline.
        .text("timestamp_granularities[]", "segment")
        .text("timestamp_granularities[]", "word");
    let lang = openai_language_hint(&config.language);
    if !lang.is_empty() {
        form = form.text("language", lang);
    }

    let url = format!(
        "{}/audio/transcriptions",
        cred.base_url.trim_end_matches('/')
    );
    let response = http_client(REQUEST_TIMEOUT)?
        .post(&url)
        .bearer_auth(cred.api_key.trim())
        .multipart(form)
        .send()
        .map_err(|e| {
            if e.is_timeout() {
                "云识别请求超时 — 检查网络或稍后再试".to_string()
            } else {
                format!("云识别请求失败: {e}")
            }
        })?;
    if !response.status().is_success() {
        return Err(http_error("OpenAI 兼容识别", response));
    }
    let body = response.text().map_err(|e| e.to_string())?;
    parse_openai_verbose_response(&body, &config.language, samples.len() as f64 / 16_000.0)
}

/// OpenAI wants ISO-639-1 ("zh", "en"); empty/auto → omit (auto-detect).
fn openai_language_hint(language: &str) -> String {
    match language.trim().to_ascii_lowercase().as_str() {
        "auto" | "" => String::new(),
        other => other.split(['-', '_']).next().unwrap_or(other).to_string(),
    }
}

fn parse_openai_verbose_response(
    body: &str,
    fallback_language: &str,
    duration_seconds: f64,
) -> Result<TranscriptionResult, String> {
    let parsed: OpenAiVerboseResponse =
        serde_json::from_str(body).map_err(|e| format!("云识别响应解析失败: {e}"))?;
    let text = parsed.text.unwrap_or_default();
    // Prefer word timestamps (precise highlight); fall back to segments.
    let mut segments: Vec<TranscriptSegment> = parsed
        .words
        .unwrap_or_default()
        .into_iter()
        .filter_map(|w| {
            let word = w.word?;
            let start = w.start?;
            if word.trim().is_empty() {
                return None;
            }
            Some(TranscriptSegment {
                text: word.trim().to_string(),
                start,
                end: w.end.unwrap_or(start),
                speaker: None,
            })
        })
        .collect();
    if segments.is_empty() {
        segments = parsed
            .segments
            .unwrap_or_default()
            .into_iter()
            .filter_map(|s| {
                let seg_text = s.text?;
                let start = s.start?;
                if seg_text.trim().is_empty() {
                    return None;
                }
                Some(TranscriptSegment {
                    text: seg_text.trim().to_string(),
                    start,
                    end: s.end.unwrap_or(start),
                    speaker: None,
                })
            })
            .collect();
    }
    let alignment = if segments.is_empty() {
        None
    } else {
        Some(segments_to_character_alignment(&segments))
    };
    Ok(TranscriptionResult {
        text: text.clone(),
        raw_text: text,
        llm_text: None,
        language: parsed
            .language
            .unwrap_or_else(|| fallback_language.to_string()),
        duration_seconds,
        refined: false,
        refine_failed: false,
        error: None,
        segments,
        alignment,
    })
}

// ---------------------------------------------------------------------------
// DashScope (阿里云百炼 Paraformer 录音文件识别, async task API)
//
// The task API takes a *URL*, not bytes — local audio goes through 百炼's
// documented temp-upload: GET /api/v1/uploads?action=getPolicy&model=… →
// multipart POST to the returned OSS host → oss:// URL (valid 48h) → submit →
// poll /api/v1/tasks/{id} → fetch the result JSON URL.
// Ref: https://www.alibabacloud.com/help/zh/model-studio/get-temporary-file-url
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct DashScopeUploadPolicy {
    policy: String,
    signature: String,
    upload_dir: String,
    upload_host: String,
    oss_access_key_id: String,
    x_oss_object_acl: String,
    x_oss_forbid_overwrite: String,
}

#[derive(Deserialize)]
struct DashScopeEnvelope<T> {
    data: Option<T>,
    output: Option<T>,
    code: Option<String>,
    message: Option<String>,
}

#[derive(Deserialize)]
struct DashScopeTaskSubmit {
    task_id: Option<String>,
}

#[derive(Deserialize)]
struct DashScopeTaskResultEntry {
    transcription_url: Option<String>,
    subtask_status: Option<String>,
    code: Option<String>,
    message: Option<String>,
}

#[derive(Deserialize)]
struct DashScopeTaskQuery {
    task_status: Option<String>,
    results: Option<Vec<DashScopeTaskResultEntry>>,
}

#[derive(Deserialize)]
struct DashScopeSentence {
    begin_time: Option<u64>,
    end_time: Option<u64>,
    text: Option<String>,
    speaker_id: Option<i64>,
}

#[derive(Deserialize)]
struct DashScopeTranscript {
    text: Option<String>,
    sentences: Option<Vec<DashScopeSentence>>,
}

#[derive(Deserialize)]
struct DashScopeResultFile {
    transcripts: Option<Vec<DashScopeTranscript>>,
}

fn dashscope_api(base_url: &str, path: &str) -> String {
    format!("{}/api/v1{}", base_url.trim_end_matches('/'), path)
}

fn transcribe_dashscope(
    config: &AppConfig,
    cred: &CloudAsrCredential,
    samples: &[f32],
) -> Result<TranscriptionResult, String> {
    let client = http_client(REQUEST_TIMEOUT)?;
    let model = cred.model.trim().to_string();
    let key = cred.api_key.trim().to_string();

    // 1) Upload policy for the temp OSS bucket.
    let policy_url = format!(
        "{}?action=getPolicy&model={}",
        dashscope_api(&cred.base_url, "/uploads"),
        model
    );
    let response = client
        .get(&policy_url)
        .bearer_auth(&key)
        .send()
        .map_err(|e| format!("百炼上传凭证请求失败: {e}"))?;
    if !response.status().is_success() {
        return Err(http_error("百炼上传凭证", response));
    }
    let envelope: DashScopeEnvelope<DashScopeUploadPolicy> =
        response.json().map_err(|e| format!("百炼上传凭证解析失败: {e}"))?;
    let policy = envelope.data.ok_or_else(|| {
        format!(
            "百炼上传凭证为空: {} {}",
            envelope.code.unwrap_or_default(),
            envelope.message.unwrap_or_default()
        )
    })?;

    // 2) Multipart upload to the temp OSS host → oss:// URL.
    let wav = samples_to_wav_bytes(samples)?;
    let object_key = format!("{}/recording-{}.wav", policy.upload_dir, chrono::Utc::now().timestamp_millis());
    let file_part = reqwest::blocking::multipart::Part::bytes(wav)
        .file_name("recording.wav")
        .mime_str("audio/wav")
        .map_err(|e| e.to_string())?;
    let form = reqwest::blocking::multipart::Form::new()
        .text("OSSAccessKeyId", policy.oss_access_key_id)
        .text("Signature", policy.signature)
        .text("policy", policy.policy)
        .text("x-oss-object-acl", policy.x_oss_object_acl)
        .text("x-oss-forbid-overwrite", policy.x_oss_forbid_overwrite)
        .text("key", object_key.clone())
        .text("success_action_status", "200")
        .part("file", file_part);
    let response = client
        .post(&policy.upload_host)
        .multipart(form)
        .send()
        .map_err(|e| format!("百炼文件上传失败: {e}"))?;
    if !response.status().is_success() {
        return Err(http_error("百炼文件上传", response));
    }
    let file_url = format!("oss://{object_key}");
    crate::elog::elog!("[cloud-asr] dashscope uploaded {file_url}");

    // 3) Submit the async transcription task.
    let mut parameters = serde_json::json!({
        "channel_id": [0],
        "diarization_enabled": cred.diarize,
    });
    // language_hints only applies to paraformer-v2 per the API docs.
    if model.starts_with("paraformer-v2") {
        let hints = dashscope_language_hints(&config.language);
        if !hints.is_empty() {
            parameters["language_hints"] = serde_json::json!(hints);
        }
    }
    let submit_body = serde_json::json!({
        "model": model,
        "input": { "file_urls": [file_url] },
        "parameters": parameters,
    });
    let response = client
        .post(dashscope_api(&cred.base_url, "/services/audio/asr/transcription"))
        .bearer_auth(&key)
        .header("X-DashScope-Async", "enable")
        .header("X-DashScope-OssResourceResolve", "enable")
        .json(&submit_body)
        .send()
        .map_err(|e| format!("百炼识别任务提交失败: {e}"))?;
    if !response.status().is_success() {
        return Err(http_error("百炼识别任务提交", response));
    }
    let envelope: DashScopeEnvelope<DashScopeTaskSubmit> =
        response.json().map_err(|e| format!("百炼任务响应解析失败: {e}"))?;
    let task_id = envelope
        .output
        .and_then(|o| o.task_id)
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| {
            format!(
                "百炼任务提交失败: {} {}",
                envelope.code.unwrap_or_default(),
                envelope.message.unwrap_or_default()
            )
        })?;
    crate::elog::elog!("[cloud-asr] dashscope task {task_id} submitted");

    // 4) Poll until SUCCEEDED / FAILED (budget bounded by POLL_BUDGET).
    let poll_url = dashscope_api(&cred.base_url, &format!("/tasks/{task_id}"));
    let deadline = Instant::now() + POLL_BUDGET;
    let transcription_url = loop {
        let response = client
            .post(&poll_url)
            .bearer_auth(&key)
            .send()
            .map_err(|e| format!("百炼任务查询失败: {e}"))?;
        if !response.status().is_success() {
            return Err(http_error("百炼任务查询", response));
        }
        let envelope: DashScopeEnvelope<DashScopeTaskQuery> =
            response.json().map_err(|e| format!("百炼任务查询解析失败: {e}"))?;
        let Some(query) = envelope.output else {
            return Err("百炼任务查询返回为空".into());
        };
        match query.task_status.as_deref() {
            Some("SUCCEEDED") => {
                let entry = query.results.and_then(|mut r| if r.is_empty() { None } else { Some(r.remove(0)) });
                let Some(entry) = entry else {
                    return Err("百炼任务成功但无结果".into());
                };
                if entry.subtask_status.as_deref() == Some("FAILED") {
                    return Err(format!(
                        "百炼识别失败: {} {}",
                        entry.code.unwrap_or_default(),
                        entry.message.unwrap_or_default()
                    ));
                }
                break entry
                    .transcription_url
                    .filter(|u| !u.trim().is_empty())
                    .ok_or_else(|| "百炼任务成功但缺少结果链接".to_string())?;
            }
            Some("FAILED") | Some("CANCELED") | Some("UNKNOWN") => {
                return Err(format!(
                    "百炼识别任务失败: {} {}",
                    envelope.code.unwrap_or_default(),
                    envelope.message.unwrap_or_default()
                ));
            }
            _ => {
                if Instant::now() >= deadline {
                    return Err("百炼识别超时（15 分钟）— 长音频请稍后在历史里重试或改用其他供应商".into());
                }
                std::thread::sleep(POLL_INTERVAL);
            }
        }
    };

    // 5) Fetch + normalize the result JSON (no auth needed; URL is signed).
    let response = http_client(Duration::from_secs(90))?
        .get(&transcription_url)
        .send()
        .map_err(|e| format!("百炼结果下载失败: {e}"))?;
    if !response.status().is_success() {
        return Err(http_error("百炼结果下载", response));
    }
    let body = response.text().map_err(|e| e.to_string())?;
    parse_dashscope_result(&body, &config.language, samples.len() as f64 / 16_000.0)
}

/// language_hints for paraformer-v2 (zh/en/ja/yue/ko/de/fr/ru).
fn dashscope_language_hints(language: &str) -> Vec<&'static str> {
    match language.trim().to_ascii_lowercase().as_str() {
        "auto" | "" => vec!["zh", "en"],
        "zh-cn" | "zh-tw" | "zh" => vec!["zh"],
        "yue-hk" | "yue" => vec!["yue"],
        "en-us" | "en" => vec!["en"],
        "ja-jp" | "ja" => vec!["ja"],
        "ko-kr" | "ko" => vec!["ko"],
        "de-de" | "de" => vec!["de"],
        "fr-fr" | "fr" => vec!["fr"],
        "ru-ru" | "ru" => vec!["ru"],
        _ => vec!["zh", "en"],
    }
}

/// Result JSON: `transcripts[].sentences[]` with ms timestamps and optional
/// `speaker_id` (diarization). Sentence-level segments carry the speaker label.
fn parse_dashscope_result(
    body: &str,
    fallback_language: &str,
    duration_seconds: f64,
) -> Result<TranscriptionResult, String> {
    let parsed: DashScopeResultFile =
        serde_json::from_str(body).map_err(|e| format!("百炼结果解析失败: {e}"))?;
    let transcripts = parsed.transcripts.unwrap_or_default();
    let mut speakers: HashMap<String, usize> = HashMap::new();
    let mut texts: Vec<String> = Vec::new();
    let mut segments: Vec<TranscriptSegment> = Vec::new();
    for transcript in &transcripts {
        if let Some(text) = &transcript.text {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                texts.push(trimmed.to_string());
            }
        }
        for sentence in transcript.sentences.iter().flatten() {
            let (Some(begin), Some(end)) = (sentence.begin_time, sentence.end_time) else {
                continue;
            };
            let text = sentence.text.clone().unwrap_or_default();
            if text.trim().is_empty() {
                continue;
            }
            let speaker = sentence
                .speaker_id
                .map(|id| canonical_speaker_label(&mut speakers, &id.to_string()));
            segments.push(TranscriptSegment {
                text: text.trim().to_string(),
                start: begin as f64 / 1000.0,
                end: end as f64 / 1000.0,
                speaker,
            });
        }
    }
    // Prefer joined transcript text; fall back to joining sentences.
    let text = if texts.is_empty() {
        segments
            .iter()
            .map(|s| s.text.as_str())
            .collect::<Vec<_>>()
            .join("")
    } else {
        texts.join("\n")
    };
    let alignment = if segments.is_empty() {
        None
    } else {
        Some(segments_to_character_alignment(&segments))
    };
    Ok(TranscriptionResult {
        text: text.clone(),
        raw_text: text,
        llm_text: None,
        language: fallback_language.to_string(),
        duration_seconds,
        refined: false,
        refine_failed: false,
        error: None,
        segments,
        alignment,
    })
}

// ---------------------------------------------------------------------------
// Shared speaker normalization
// ---------------------------------------------------------------------------

/// Map a raw provider speaker id ("speaker_0", 0, …) to a canonical
/// `speaker_N` label by order of first appearance. The frontend localizes the
/// label (`cloudAsr.speaker`).
fn canonical_speaker_label(seen: &mut HashMap<String, usize>, raw: &str) -> String {
    let next = seen.len() + 1;
    let idx = *seen.entry(raw.to_string()).or_insert(next);
    format!("speaker_{idx}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn elevenlabs_words_group_speakers_by_appearance() {
        let body = r#"{
            "text": "你好世界 hello",
            "language_code": "zh",
            "words": [
                {"text": "你好", "start": 0.0, "end": 0.5, "type": "word", "speaker_id": "speaker_1"},
                {"text": " ", "type": "spacing"},
                {"text": "世界", "start": 0.5, "end": 1.0, "type": "word", "speaker_id": "speaker_1"},
                {"text": "hello", "start": 2.0, "end": 2.6, "type": "word", "speaker_id": "speaker_0"}
            ]
        }"#;
        let result = parse_elevenlabs_response(body, "auto", 3.0).unwrap();
        assert_eq!(result.text, "你好世界 hello");
        assert_eq!(result.language, "zh");
        assert_eq!(result.segments.len(), 3);
        // speaker_1 appears first → canonical speaker_1; speaker_0 → speaker_2.
        assert_eq!(result.segments[0].speaker.as_deref(), Some("speaker_1"));
        assert_eq!(result.segments[1].speaker.as_deref(), Some("speaker_1"));
        assert_eq!(result.segments[2].speaker.as_deref(), Some("speaker_2"));
        assert!(result.alignment.is_some());
        assert_eq!(result.duration_seconds, 3.0);
    }

    #[test]
    fn elevenlabs_without_diarize_has_no_speakers() {
        let body = r#"{
            "text": "hello world",
            "language_code": "en",
            "words": [
                {"text": "hello", "start": 0.0, "end": 0.5, "type": "word"},
                {"text": "world", "start": 0.6, "end": 1.0, "type": "word"}
            ]
        }"#;
        let result = parse_elevenlabs_response(body, "auto", 1.0).unwrap();
        assert!(result.segments.iter().all(|s| s.speaker.is_none()));
    }

    #[test]
    fn openai_verbose_prefers_words_then_segments() {
        let with_words = r#"{
            "text": "hello world",
            "language": "english",
            "segments": [{"id": 0, "start": 0.0, "end": 1.0, "text": " hello world"}],
            "words": [
                {"word": "hello", "start": 0.0, "end": 0.4},
                {"word": "world", "start": 0.5, "end": 1.0}
            ]
        }"#;
        let result = parse_openai_verbose_response(with_words, "auto", 1.0).unwrap();
        assert_eq!(result.segments.len(), 2);
        assert_eq!(result.segments[0].text, "hello");

        let segments_only = r#"{
            "text": "你好。世界。",
            "language": "chinese",
            "segments": [
                {"id": 0, "start": 0.0, "end": 1.2, "text": "你好。"},
                {"id": 1, "start": 1.2, "end": 2.4, "text": "世界。"}
            ]
        }"#;
        let result = parse_openai_verbose_response(segments_only, "auto", 2.4).unwrap();
        assert_eq!(result.segments.len(), 2);
        assert_eq!(result.segments[1].start, 1.2);
        assert!(result.alignment.is_some());
    }

    #[test]
    fn dashscope_result_normalizes_sentences_and_speakers() {
        let body = r#"{
            "file_url": "oss://dashscope-instant/x/recording.wav",
            "properties": {"original_duration_in_milliseconds": 3834},
            "transcripts": [{
                "channel_id": 0,
                "text": "你好，这里是阿里巴巴。收到！",
                "sentences": [
                    {"begin_time": 100, "end_time": 2500, "text": "你好，这里是阿里巴巴。", "sentence_id": 1, "speaker_id": 0},
                    {"begin_time": 2600, "end_time": 3820, "text": "收到！", "sentence_id": 2, "speaker_id": 1}
                ]
            }]
        }"#;
        let result = parse_dashscope_result(body, "auto", 3.834).unwrap();
        assert_eq!(result.text, "你好，这里是阿里巴巴。收到！");
        assert_eq!(result.segments.len(), 2);
        assert_eq!(result.segments[0].start, 0.1);
        assert_eq!(result.segments[0].end, 2.5);
        assert_eq!(result.segments[0].speaker.as_deref(), Some("speaker_1"));
        assert_eq!(result.segments[1].speaker.as_deref(), Some("speaker_2"));
        assert!(result.alignment.is_some());
    }

    #[test]
    fn dashscope_result_without_text_joins_sentences() {
        let body = r#"{"transcripts": [{"sentences": [
            {"begin_time": 0, "end_time": 1000, "text": "第一句。"},
            {"begin_time": 1000, "end_time": 2000, "text": "第二句。"}
        ]}]}"#;
        let result = parse_dashscope_result(body, "auto", 2.0).unwrap();
        assert_eq!(result.text, "第一句。第二句。");
    }

    #[test]
    fn provider_ids_round_trip() {
        assert_eq!(CloudAsrProvider::from_id("elevenlabs"), Some(CloudAsrProvider::Elevenlabs));
        assert_eq!(CloudAsrProvider::from_id("openai"), Some(CloudAsrProvider::OpenAiCompatible));
        assert_eq!(CloudAsrProvider::from_id("dashscope"), Some(CloudAsrProvider::DashScope));
        assert_eq!(CloudAsrProvider::from_id("nope"), None);
        for p in [CloudAsrProvider::Elevenlabs, CloudAsrProvider::OpenAiCompatible, CloudAsrProvider::DashScope] {
            assert_eq!(CloudAsrProvider::from_id(p.id()), Some(p));
            let json = serde_json::to_string(&p).unwrap();
            assert_eq!(serde_json::from_str::<CloudAsrProvider>(&json).unwrap(), p);
        }
    }
}
