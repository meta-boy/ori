//! Account commands: login, logout, status, api-key.

use std::time::Duration;

use serde_json::json;

use crate::cli::{ApiKeyCommand, LoginArgs, LogoutArgs, StatusArgs};
use crate::context::Ctx;
use crate::error::{ApiError, CliError};
use crate::render::{print_json, table_string};
use crate::wire::{
    AccountStatus, ApiKeyCreated, ApiKeyListResponse, ApiKeyRotated, ApiStatus, ConfigStatus,
    LoginPollResponse, LoginStartRequest, LoginStartResponse, MeResponse, StatusOutput,
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
