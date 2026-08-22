//! Account commands: login, logout, status.

use std::time::Duration;

use crate::cli::{LoginArgs, LogoutArgs, StatusArgs};
use crate::context::Ctx;
use crate::error::{ApiError, CliError};
use crate::render::print_json;
use crate::wire::{
    AccountStatus, ApiStatus, ConfigStatus, LoginPollResponse, LoginStartRequest,
    LoginStartResponse, MeResponse, StatusOutput,
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
                provider: if args.google { Some("google".into()) } else { None },
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
                plan: me.plan,
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
        print_json(&StatusOutput { account, api: api_status, config: config_status })?;
        return Ok(());
    }

    match &account {
        Some(a) => println!("account:   {}  plan {}  ({})", a.identifier, a.plan, a.status),
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