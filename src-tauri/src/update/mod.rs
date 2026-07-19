//! Check GitHub Releases and download/install platform packages.

use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};

const REPO: &str = "XBCoder128/asr-cli";
const USER_AGENT: &str = "Yanluo-Updater";

static DOWNLOAD_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReleaseAsset {
    pub name: String,
    pub browser_download_url: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReleaseInfo {
    pub tag_name: String,
    pub name: Option<String>,
    pub body: Option<String>,
    pub html_url: String,
    pub published_at: Option<String>,
    pub prerelease: bool,
    pub draft: bool,
    pub assets: Vec<ReleaseAsset>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UpdateCheckResult {
    pub current_version: String,
    pub update_available: bool,
    pub latest: Option<ReleaseInfo>,
    pub asset: Option<ReleaseAsset>,
    pub releases: Vec<ReleaseInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub downloaded: u64,
    pub total: Option<u64>,
    pub percent: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DownloadInstallResult {
    pub path: String,
    pub opened: bool,
    pub message: String,
}

fn normalize_version(tag: &str) -> String {
    tag.trim()
        .trim_start_matches(['v', 'V'])
        .split(|c: char| c == '-' || c == '+')
        .next()
        .unwrap_or(tag)
        .to_string()
}

fn parse_semver(tag: &str) -> Option<(u64, u64, u64)> {
    let n = normalize_version(tag);
    let mut parts = n.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().unwrap_or("0").parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch))
}

fn compare_semver(a: &str, b: &str) -> i32 {
    match (parse_semver(a), parse_semver(b)) {
        (Some(aa), Some(bb)) => {
            if aa < bb {
                -1
            } else if aa > bb {
                1
            } else {
                0
            }
        }
        _ => normalize_version(a).cmp(&normalize_version(b)) as i32,
    }
}

fn current_arch_tokens() -> &'static [&'static str] {
    #[cfg(target_arch = "aarch64")]
    {
        &["aarch64", "arm64", "apple-silicon"]
    }
    #[cfg(target_arch = "x86_64")]
    {
        &["x86_64", "x64", "amd64"]
    }
    #[cfg(not(any(target_arch = "aarch64", target_arch = "x86_64")))]
    {
        &[]
    }
}

fn preferred_extensions() -> &'static [&'static str] {
    #[cfg(target_os = "macos")]
    {
        &[".dmg"]
    }
    #[cfg(target_os = "windows")]
    {
        &[".msi", "-setup.exe", ".exe"]
    }
    #[cfg(target_os = "linux")]
    {
        &[".appimage", ".deb"]
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        &[]
    }
}

fn asset_score(name: &str) -> i32 {
    let lower = name.to_ascii_lowercase();
    let mut score = -1;
    for (i, ext) in preferred_extensions().iter().enumerate() {
        if lower.ends_with(ext) || lower.contains(ext) {
            score = 100 - i as i32;
            break;
        }
    }
    if score < 0 {
        return -1;
    }
    let arch = current_arch_tokens();
    if arch.is_empty() {
        return score;
    }
    if arch.iter().any(|t| lower.contains(t)) {
        score += 50;
    } else if lower.contains("x86_64")
        || lower.contains("x64")
        || lower.contains("amd64")
        || lower.contains("aarch64")
        || lower.contains("arm64")
    {
        // Wrong arch explicitly named — deprioritize heavily.
        score -= 80;
    }
    score
}

fn pick_asset(assets: &[ReleaseAsset]) -> Option<ReleaseAsset> {
    assets
        .iter()
        .filter_map(|a| {
            let s = asset_score(&a.name);
            (s >= 0).then_some((s, a.clone()))
        })
        .max_by_key(|(s, _)| *s)
        .map(|(_, a)| a)
}

fn github_token() -> Option<String> {
    std::env::var("GITHUB_TOKEN")
        .or_else(|_| std::env::var("GH_TOKEN"))
        .ok()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(std::time::Duration::from_secs(8))
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("创建 HTTP client failed: {e}"))
}

