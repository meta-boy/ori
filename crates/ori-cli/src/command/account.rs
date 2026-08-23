//! Account commands: login, logout, status, api-key, webhook, team,
//! data-retention, dashboard, self-update.

use std::io::{self, Write};
use std::time::Duration;

use serde_json::json;

use crate::cli::{
    ApiKeyCommand, DashboardArgs, DataRetentionCommand, LoginArgs, LogoutArgs, SelfUpdateArgs,
    StatusArgs, TeamCommand, WebhookCommand,
};
use crate::context::Ctx;
use crate::error::{ApiError, CliError};
use crate::render::{print_json, table_string};
use crate::wire::{
    AccountStatus, ApiKeyCreated, ApiKeyListResponse, ApiKeyRotated, ApiStatus, CliVersionResponse,
    ConfigStatus, DataRetentionStatus, LoginPollResponse, LoginStartRequest, LoginStartResponse,
    MeResponse, StatusOutput, TeamListResponse, WebhookCreated, WebhookListResponse,
    WebhookRotated,
};

pub async fn login(args: LoginArgs, ctx: &mut Ctx) -> Result<(), CliError> {
    if let Some(key) = &args.key {
        if key.trim().is_empty() {
            return Err(CliError::usage("empty API key"));
        }
        store_token(ctx, key.clone())?;
        println!("logged in");
        return Ok(());
    }

    let start = ctx
        .api
        .post_json::<LoginStartResponse>(
            "/cli/login/start",
            &LoginStartRequest {
                provider: if args.google {
                    Some("google".into())
                } else {
                    None
                },
                email: args.email.clone(),
            },
        )
        .await?;

    if ctx.json {
        print_json(&start)?;
    } else {
        let verify = start.verification_url.as_deref().unwrap_or(&start.url);
        println!("Go to {verify} and enter code {}", start.code);
    }

    // Poll until a token is issued.
    loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let poll = ctx
            .api
            .get_json::<LoginPollResponse>(&format!("/cli/login/poll/{}", start.id))
            .await?;
        match poll.status.as_str() {
            "active" | "logged_in" => {
                if let Some(token) = poll.token {
                    store_token(ctx, token)?;
                }
                if ctx.json {
                    println!("{{\"status\":\"logged_in\"}}");
                } else {
                    println!("logged in");
                }
                return Ok(());
            }
            "pending" | "waiting" | "poll" => continue,
            "expired" | "denied" | "cancelled" => {
                return Err(CliError::Api(ApiError {
                    status: 0,
                    code: "login_failed".into(),
                    message: format!("login {}", poll.status),
                }));
            }
            other => {
                return Err(CliError::Api(ApiError {
                    status: 0,
                    code: "login_failed".into(),
                    message: format!("unexpected login status {other:?}"),
                }));
            }
        }
    }
}

pub async fn logout(_args: LogoutArgs, ctx: &mut Ctx) -> Result<(), CliError> {
    ctx.config.token = None;
    ctx.api.token = None;
    ctx.save_config()?;
    println!("logged out");
    Ok(())
}

