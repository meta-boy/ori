//! Shell completions plus the hidden `_complete-sandbox` helper that backs
//! dynamic sandbox-id completion. The helper caches IDs for ~15 s so pressing
//! Tab does not hammer the API.

use std::path::PathBuf;

use clap::CommandFactory;

use crate::cli::{Cli, CompletionsArgs, Shell};
use crate::context::Ctx;
use crate::error::CliError;
use crate::wire::SandboxListResponse;

const CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(15);

pub fn run(args: CompletionsArgs) -> Result<(), CliError> {
    let shell = match args.shell {
        Shell::Bash => clap_complete::Shell::Bash,
        Shell::Zsh => clap_complete::Shell::Zsh,
        Shell::Fish => clap_complete::Shell::Fish,
        Shell::PowerShell => clap_complete::Shell::PowerShell,
    };
    // Buffer first: clap_complete panics on a write error, so `completions bash
    // | head` must not crash the process.
    let mut buf = Vec::new();
    {
        let mut cmd = Cli::command();
        clap_complete::generate(shell, &mut cmd, "ori", &mut buf);
    }

    if matches!(args.shell, Shell::Fish) {
        // Dynamic sandbox-id completion: offer live IDs for commands whose
        // first positional is a sandbox id.
        buf.extend_from_slice(b"\n");
        buf.extend_from_slice(
            b"complete -c ori -n '__fish_seen_subcommand_from info stop resume fork extend delete exec ssh scp forward host desktop snapshot' -a '(command ori _complete-sandbox 2>/dev/null)'\n",
        );
    }

    write_stdout(&buf)
}

fn write_stdout(buf: &[u8]) -> Result<(), CliError> {
    use std::io::Write;
    match std::io::stdout().write_all(buf) {
        // A downstream `head` closing the pipe is not an error.
        Err(e) if e.kind() == std::io::ErrorKind::BrokenPipe => Ok(()),
        Err(e) => Err(CliError::from(e)),
        Ok(()) => Ok(()),
    }
}

pub async fn complete_sandbox(ctx: &Ctx) -> Result<(), CliError> {
    let cache = cache_path();
    if let Some(ids) = read_cached(&cache) {
        for id in ids {
            println!("{id}");
        }
        return Ok(());
    }
    let ids = match fetch_ids(ctx).await {
        Ok(ids) => ids,
        Err(_) => return Ok(()), // degrade silently: completion must never error out
    };
    let _ = write_cache(&cache, &ids);
    for id in &ids {
        println!("{id}");
    }
    Ok(())
}

fn cache_path() -> Option<PathBuf> {
    directories::ProjectDirs::from("", "", "ori").map(|d| d.cache_dir().join("sandbox-ids.json"))
}

fn read_cached(path: &Option<PathBuf>) -> Option<Vec<String>> {
    let p = path.as_ref()?;
    let meta = std::fs::metadata(p).ok()?;
    let modified = meta.modified().ok()?;
    if modified.elapsed().ok()? > CACHE_TTL {
        return None;
    }
    let raw = std::fs::read_to_string(p).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_cache(path: &Option<PathBuf>, ids: &[String]) -> Result<(), CliError> {
    let Some(p) = path else {
        return Ok(());
    };
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(p, serde_json::to_string(ids)?).map_err(CliError::from)
}

async fn fetch_ids(ctx: &Ctx) -> Result<Vec<String>, CliError> {
    let page = ctx
        .api
        .get_json::<SandboxListResponse>("/sandboxes?filter=rspte")
        .await?;
    Ok(page.sandboxes.into_iter().map(|s| s.id).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ids.json");
        write_cache(&Some(path.clone()), &["ori_a1b2c3d4".into()]).unwrap();
        assert_eq!(
            read_cached(&Some(path.clone())),
            Some(vec!["ori_a1b2c3d4".to_string()])
        );
    }
}