fn fetch_releases(include_prerelease: bool) -> Result<Vec<ReleaseInfo>, String> {
    let client = http_client()?;
    let url = format!("https://api.github.com/repos/{REPO}/releases?per_page=20");
    let mut req = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28");
    if let Some(token) = github_token() {
        req = req.bearer_auth(token);
    }
    let res = req.send().map_err(|e| {
        format!("无法连接 GitHub（网络超时或被拦截）。请检查网络后重试。详情: {e}")
    })?;
    if !res.status().is_success() {
        let status = res.status();
        if status.as_u16() == 404 {
            return Err(format!(
                "GitHub 仓库 {REPO} 无法访问（未登录 API 返回 404）。常见原因：仓库是私有的——浏览器登录后能看 Release，应用内默认无权限。请将仓库设为 Public，或在启动应用前设置环境变量 GITHUB_TOKEN / GH_TOKEN（classic PAT，repo 读权限）"
            ));
        }
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(format!(
                "GitHub API {status}：token 无效或权限不足（需要能读 {REPO} 的 Releases）"
            ));
        }
        return Err(format!("GitHub API {status}"));
    }
    let mut releases: Vec<ReleaseInfo> = res
        .json()
        .map_err(|e| format!("解析 GitHub 响应失败: {e}"))?;
    releases.retain(|r| !r.draft && (include_prerelease || !r.prerelease));
    if releases.is_empty() {
        return Err(format!(
            "仓库 {REPO} 可访问，但没有已发布的 Release（仅 draft/prerelease 已过滤）"
        ));
    }
    Ok(releases)
}

fn downloads_dir() -> PathBuf {
    dirs::download_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(std::env::temp_dir)
        .join("言落 Updates")
}

fn open_installer(path: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("打开安装包失败: {e}"))?;
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &path.to_string_lossy()])
            .spawn()
            .map_err(|e| format!("打开安装包失败: {e}"))?;
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        // Prefer executing AppImage; otherwise open with xdg-open.
        let lower = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if lower.ends_with(".appimage") {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(path)
                .map_err(|e| e.to_string())?
                .permissions();
            perms.set_mode(perms.mode() | 0o111);
            let _ = std::fs::set_permissions(path, perms);
            std::process::Command::new(path)
                .spawn()
                .map_err(|e| format!("启动 AppImage 失败: {e}"))?;
        } else {
            std::process::Command::new("xdg-open")
                .arg(path)
                .spawn()
                .map_err(|e| format!("打开安装包失败: {e}"))?;
        }
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = path;
        Err("当前平台不支持自动打开安装包".into())
    }
}

/// Check GitHub for a newer release and pick a platform asset.
/// Runs off the async runtime via `spawn_blocking` so the UI never freezes
/// (reqwest::blocking must not run on the Tokio worker thread).
#[tauri::command]
pub(crate) async fn check_for_update() -> Result<UpdateCheckResult, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let current = env!("CARGO_PKG_VERSION").to_string();
        let releases = fetch_releases(false)?;
        let latest = releases.first().cloned();
        let update_available = latest
            .as_ref()
            .map(|r| compare_semver(&r.tag_name, &current) > 0)
            .unwrap_or(false);
        let asset = if update_available {
            latest.as_ref().and_then(|r| pick_asset(&r.assets))
        } else {
            None
        };
        Ok(UpdateCheckResult {
            current_version: current,
            update_available,
            latest,
            asset,
            releases,
        })
    })
    .await
    .map_err(|e| format!("检查更新任务失败: {e}"))?
}

/// Download a release asset and open the installer.
#[tauri::command]
pub(crate) async fn download_and_install_update(
    app: AppHandle,
    url: String,
    filename: String,
) -> Result<DownloadInstallResult, String> {
    if DOWNLOAD_IN_FLIGHT
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("已有下载任务进行中".into());
    }

    let result = tauri::async_runtime::spawn_blocking(move || {
        download_and_install_blocking(&app, &url, &filename)
    })
    .await
    .map_err(|e| format!("下载任务失败: {e}"));

    DOWNLOAD_IN_FLIGHT.store(false, Ordering::SeqCst);
    result?
}