pub async fn status(_args: StatusArgs, ctx: &Ctx) -> Result<(), CliError> {
    let mut api_status = ApiStatus {
        healthy: false,
        status: "unreachable".into(),
        url: ctx.api_url_raw.clone(),
        error: None,
    };
    let mut account: Option<AccountStatus> = None;

    match ctx.api.get_json::<MeResponse>("/me").await {
        Ok(me) => {
            account = Some(AccountStatus {
                identifier: me.identifier,
                login_state: me.login_state,
                status: me.status,
            });
            api_status.healthy = true;
            api_status.status = "healthy".into();
        }
        Err(CliError::Api(e)) => {
            api_status.error = Some(e.message.clone());
            api_status.status = if e.status == 401 || e.status == 403 {
                "unauthenticated".into()
            } else {
                "error".into()
            };
        }
        Err(e) => {
            api_status.error = Some(e.to_string());
            api_status.status = "error".into();
        }
    }

    let path = ctx
        .config_path
        .as_ref()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| "unresolved".to_string());
    let config_status = ConfigStatus {
        api_url: ctx.api_url_raw.clone(),
        channel: ctx.config.channel.clone(),
        path: path.clone(),
    };

    if ctx.json {
        print_json(&StatusOutput {
            account,
            api: api_status,
            config: config_status,
        })?;
        return Ok(());
    }

    match &account {
        Some(a) => println!("account:   {}  ({})", a.identifier, a.status),
        None => println!("account:   not logged in"),
    }
    println!("api:       {}  {}", api_status.url, api_status.status);
    if let Some(err) = &api_status.error {
        println!("           {err}");
    }
    println!("config:    {path}  (channel {})", config_status.channel);
    Ok(())
}

fn store_token(ctx: &mut Ctx, token: String) -> Result<(), CliError> {
    ctx.config.token = Some(token.clone());
    ctx.config.api_url = Some(ctx.api_url_raw.clone());
    ctx.api.token = Some(token);
    ctx.save_config()
}

// ---------------------------------------------------------------------------
// api-key
// ---------------------------------------------------------------------------

pub async fn api_key(cmd: ApiKeyCommand, ctx: &mut Ctx) -> Result<(), CliError> {
    match cmd {
        ApiKeyCommand::Create => api_key_create(ctx).await,
        ApiKeyCommand::List => api_key_list(ctx).await,
        ApiKeyCommand::Rotate { id } => api_key_rotate(ctx, id).await,
        ApiKeyCommand::Revoke { id } => api_key_revoke(ctx, id).await,
    }
}

async fn api_key_create(ctx: &Ctx) -> Result<(), CliError> {
    let created = ctx
        .api
        .post_json::<ApiKeyCreated>("/api-keys", &json!({}))
        .await?;
    if ctx.json {
        print_json(&created)?;
    } else {
        println!("created {}", created.id);
        println!("  key:     {}...{}", created.prefix, created.last_four);
        println!("  secret:  {}", created.secret);
        println!("  (the secret is shown once; store it now)");
    }
    Ok(())
}

async fn api_key_list(ctx: &Ctx) -> Result<(), CliError> {
    let res = ctx.api.get_json::<ApiKeyListResponse>("/api-keys").await?;
    if ctx.json {
        print_json(&res)?;
        return Ok(());
    }
    let header = ["ID", "NAME", "KEY", "CREATED", "STATE"]
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>();
    let rows: Vec<Vec<String>> = res
        .api_keys
        .iter()
        .map(|k| {
            vec![
                k.id.clone(),
                k.name.clone().unwrap_or_default(),
                format!("{}...{}", k.prefix, k.last_four),
                k.created_at.clone(),
                if k.revoked_at.is_some() {
                    "revoked".to_string()
                } else {
                    "active".to_string()
                },
            ]
        })
        .collect();
    print!("{}", table_string(&header, &rows));
    Ok(())
}

async fn api_key_rotate(ctx: &mut Ctx, id: Option<String>) -> Result<(), CliError> {
    let id = resolve_key_id(ctx, id).await?;
    let res = ctx
        .api
        .post_json::<ApiKeyRotated>(&format!("/api-keys/{id}/rotate"), &json!({}))
        .await?;
    let created = &res.api_key;
    if ctx.json {
        print_json(&res)?;
    } else {
        println!("rotated {id}; new key created");
        println!("  id:      {}", created.id);
        println!("  secret:  {}", created.secret);
        println!("  (the secret is shown once; store it now)");
    }
    // If the rotated key was the one we are authenticated as, our stored token
    // is now revoked — replace it with the new secret so the CLI stays usable.
    if res.current {
        ctx.config.token = Some(created.secret.clone());
        ctx.api.token = Some(created.secret.clone());
        ctx.save_config()?;
        if !ctx.json {
            println!("  stored the new secret as your active key");
        }
    }
    Ok(())
}

