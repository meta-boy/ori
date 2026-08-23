//! Environment commands: `env list`, `env info`, `env new`, `env rename`,
//! `env default`, `env rm`, `env set`, `env set-var`, `env rm-var`,
//! `env set-file`, `env rm-file`, `env add-repo`, `env rm-repo`, `env upgrade`.
//!
//! Secret values are **never printed**: a secret var/file's content is redacted
//! to `********` in every human and JSON rendering. The server withholds them
//! entirely; this module just never asks for them back.

use ori_proto::{
    AddRepoRequest, CreateEnvRequest, Environment, EnvironmentList, EnvironmentResponse,
    RenameEnvRequest, SetFileRequest, SetToggleRequest, SetVarRequest, UpgradeReport,
};

type EnvironmentListResponse = EnvironmentList;
use std::io::{self, Write};

use crate::cli::EnvCommand;
use crate::context::Ctx;
use crate::error::CliError;
use crate::render::{print_json, table_string};

// ---------------------------------------------------------------------------
// Wire DTOs (mirror `routes/environments.rs`; kept local so this card owns them)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

pub async fn cmd(sub: &EnvCommand, ctx: &Ctx) -> Result<(), CliError> {
    match sub {
        EnvCommand::List => list(ctx).await,
        EnvCommand::Info { name } => info(name, ctx).await,
        EnvCommand::New { name } => new(name, ctx).await,
        EnvCommand::Rename { old, new } => rename(old, new, ctx).await,
        EnvCommand::Default { name } => set_default(name, ctx).await,
        EnvCommand::Rm { name } => rm(name, ctx).await,
        EnvCommand::Set {
            name,
            toggle,
            on,
            off,
        } => set_toggle(name, toggle, *on, *off, ctx).await,
        EnvCommand::SetVar {
            name,
            key_value,
            secret,
        } => set_var(name, key_value, *secret, ctx).await,
        EnvCommand::RmVar { name, key } => rm_var(name, key, ctx).await,
        EnvCommand::SetFile {
            name,
            key,
            path,
            secret,
        } => set_file(name, key, path, *secret, ctx).await,
        EnvCommand::RmFile { name, key } => rm_file(name, key, ctx).await,
        EnvCommand::AddRepo { name, repo } => add_repo(name, repo, ctx).await,
        EnvCommand::RmRepo { name, repo } => rm_repo(name, repo, ctx).await,
        EnvCommand::Upgrade { name } => upgrade(name, ctx).await,
    }
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

pub async fn list(ctx: &Ctx) -> Result<(), CliError> {
    let res: EnvironmentListResponse = ctx.api.get_json("/environments").await?;
    if ctx.json {
        print_json(&res)?;
    } else {
        render_table(&res.environments);
    }
    Ok(())
}

pub async fn info(name: &str, ctx: &Ctx) -> Result<(), CliError> {
    let res: EnvironmentResponse = ctx
        .api
        .get_json(&format!("/environments/{}", urlencode(name)))
        .await?;
    if ctx.json {
        print_json(&res)?;
    } else {
        render_info(&res.environment);
    }
    Ok(())
}

pub async fn new(name: &str, ctx: &Ctx) -> Result<(), CliError> {
    let res: EnvironmentResponse = ctx
        .api
        .post_json("/environments", &CreateEnvRequest { name: name.into() })
        .await?;
    if ctx.json {
        print_json(&res)?;
    } else {
        println!(
            "created environment `{}` (version {})",
            res.environment.name, res.environment.version
        );
    }
    Ok(())
}

pub async fn rename(old: &str, new: &str, ctx: &Ctx) -> Result<(), CliError> {
    let res: EnvironmentResponse = ctx
        .api
        .post_json(
            &format!("/environments/{}/rename", urlencode(old)),
            &RenameEnvRequest {
                new_name: new.into(),
            },
        )
        .await?;
    if ctx.json {
        print_json(&res)?;
    } else {
        println!(
            "renamed `{old}` -> `{}` (version {})",
            res.environment.name, res.environment.version
        );
    }
    Ok(())
}

pub async fn set_default(name: &str, ctx: &Ctx) -> Result<(), CliError> {
    let res = ctx
        .api
        .post(
            &format!("/environments/{}/default", urlencode(name)),
            &serde_json::json!({}),
        )
        .await?;
    let text = res.text().await.map_err(CliError::from)?;
    if ctx.json {
        println!("{text}");
    } else {
        println!("`{name}` is now the default environment");
    }
    Ok(())
}

pub async fn rm(name: &str, ctx: &Ctx) -> Result<(), CliError> {
    // Deleting an environment is irreversible: its versions, vars and files
    // (including secrets) are gone. Confirm unless --json pipelines it.
    if !ctx.json {
        eprint!(
            "Permanently delete environment `{name}` and all of its versions? This cannot be undone. [y/N] "
        );
        io::stderr().flush().ok();
        let mut line = String::new();
        io::stdin().read_line(&mut line).map_err(CliError::from)?;
        match line.trim().to_lowercase().as_str() {
            "y" | "yes" => {}
            _ => {
                println!("aborted");
                return Err(CliError::usage("aborted"));
            }
        }
    }
    let res = ctx
        .api
        .delete(&format!("/environments/{}", urlencode(name)))
        .await?;
    let text = res.text().await.map_err(CliError::from)?;
    if ctx.json {
        println!("{text}");
    } else {
        println!("deleted environment `{name}`");
    }
    Ok(())
}

pub async fn set_toggle(
    name: &str,
    toggle: &str,
    on: bool,
    off: bool,
    ctx: &Ctx,
) -> Result<(), CliError> {
    if on == off {
        return Err(CliError::usage(
            "one of --on or --off is required for `env set`",
        ));
    }
    let res: EnvironmentResponse = ctx
        .api
        .post_json(
            &format!("/environments/{}/set", urlencode(name)),
            &SetToggleRequest {
                toggle: toggle.into(),
                on,
            },
        )
        .await?;
    if ctx.json {
        print_json(&res)?;
    } else {
        println!(
            "`{}`: {} is now {} (version {})",
            name,
            toggle,
            if on { "on" } else { "off" },
            res.environment.version
        );
    }
    Ok(())
}

pub async fn set_var(name: &str, key_value: &str, secret: bool, ctx: &Ctx) -> Result<(), CliError> {
    let Some((key, value)) = key_value.split_once('=') else {
        return Err(CliError::usage(format!(
            "invalid var {key_value:?}; expected KEY=VALUE"
        )));
    };
    if key.is_empty() {
        return Err(CliError::usage(format!(
            "invalid var {key_value:?}; empty key"
        )));
    }
    let res: EnvironmentResponse = ctx
        .api
        .post_json(
            &format!("/environments/{}/vars", urlencode(name)),
            &SetVarRequest {
                key: key.into(),
                value: value.into(),
                secret,
            },
        )
        .await?;
    if ctx.json {
        print_json(&res)?;
    } else {
        println!(
            "`{}`: set {} `{}` (version {})",
            name,
            if secret { "secret" } else { "var" },
            key,
            res.environment.version
        );
    }
    Ok(())
}

pub async fn rm_var(name: &str, key: &str, ctx: &Ctx) -> Result<(), CliError> {
    let res = ctx
        .api
        .delete(&format!(
            "/environments/{}/vars/{}",
            urlencode(name),
            urlencode(key)
        ))
        .await?;
    let res: EnvironmentResponse = res.json().await.map_err(CliError::from)?;
    if ctx.json {
        print_json(&res)?;
    } else {
        println!(
            "`{}`: removed var `{key}` (version {})",
            name, res.environment.version
        );
    }
    Ok(())
}

pub async fn set_file(
    name: &str,
    key: &str,
    path: &str,
    secret: bool,
    ctx: &Ctx,
) -> Result<(), CliError> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| CliError::usage(format!("cannot read {path}: {e}")))?;
    let res: EnvironmentResponse = ctx
        .api
        .post_json(
            &format!("/environments/{}/files", urlencode(name)),
            &SetFileRequest {
                path: key.into(),
                content,
                secret,
            },
        )
        .await?;
    if ctx.json {
        print_json(&res)?;
    } else {
        println!(
            "`{}`: stored {} at `{key}` from {path} (version {})",
            name,
            if secret { "secret file" } else { "file" },
            res.environment.version
        );
    }
    Ok(())
}