fn download_and_install_blocking(
    app: &AppHandle,
    url: &str,
    filename: &str,
) -> Result<DownloadInstallResult, String> {
    let safe_name = PathBuf::from(filename)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "无效的文件名".to_string())?;

    let dir = downloads_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建下载目录失败: {e}"))?;
    let dest = dir.join(&safe_name);
    let partial = dir.join(format!("{safe_name}.partial"));

    let client = http_client()?;
    let mut response = client
        .get(url)
        .send()
        .map_err(|e| format!("下载失败: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("下载失败: HTTP {}", response.status()));
    }
    let total = response.content_length();

    let mut file = File::create(&partial).map_err(|e| format!("写入失败: {e}"))?;
    let mut buf = [0u8; 64 * 1024];
    let mut downloaded: u64 = 0;
    let mut last_emit = 0u64;

    loop {
        let n = response
            .read(&mut buf)
            .map_err(|e| format!("读取下载流失败: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])
            .map_err(|e| format!("写入失败: {e}"))?;
        downloaded += n as u64;

        // Throttle progress events (~every 256 KiB or on finish).
        if downloaded - last_emit >= 256 * 1024 || total == Some(downloaded) {
            last_emit = downloaded;
            let percent = total.map(|t| {
                if t == 0 {
                    100.0
                } else {
                    (downloaded as f64 / t as f64) * 100.0
                }
            });
            let _ = app.emit(
                "update-download-progress",
                DownloadProgress {
                    downloaded,
                    total,
                    percent,
                },
            );
        }
    }
    file.flush().map_err(|e| format!("写入失败: {e}"))?;
    drop(file);

    if dest.exists() {
        let _ = std::fs::remove_file(&dest);
    }
    std::fs::rename(&partial, &dest).map_err(|e| format!("保存安装包失败: {e}"))?;

    let _ = app.emit(
        "update-download-progress",
        DownloadProgress {
            downloaded,
            total: total.or(Some(downloaded)),
            percent: Some(100.0),
        },
    );

    open_installer(&dest)?;

    let message = match std::env::consts::OS {
        "macos" => "已打开 DMG，请将应用拖入「应用程序」后重新打开。".to_string(),
        "windows" => "已启动安装程序，请按向导完成更新。".to_string(),
        "linux" => "已打开安装包 / AppImage，请按系统提示完成更新。".to_string(),
        _ => "安装包已下载。".to_string(),
    };

    Ok(DownloadInstallResult {
        path: dest.to_string_lossy().into_owned(),
        opened: true,
        message,
    })
}

/// Open the local downloads folder used for update packages.
#[tauri::command]
pub(crate) fn open_update_download_dir() -> Result<String, String> {
    let dir = downloads_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建下载目录失败: {e}"))?;
    open_installer(&dir)?;
    Ok(dir.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_compare_basic() {
        assert!(compare_semver("v0.2.0", "0.1.1") > 0);
        assert!(compare_semver("0.1.1", "v0.1.1") == 0);
        assert!(compare_semver("0.1.0", "0.1.1") < 0);
    }

    #[test]
    fn picks_platform_dmg() {
        let assets = vec![
            ReleaseAsset {
                name: "Yanluo_0.2.0_x64.dmg".into(),
                browser_download_url: "https://example.com/x64.dmg".into(),
                size: 1,
            },
            ReleaseAsset {
                name: "Yanluo_0.2.0_aarch64.dmg".into(),
                browser_download_url: "https://example.com/arm.dmg".into(),
                size: 2,
            },
            ReleaseAsset {
                name: "Yanluo_0.2.0_x64_en-US.msi".into(),
                browser_download_url: "https://example.com/x.msi".into(),
                size: 3,
            },
        ];
        let picked = pick_asset(&assets).expect("asset");
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        assert!(picked.name.contains("aarch64"));
        #[cfg(target_os = "windows")]
        assert!(picked.name.ends_with(".msi"));
    }
}