async fn api_key_revoke(ctx: &Ctx, id: Option<String>) -> Result<(), CliError> {
    let id = resolve_key_id(ctx, id).await?;
    ctx.api
        .post(&format!("/api-keys/{id}/revoke"), &json!({}))
        .await?;
    if ctx.json {
        println!("{{\"revoked\":\"{id}\"}}");
    } else {
        println!("revoked {id}");
    }
    Ok(())
}

/// Resolve the key id when the command did not pass one: use the single active
/// key, and refuse when the answer is ambiguous.
async fn resolve_key_id(ctx: &Ctx, id: Option<String>) -> Result<String, CliError> {
    if let Some(id) = id {
        if id.trim().is_empty() {
            return Err(CliError::usage("empty api key id"));
        }
        return Ok(id);
    }
    let res = ctx.api.get_json::<ApiKeyListResponse>("/api-keys").await?;
    let active: Vec<&crate::wire::ApiKey> = res
        .api_keys
        .iter()
        .filter(|k| k.revoked_at.is_none())
        .collect();
    match active.len() {
        1 => Ok(active[0].id.clone()),
        0 => Err(CliError::usage("no active api keys to operate on")),
        n => Err(CliError::usage(format!(
            "{n} api keys are active; pass the key id explicitly"
        ))),
    }
}

// ---------------------------------------------------------------------------
// webhook
// ---------------------------------------------------------------------------

pub async fn webhook(cmd: WebhookCommand, ctx: &mut Ctx) -> Result<(), CliError> {
    match cmd {
        WebhookCommand::Create { url } => webhook_create(ctx, url).await,
        WebhookCommand::List => webhook_list(ctx).await,
        WebhookCommand::Rotate { id } => webhook_rotate(ctx, id).await,
        WebhookCommand::Remove { id } => webhook_remove(ctx, id).await,
    }
}

async fn webhook_create(ctx: &Ctx, url: String) -> Result<(), CliError> {
    if url.trim().is_empty() {
        return Err(CliError::usage("empty webhook url"));
    }
    let created = ctx
        .api
        .post_json::<WebhookCreated>("/webhooks", &json!({ "url": url }))
        .await?;
    if ctx.json {
        print_json(&created)?;
    } else {
        println!("created {}", created.id);
        println!("  url:      {}", created.url);
        println!("  events:   {}", created.events);
        println!("  key:      {}...{}", created.prefix, created.last_four);
        println!("  secret:   {}", created.secret);
        println!("  (the signing secret is shown once; store it now — the control plane signs every delivery with it)");
    }
    Ok(())
}

async fn webhook_list(ctx: &Ctx) -> Result<(), CliError> {
    let res = ctx.api.get_json::<WebhookListResponse>("/webhooks").await?;
    if ctx.json {
        print_json(&res)?;
        return Ok(());
    }
    let header = ["ID", "URL", "EVENTS", "KEY", "CREATED"]
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>();
    let rows: Vec<Vec<String>> = res
        .webhooks
        .iter()
        .map(|w| {
            vec![
                w.id.clone(),
                w.url.clone(),
                w.events.clone(),
                format!("{}...{}", w.prefix, w.last_four),
                w.created_at.clone(),
            ]
        })
        .collect();
    print!("{}", table_string(&header, &rows));
    Ok(())
}

async fn webhook_rotate(ctx: &Ctx, id: Option<String>) -> Result<(), CliError> {
    let id = resolve_webhook_id(ctx, id).await?;
    let res = ctx
        .api
        .post_json::<WebhookRotated>(&format!("/webhooks/{id}/rotate"), &json!({}))
        .await?;
    let created = &res.webhook;
    if ctx.json {
        print_json(&res)?;
    } else {
        println!("rotated {id}; new signing secret created");
        println!("  key:     {}...{}", created.prefix, created.last_four);
        println!("  secret:  {}", created.secret);
        println!("  (the signing secret is shown once; store it now)");
    }
    Ok(())
}

