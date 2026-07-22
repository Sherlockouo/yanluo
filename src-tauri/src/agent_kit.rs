//! Sync bundled agent kit into `{app_data}/agent/` for Claude/Codex/Pi.

use std::fs;
use std::io::Write;
use std::path::Path;

use crate::config::{default_agent_workdir, ensure_default_agent_workdir};

/// Bump when kit files change — rewrite on mismatch.
pub(crate) const AGENT_KIT_VERSION: &str = "1";

const AGENTS_MD: &str = include_str!("../agent_kit/AGENTS.md");
const SKILL_SETTINGS: &str = include_str!("../agent_kit/skills/yanluo-settings.md");
const YANLUO_CONFIG: &str = include_str!("../agent_kit/bin/yanluo-config");

/// Ensure kit files exist under the default agent workdir. Idempotent.
pub(crate) fn sync_agent_kit() -> Result<std::path::PathBuf, String> {
    let dir = ensure_default_agent_workdir()?;
    let stamp = dir.join(".yanluo-kit-version");
    let current = fs::read_to_string(&stamp).unwrap_or_default();
    if current.trim() == AGENT_KIT_VERSION && dir.join("AGENTS.md").is_file() {
        return Ok(dir);
    }
    write_kit(&dir)?;
    fs::write(&stamp, format!("{AGENT_KIT_VERSION}\n"))
        .map_err(|e| format!("write kit version: {e}"))?;
    Ok(dir)
}

fn write_kit(dir: &Path) -> Result<(), String> {
    let skills = dir.join("skills");
    let bin = dir.join("bin");
    fs::create_dir_all(&skills).map_err(|e| format!("mkdir skills: {e}"))?;
    fs::create_dir_all(&bin).map_err(|e| format!("mkdir bin: {e}"))?;

    write_file(&dir.join("AGENTS.md"), AGENTS_MD)?;
    write_file(&skills.join("yanluo-settings.md"), SKILL_SETTINGS)?;
    let script = bin.join("yanluo-config");
    write_file(&script, YANLUO_CONFIG)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&script)
            .map_err(|e| format!("stat yanluo-config: {e}"))?
            .permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&script, perms)
            .map_err(|e| format!("chmod yanluo-config: {e}"))?;
    }
    Ok(())
}

fn write_file(path: &Path, contents: &str) -> Result<(), String> {
    let mut f = fs::File::create(path).map_err(|e| format!("create {}: {e}", path.display()))?;
    f.write_all(contents.as_bytes())
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(())
}

/// Absolute path to the kit directory (may not exist until sync).
pub(crate) fn agent_kit_dir() -> std::path::PathBuf {
    default_agent_workdir()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn kit_templates_nonempty() {
        assert!(AGENTS_MD.contains("yanluo-config"));
        assert!(SKILL_SETTINGS.contains("asr_model_dir"));
        assert!(YANLUO_CONFIG.contains("WHITELIST"));
    }

    #[test]
    fn sync_writes_files() {
        let tmp = env::temp_dir().join(format!("yanluo-kit-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        write_kit(&tmp).unwrap();
        assert!(tmp.join("AGENTS.md").is_file());
        assert!(tmp.join("skills/yanluo-settings.md").is_file());
        assert!(tmp.join("bin/yanluo-config").is_file());
        let _ = fs::remove_dir_all(&tmp);
    }
}