pub async fn rm_file(name: &str, key: &str, ctx: &Ctx) -> Result<(), CliError> {
    let res = ctx
        .api
        .delete(&format!(
            "/environments/{}/files/{}",
            urlencode(name),
            urlencode(key)
        ))
        .await?;
    let res: EnvironmentResponse = res.json().await.map_err(CliError::from)?;
    if ctx.json {
        print_json(&res)?;
    } else {
        println!(
            "`{}`: removed file `{key}` (version {})",
            name, res.environment.version
        );
    }
    Ok(())
}

pub async fn add_repo(name: &str, repo: &str, ctx: &Ctx) -> Result<(), CliError> {
    let (url, branch) = parse_repo(repo)?;
    let res: EnvironmentResponse = ctx
        .api
        .post_json(
            &format!("/environments/{}/repos", urlencode(name)),
            &AddRepoRequest {
                url,
                branch,
                path: None,
            },
        )
        .await?;
    if ctx.json {
        print_json(&res)?;
    } else {
        println!(
            "`{}`: added repo (version {})",
            name, res.environment.version
        );
    }
    Ok(())
}

pub async fn rm_repo(name: &str, repo: &str, ctx: &Ctx) -> Result<(), CliError> {
    let (url, _) = parse_repo(repo)?;
    let res = ctx
        .api
        .delete(&format!(
            "/environments/{}/repos/{}",
            urlencode(name),
            urlencode(&url)
        ))
        .await?;
    let res: EnvironmentResponse = res.json().await.map_err(CliError::from)?;
    if ctx.json {
        print_json(&res)?;
    } else {
        println!(
            "`{}`: removed repo (version {})",
            name, res.environment.version
        );
    }
    Ok(())
}