async fn webhook_remove(ctx: &Ctx, id: Option<String>) -> Result<(), CliError> {
    let id = resolve_webhook_id(ctx, id).await?;
    ctx.api
        .post(&format!("/webhooks/{id}/remove"), &json!({}))
        .await?;
    if ctx.json {
        println!("{{\"removed\":\"{id}\"}}");
    } else {
        println!("removed {id}");
    }
    Ok(())
}

/// Resolve the webhook id when the command did not pass one: use the single
/// webhook, and refuse when the answer is ambiguous.
async fn resolve_webhook_id(ctx: &Ctx, id: Option<String>) -> Result<String, CliError> {
    if let Some(id) = id {
        if id.trim().is_empty() {
            return Err(CliError::usage("empty webhook id"));
        }
        return Ok(id);
    }
    let res = ctx.api.get_json::<WebhookListResponse>("/webhooks").await?;
    match res.webhooks.len() {
        1 => Ok(res.webhooks[0].id.clone()),
        0 => Err(CliError::usage("no webhooks to operate on")),
        n => Err(CliError::usage(format!(
            "{n} webhooks exist; pass the webhook id explicitly"
        ))),
    }
}

// ---------------------------------------------------------------------------
// team
// ---------------------------------------------------------------------------

pub async fn team(cmd: TeamCommand, ctx: &mut Ctx) -> Result<(), CliError> {
    match cmd {
        TeamCommand::List => team_list(ctx).await,
        TeamCommand::Switch { id } => team_switch(ctx, id).await,
    }
}

async fn team_list(ctx: &Ctx) -> Result<(), CliError> {
    let res = ctx.api.get_json::<TeamListResponse>("/teams").await?;
    if ctx.json {
        print_json(&res)?;
        return Ok(());
    }
    let active = ctx.config.team.as_deref();
    let header = ["ID", "NAME", "SCOPE", "ROLE"]
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>();
    let rows: Vec<Vec<String>> = res
        .teams
        .iter()
        .map(|t| {
            let role = if Some(t.id.as_str()) == active {
                format!("{} (active)", t.role)
            } else {
                t.role.clone()
            };
            vec![t.id.clone(), t.name.clone(), t.scope.clone(), role]
        })
        .collect();
    print!("{}", table_string(&header, &rows));
    Ok(())
}

