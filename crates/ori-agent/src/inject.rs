//! Claim-time config injection: env vars, secret files, and repo checkouts
//! handed over when the sandbox was claimed.
//!
//! Secret files are the correctness-critical piece. They must land **0600**,
//! owned by the sandbox user (the agent runs as that user), and never pass
//! through a world-readable temp path on the way there. So there is no
//! `tempfile` dance: the bytes are written directly to the final path with
//! mode 0600 and then chmodded 0600 again to tighten a pre-existing file. A
//! failure to materialize a secret fails the whole claim — a sandbox with
//! missing secrets must never come up as `ready`.

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use crate::config::Claim;
use crate::error::AgentError;
use crate::wire::decode_b64;

/// Apply a claim payload. `env` is mutated in place (claim env overlaid on the
/// base environment). Fails the whole claim if any secret file or checkout
/// fails.
pub async fn apply_claim(claim: &Claim, env: &mut HashMap<String, String>) -> Result<(), AgentError> {
    env.extend(claim.env.iter().map(|(k, v)| (k.clone(), v.clone())));

    for sf in &claim.secret_files {
        write_secret_file(&sf.path, &sf.contents_b64).await?;
    }

    for repo in &claim.repos {
        checkout_repo(&repo.url, repo.r#ref.as_deref(), &repo.path).await?;
    }

    Ok(())
}

/// Write a secret file at its final path with mode 0600, never through a
/// world-readable temp location. Fails if the final mode is not exactly 0600.
pub async fn write_secret_file(path: &Path, contents_b64: &str) -> Result<(), AgentError> {
    let contents = decode_b64(contents_b64)?;

    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            create_dir_all_private(parent)?;
        }
    }

    let mut opts = std::fs::OpenOptions::new();
    opts.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts
        .open(path)
        .map_err(|e| AgentError::Other(format!("cannot write secret file {}: {e}", path.display())))?;
    use std::io::Write;
    f.write_all(&contents)
        .and_then(|_| f.sync_all())
        .map_err(|e| AgentError::Other(format!("cannot write secret file {}: {e}", path.display())))?;
    f.sync_all().ok();

    set_private(path)?;

    verify_private(path).ok_or_else(|| {
        AgentError::Other(format!(
            "secret file {} is not 0600 after write",
            path.display()
        ))
    })?;

    Ok(())
}

/// Create a directory chain so that any directory we create is private (0700),
/// matching the 0600 files that will live under it. Existing parents are left
/// untouched.
#[cfg(unix)]
fn create_dir_all_private(path: &Path) -> Result<(), AgentError> {
    use std::os::unix::fs::DirBuilderExt;
    let mut b = std::fs::DirBuilder::new();
    b.recursive(true).mode(0o700);
    b.create(path).map_err(|e| {
        AgentError::Other(format!("cannot create dir {}: {e}", path.display()))
    })?;
    Ok(())
}

#[cfg(not(unix))]
fn create_dir_all_private(path: &Path) -> Result<(), AgentError> {
    std::fs::create_dir_all(path).map_err(|e| {
        AgentError::Other(format!("cannot create dir {}: {e}", path.display()))
    })?;
    Ok(())
}

/// Force a file to 0600 regardless of what the umask or a pre-existing file
/// allowed.
#[cfg(unix)]
fn set_private(path: &Path) -> Result<(), AgentError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(|e| {
        AgentError::Other(format!("cannot chmod secret file {}: {e}", path.display()))
    })?;
    Ok(())
}

#[cfg(not(unix))]
fn set_private(_path: &Path) -> Result<(), AgentError> {
    Ok(())
}

/// Confirm a file is exactly 0600.
#[cfg(unix)]
fn verify_private(path: &Path) -> Result<(), AgentError> {
    use std::os::unix::fs::PermissionsExt;
    let mode = std::fs::metadata(path)
        .map_err(|e| AgentError::Other(format!("cannot stat {}: {e}", path.display())))?
        .permissions()
        .mode()
        & 0o777;
    if mode == 0o600 {
        Ok(())
    } else {
        Err(AgentError::Other(format!("mode is {mode:#o}")))
    }
}

#[cfg(not(unix))]
fn verify_private(_path: &Path) -> Result<(), AgentError> {
    Ok(())
}