pub async fn upgrade(name: &str, ctx: &Ctx) -> Result<(), CliError> {
    let report: UpgradeReport = ctx
        .api
        .post_json(
            &format!("/environments/{}/upgrade", urlencode(name)),
            &serde_json::json!({}),
        )
        .await?;
    if ctx.json {
        print_json(&report)?;
    } else {
        println!(
            "`{}` upgraded to version {}: {} sandbox(es) on the environment, {} pushed",
            report.environment, report.version, report.sandboxes, report.applied
        );
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// parsing / rendering helpers
// ---------------------------------------------------------------------------

/// `url[@branch]` → (url, branch).
fn parse_repo(repo: &str) -> Result<(String, Option<String>), CliError> {
    if let Some((url, branch)) = repo.split_once('@') {
        if url.is_empty() || branch.is_empty() {
            return Err(CliError::usage(format!(
                "invalid repo {repo:?}; expected url[@branch]"
            )));
        }
        Ok((url.to_string(), Some(branch.to_string())))
    } else if repo.is_empty() {
        Err(CliError::usage("repo url must not be empty"))
    } else {
        Ok((repo.to_string(), None))
    }
}

/// Encode a path segment. Environment names and keys are restricted to safe
/// characters, but file paths can contain `/` which must survive in the URL.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn render_table(envs: &[Environment]) {
    let header = ["NAME", "DEFAULT", "VERSION", "VARS", "FILES", "REPOS"]
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>();
    let rows: Vec<Vec<String>> = envs
        .iter()
        .map(|e| {
            vec![
                e.name.clone(),
                if e.is_default { "yes" } else { "" }.to_string(),
                e.version.to_string(),
                e.vars.len().to_string(),
                e.files.len().to_string(),
                e.repos.len().to_string(),
            ]
        })
        .collect();
    print!("{}", table_string(&header, &rows));
}

fn render_info(e: &Environment) {
    let rows = [
        ("name", e.name.clone()),
        (
            "isDefault",
            if e.is_default { "yes" } else { "no" }.to_string(),
        ),
        ("version", e.version.to_string()),
        (
            "toggles",
            format!(
                "vars={} files={} secrets={}",
                on_off(e.toggles.inject_vars),
                on_off(e.toggles.inject_files),
                on_off(e.toggles.inject_secrets)
            ),
        ),
    ];
    let w = rows.iter().map(|(k, _)| k.len()).max().unwrap_or(0);
    for (k, v) in rows {
        println!("{:<w$}  {v}", k, w = w);
    }

    if !e.vars.is_empty() {
        println!("\nvars:");
        for v in &e.vars {
            let value = if v.secret {
                "********".to_string()
            } else {
                v.value.clone().unwrap_or_default()
            };
            println!(
                "  {}={} {}",
                v.key,
                value,
                if v.secret { "(secret)" } else { "" }
            );
        }
    }
    if !e.files.is_empty() {
        println!("\nfiles:");
        for f in &e.files {
            println!(
                "  {} {}",
                f.path,
                if f.secret { "(secret)" } else { "(plain)" }
            );
        }
    }
    if !e.repos.is_empty() {
        println!("\nrepos:");
        for r in &e.repos {
            match &r.branch {
                Some(b) => println!("  {}@{} -> {}", r.url, b, r.path),
                None => println!("  {} -> {}", r.url, r.path),
            }
        }
    }
}

fn on_off(b: bool) -> &'static str {
    if b {
        "on"
    } else {
        "off"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_repo_with_and_without_branch() {
        let (url, branch) = parse_repo("https://github.com/u/r.git").unwrap();
        assert_eq!(url, "https://github.com/u/r.git");
        assert!(branch.is_none());
        let (url, branch) = parse_repo("https://github.com/u/r.git@main").unwrap();
        assert_eq!(url, "https://github.com/u/r.git");
        assert_eq!(branch.as_deref(), Some("main"));
        assert!(parse_repo("").is_err());
        assert!(parse_repo("@main").is_err());
        assert!(parse_repo("https://x@").is_err());
    }

    #[test]
    fn urlencode_preserves_safe_chars_and_escapes_rest() {
        assert_eq!(urlencode("prod"), "prod");
        assert_eq!(urlencode("a/b"), "a%2Fb");
        assert_eq!(urlencode("a b"), "a%20b");
    }
}