async fn team_switch(ctx: &mut Ctx, id: String) -> Result<(), CliError> {
    if id.trim().is_empty() {
        return Err(CliError::usage("empty team id"));
    }
    // v1: validate the scope exists on the server. With no team backend yet
    // the server returns a single personal scope, so switching is limited to
    // what actually exists rather than silently persisting a typo.
    let res = ctx.api.get_json::<TeamListResponse>("/teams").await?;
    if !res.teams.iter().any(|t| t.id == id) {
        return Err(CliError::usage(format!("unknown team {id:?}")));
    }
    ctx.config.team = Some(id.clone());
    ctx.save_config()?;
    if ctx.json {
        println!("{{\"team\":\"{id}\"}}");
    } else {
        println!("switched to team {id}; it now applies to every `ori new` (use `--personal` to override for one command)");
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// data-retention
// ---------------------------------------------------------------------------

pub async fn data_retention(cmd: DataRetentionCommand, ctx: &Ctx) -> Result<(), CliError> {
    match cmd {
        DataRetentionCommand::Status => data_retention_status(ctx).await,
        DataRetentionCommand::Enable => data_retention_enable(ctx).await,
    }
}

async fn data_retention_status(ctx: &Ctx) -> Result<(), CliError> {
    let res = ctx
        .api
        .get_json::<DataRetentionStatus>("/account/data-retention")
        .await?;
    if ctx.json {
        print_json(&res)?;
        return Ok(());
    }
    // state plainly what is currently true
    if res.enabled {
        println!("delete-on-stop: enabled");
        println!("  sandbox data is destroyed after each stop — nothing is snapshotted");
        println!("  resume and fork have nothing to restore from");
    } else {
        println!("delete-on-stop: disabled");
        println!("  sandboxes are snapshotted on stop");
    }
    Ok(())
}

async fn data_retention_enable(ctx: &Ctx) -> Result<(), CliError> {
    // Irreversible and destructive: explicit confirmation before the toggle
    // flips, and the resume/fork consequence stated at enable time so the user
    // is not surprised on the next resume.
    eprint!(
        "Enable delete-on-stop? Sandbox data will be destroyed after each stop. \
         This is irreversible and destructive. [y/N] "
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
    let res = ctx
        .api
        .post_json::<DataRetentionStatus>("/account/data-retention", &json!({}))
        .await?;
    if ctx.json {
        print_json(&res)?;
    } else {
        println!("delete-on-stop: enabled");
        println!("  from now on, sandbox data is destroyed on stop — no snapshot is taken");
        println!(
            "  resume and fork will have nothing to restore from; only brand-new data survives"
        );
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// dashboard
// ---------------------------------------------------------------------------

pub async fn dashboard(_args: DashboardArgs, ctx: &Ctx) -> Result<(), CliError> {
    // Derive from the configured api-url; never a hardcoded domain.
    let url = format!("{}/dashboard", ctx.api_url_raw.trim_end_matches('/'));
    if ctx.json {
        print_json(&json!({ "url": url }))?;
        return Ok(());
    }
    if open_browser(&url) {
        println!("opened {url}");
    } else {
        println!("dashboard: {url}");
    }
    Ok(())
}

fn open_browser(url: &str) -> bool {
    let opener: &str = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "linux") {
        "xdg-open"
    } else {
        return false;
    };
    std::process::Command::new(opener).arg(url).spawn().is_ok()
}

// ---------------------------------------------------------------------------
// self-update
// ---------------------------------------------------------------------------

pub async fn self_update(args: SelfUpdateArgs, ctx: &Ctx) -> Result<(), CliError> {
    let v = ctx
        .api
        .get_json::<CliVersionResponse>("/cli/version")
        .await?;
    if !v.update_available {
        if ctx.json {
            print_json(&v)?;
        } else {
            println!("already up to date: {} (channel {})", v.current, v.channel);
        }
        return Ok(());
    }
    let Some(base) = v.release_base_url.clone() else {
        return Err(CliError::usage(format!(
            "an update to {} is available but the control plane did not provide a release base URL",
            v.latest
        )));
    };
    if !args.yes {
        eprint!("Install ori {} (channel {})? [y/N] ", v.latest, v.channel);
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
    run_installer(&base, &v.latest).await?;
    Ok(())
}

/// Reuse the existing `install.sh`/`latest.json` contract rather than writing
/// a second updater: install.sh verifies the SHA-256 before writing, refuses
/// downgrades, and refuses channel jumps — and we never set
/// `ORI_INSTALL_FORCE`, so a channel boundary is refused loudly instead of
/// crossed silently.
async fn run_installer(base: &str, version: &str) -> Result<(), CliError> {
    let script = reqwest::get(format!("{}/install.sh", base.trim_end_matches('/')))
        .await?
        .error_for_status()?
        .text()
        .await?;
    let mut child = tokio::process::Command::new("bash")
        .arg("-s")
        .env("ORI_INSTALL_BASE_URL", base)
        .env("ORI_INSTALL_VERSION", version)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::inherit())
        .spawn()?;
    use tokio::io::AsyncWriteExt;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(script.as_bytes()).await?;
        stdin.flush().await?;
    }
    let status = child.wait().await?;
    if status.success() {
        Ok(())
    } else {
        Err(CliError::usage(format!("install.sh exited with {status}")))
    }
}