/// Check out a repo into `dest`. Shallow by default; honors an optional ref.
/// If `dest` already holds a checkout, it is fast-forwarded instead of cloned.
pub async fn checkout_repo(
    url: &str,
    branch: Option<&str>,
    dest: &Path,
) -> Result<(), AgentError> {
    let parent = dest.parent().map(Path::to_path_buf).unwrap_or_default();
    if !parent.as_os_str().is_empty() {
        std::fs::create_dir_all(&parent)?;
    }

    let already_repo = dest.join(".git").exists() || dest.join(".git").is_dir();
    let timeout = Duration::from_secs(120);

    if already_repo {
        let mut fetch = vec!["-C".into(), dest.display().to_string()];
        fetch.extend(["fetch".into(), "--depth".into(), "1".into(), "origin".into()]);
        run_git(&fetch, timeout).await?;

        let mut args = vec!["-C".into(), dest.display().to_string(), "checkout".into()];
        if let Some(b) = branch {
            args.push(b.into());
        }
        run_git(&args, timeout).await
    } else {
        let mut args = vec!["clone".into(), "--depth".into(), "1".into()];
        if let Some(b) = branch {
            args.push("--single-branch".into());
            args.push("--branch".into());
            args.push(b.into());
        }
        args.push(url.to_string());
        args.push(dest.display().to_string());
        run_git(&args, timeout).await
    }
}

async fn run_git(args: &[String], timeout: Duration) -> Result<(), AgentError> {
    let mut cmd = tokio::process::Command::new("git");
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let out = tokio::time::timeout(timeout, cmd.output())
        .await
        .map_err(|_| AgentError::Other(format!("git {} timed out", args.first().cloned().unwrap_or_default())))?
        .map_err(|e| AgentError::Other(format!("cannot run git: {e}")))?;

    if !out.status.success() {
        let msg = String::from_utf8_lossy(&out.stderr);
        return Err(AgentError::Other(format!(
            "git {} failed: {}",
            args.first().cloned().unwrap_or_default(),
            msg.trim()
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn secret_file_lands_0600() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let dir = std::env::temp_dir().join(format!("ori-agent-secret-{}", std::process::id()));
            let path = dir.join("sub").join("creds");
            let b64 = base64::engine::general_purpose::STANDARD.encode(b"hunter2");
            write_secret_file(&path, &b64).await.unwrap();
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "secret must be exactly 0600");
            assert_eq!(std::fs::read(&path).unwrap(), b"hunter2");
            std::fs::remove_dir_all(&dir).ok();
        }
    }

    #[tokio::test]
    async fn secret_file_tightens_a_loose_pre_existing_file() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let dir = std::env::temp_dir().join(format!("ori-agent-secret2-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join("creds");
            std::fs::write(&path, b"old").unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
            let b64 = base64::engine::general_purpose::STANDARD.encode(b"new-secret");
            write_secret_file(&path, &b64).await.unwrap();
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
            assert_eq!(std::fs::read(&path).unwrap(), b"new-secret");
            std::fs::remove_dir_all(&dir).ok();
        }
    }

    #[tokio::test]
    async fn bad_secret_payload_fails() {
        let dir = std::env::temp_dir().join(format!("ori-agent-secret3-{}", std::process::id()));
        let path = dir.join("creds");
        assert!(write_secret_file(&path, "not!!base64").await.is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn apply_claim_overlays_env_and_writes_secrets() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let dir = std::env::temp_dir().join(format!("ori-agent-claim-{}", std::process::id()));
            let secret_path = dir.join("s").join("tok");
            let claim = Claim {
                env: HashMap::from([("A".into(), "1".into())]),
                secret_files: vec![crate::config::SecretFile {
                    path: secret_path.clone(),
                    contents_b64: base64::engine::general_purpose::STANDARD.encode(b"v"),
                }],
                repos: vec![],
                setup: None,
            };
            let mut env = HashMap::new();
            env.insert("BASE".into(), "x".into());
            apply_claim(&claim, &mut env).await.unwrap();
            assert_eq!(env["A"], "1");
            assert_eq!(env["BASE"], "x");
            let mode = std::fs::metadata(&secret_path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
            std::fs::remove_dir_all(&dir).ok();
        }
    }
}