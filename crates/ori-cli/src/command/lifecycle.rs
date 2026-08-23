//! Lifecycle commands: new, list, info, stop, resume, fork, delete.

use std::collections::HashMap;
use std::io::{self, Write};

use reqwest::Response;

use crate::cli::{
    DeleteArgs, ExtendArgs, ForkArgs, InfoArgs, ListArgs, NewArgs, OperationArgs, ResumeArgs,
    StopArgs,
};
use crate::context::Ctx;
use crate::error::{ApiError, CliError};
use crate::render::{print_json, table_string};
use crate::stream::consume_ndjson;
use crate::wire::{
    valid_types, CreateRequest, Event, ExtendResponse, OperationResponse, ReadyInfo, Sandbox,
    SandboxListResponse, SandboxResponse, StopRequest,
};

pub async fn new(args: NewArgs, ctx: &Ctx) -> Result<(), CliError> {
    validate_type(args.type_.as_deref())?;
    let setup_script = match &args.setup_file {
        Some(path) => Some(
            std::fs::read_to_string(path)
                .map_err(|e| CliError::usage(format!("cannot read setup file {path}: {e}")))?,
        ),
        None => None,
    };
    let req = CreateRequest {
        ty: args.type_.clone(),
        ttl_seconds: args.ttl,
        no_auto_stop: args.no_auto_stop,
        env: parse_env(&args.env)?,
        no_env: args.no_env,
        setup_script,
        environment: args.environment.clone(),
        from_snapshot: args.from.clone(),
        // Billing scope priority: explicit `--team` wins; `--personal`
        // overrides for this one command; otherwise the sticky team set by
        // `ori team switch` applies to every `new`.
        team: args.team.clone().or_else(|| {
            if args.personal {
                None
            } else {
                ctx.config.team.clone()
            }
        }),
        personal: args.personal,
        no_stop: false,
    };
    let res = ctx.api.post_stream("/sandboxes", &req).await?;
    let result = stream_progress(ctx, res).await?;
    if !ctx.json {
        finish_stream(&result);
    }
    Ok(())
}

pub async fn list(args: ListArgs, ctx: &Ctx) -> Result<(), CliError> {
    let filter = if args.all {
        "rspte".to_string()
    } else {
        args.filter.clone()
    };
    let mut all = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let query = match &cursor {
            Some(c) => format!("filter={filter}&cursor={c}"),
            None => format!("filter={filter}"),
        };
        let page = ctx
            .api
            .get_json::<SandboxListResponse>(&format!("/sandboxes?{query}"))
            .await?;
        let has_more = page.page_info.has_more;
        all.extend(page.sandboxes);
        cursor = page.page_info.next_cursor;
        if !has_more || cursor.is_none() {
            break;
        }
    }
    if ctx.json {
        // Wire shape from SPEC-API.md; merged pages, terminal pageInfo.
        print_json(&serde_json::json!({
            "sandboxes": all,
            "pageInfo": { "hasMore": false, "limit": null, "nextCursor": null },
        }))?;
    } else {
        render_table(&all);
    }
    Ok(())
}

pub async fn info(args: InfoArgs, ctx: &Ctx) -> Result<(), CliError> {
    let res = ctx
        .api
        .get_json::<SandboxResponse>(&format!("/sandboxes/{}", args.id))
        .await?;
    if ctx.json {
        print_json(&res.sandbox)?;
    } else {
        render_info(&res.sandbox);
    }
    Ok(())
}

pub async fn stop(args: StopArgs, ctx: &Ctx) -> Result<(), CliError> {
    let req = StopRequest { force: args.force };
    let res = ctx
        .api
        .post(&format!("/sandboxes/{}/stop", args.id), &req)
        .await?;
    let text = res.text().await.map_err(CliError::from)?;
    if ctx.json {
        println!("{text}");
    } else if args.force {
        println!(
            "stopped {} (no snapshot; changes since the last snapshot are lost)",
            args.id
        );
    } else {
        println!("stopped {} (snapshot taken)", args.id);
    }
    Ok(())
}

pub async fn resume(args: ResumeArgs, ctx: &Ctx) -> Result<(), CliError> {
    validate_type(args.opts.type_.as_deref())?;
    let req = resume_request(&args.opts);
    let res = ctx
        .api
        .post_stream(&format!("/sandboxes/{}/resume", args.id), &req)
        .await?;
    let result = stream_progress(ctx, res).await?;
    if !ctx.json {
        finish_stream(&result);
    }
    Ok(())
}

pub async fn fork(args: ForkArgs, ctx: &Ctx) -> Result<(), CliError> {
    validate_type(args.opts.type_.as_deref())?;
    let mut req = resume_request(&args.opts);
    // Forks default to a 1h TTL and never inherit the source's.
    req.ttl_seconds = Some(args.opts.ttl.unwrap_or(3600));
    // --no-stop refuses a running source with no stopped snapshot instead of
    // stopping, snapshotting and restarting it.
    req.no_stop = args.no_stop;
    let res = ctx
        .api
        .post_stream(&format!("/sandboxes/{}/fork", args.id), &req)
        .await?;
    let result = stream_progress(ctx, res).await?;
    if !ctx.json {
        finish_stream(&result);
    }
    Ok(())
}

pub async fn delete(args: DeleteArgs, ctx: &Ctx) -> Result<(), CliError> {
    if !args.yes {
        // Always prompt when not --yes; a piped stdout must not silence the
        // confirmation.
        eprint!(
            "Permanently delete sandbox {}? This cannot be undone. [y/N] ",
            args.id
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
    let res = ctx.api.delete(&format!("/sandboxes/{}", args.id)).await?;
    let text = res.text().await.map_err(CliError::from)?;
    if ctx.json {
        println!("{text}");
    } else {
        println!("deleted {}", args.id);
    }
    Ok(())
}

pub async fn extend(args: ExtendArgs, ctx: &Ctx) -> Result<(), CliError> {
    let mut req = serde_json::Map::new();
    if let Some(h) = args.hours {
        req.insert("hours".into(), serde_json::json!(h));
    }
    if let Some(t) = args.ttl {
        req.insert("ttlSeconds".into(), serde_json::json!(t));
    }
    if args.no_auto_stop {
        req.insert("noAutoStop".into(), serde_json::json!(true));
    }
    if req.is_empty() {
        return Err(CliError::usage(
            "one of --hours, --ttl, --no-auto-stop is required",
        ));
    }
    let res = ctx
        .api
        .post_json::<ExtendResponse>(
            &format!("/sandboxes/{}/extend", args.id),
            &serde_json::Value::Object(req),
        )
        .await?;
    if ctx.json {
        print_json(&res)?;
    } else {
        match &res.stop_after {
            Some(deadline) => println!("{}: new auto-stop deadline {}", args.id, deadline),
            None => println!("{}: auto-stop disabled", args.id),
        }
    }
    Ok(())
}

pub async fn operation(args: OperationArgs, ctx: &Ctx) -> Result<(), CliError> {
    let res = ctx
        .api
        .get_json::<OperationResponse>(&format!("/operations/{}", args.id))
        .await?;
    let op = &res.operation;
    if ctx.json {
        print_json(&res)?;
        return Ok(());
    }
    println!("{}  {}", op.id, op.status);
    if let Some(reason) = &op.blocked_reason {
        println!("  blocked: {reason}");
    }
    if let Some(err) = &op.error {
        println!("  error: {err}");
    }
    match op.status.as_str() {
        "completed" => {
            if let Some(t) = &op.completed_at {
                println!("  completed at: {t}");
            }
        }
        "pending" | "processing" => {
            println!("  created: {} · updated: {}", op.created_at, op.updated_at)
        }
        _ => {}
    }
    Ok(())
}

// ---------------------------------------------------------------------------

fn resume_request(opts: &crate::cli::ResumeOptions) -> CreateRequest {
    CreateRequest {
        ty: opts.type_.clone(),
        ttl_seconds: opts.ttl,
        no_auto_stop: opts.no_auto_stop,
        env: parse_env(&opts.env).unwrap_or_default(),
        no_env: opts.no_env,
        environment: opts.environment.clone(),
        ..CreateRequest::default()
    }
}

fn validate_type(t: Option<&str>) -> Result<(), CliError> {
    if let Some(t) = t {
        if !valid_types().contains(&t) {
            return Err(CliError::usage(format!(
                "invalid type {t:?}; expected one of {}",
                valid_types().join(", ")
            )));
        }
    }
    Ok(())
}

fn parse_env(kvs: &[String]) -> Result<HashMap<String, String>, CliError> {
    let mut map = HashMap::new();
    for kv in kvs {
        let Some((k, v)) = kv.split_once('=') else {
            return Err(CliError::usage(format!(
                "invalid env {kv:?}; expected KEY=VALUE"
            )));
        };
        if k.is_empty() {
            return Err(CliError::usage(format!("invalid env {kv:?}; empty key")));
        }
        map.insert(k.to_string(), v.to_string());
    }
    Ok(map)
}

pub struct StreamResult {
    pub ready: Option<ReadyInfo>,
}

pub async fn stream_progress(ctx: &Ctx, res: Response) -> Result<StreamResult, CliError> {
    let mut ready: Option<ReadyInfo> = None;
    consume_ndjson(res, |line| {
        if ctx.json {
            println!("{line}");
            io::stdout().flush().ok();
        }
        match serde_json::from_str::<Event>(line) {
            Ok(Event::Created { id, .. }) => {
                if !ctx.json {
                    println!("created {id}");
                }
            }
            Ok(Event::State { id, state }) => {
                if !ctx.json {
                    println!("{id}: {state}");
                }
            }
            Ok(Event::Accepted { id, status }) => {
                if !ctx.json {
                    println!("{id}: {status}");
                }
            }
            Ok(Event::Ready {
                id,
                state,
                ip,
                url,
                desktop_url,
                stop_after,
                commands,
                ..
            }) => {
                ready = Some(ReadyInfo {
                    id,
                    state,
                    url,
                    ip,
                    desktop_url,
                    stop_after,
                    commands,
                });
            }
            Ok(Event::Notice { id, message }) => {
                let who = id.unwrap_or_else(|| "sandbox".to_string());
                if !ctx.json {
                    println!("{who}: {message}");
                }
            }
            Ok(Event::Error { id, code, message }) => {
                let who = id.unwrap_or_else(|| "sandbox".to_string());
                if ctx.json {
                    return Err(CliError::Api(ApiError {
                        status: 0,
                        code,
                        message,
                    }));
                }
                return Err(CliError::Api(ApiError {
                    status: 0,
                    code,
                    message: format!("{who}: {message}"),
                }));
            }
            Err(_) => {
                // Unknown or future event shapes; ignore rather than die.
            }
        }
        Ok(())
    })
    .await?;
    Ok(StreamResult { ready })
}

fn finish_stream(result: &StreamResult) {
    match &result.ready {
        Some(r) => {
            println!();
            println!("ready {}", r.id);
            if let Some(url) = &r.url {
                println!("  url:    {url}");
            }
            if let Some(ip) = &r.ip {
                println!("  ip:     {ip}");
            }
            if let Some(cmd) = r.commands.as_ref().and_then(|m| m.get("ssh")) {
                println!("  ssh:    {cmd}");
            }
            if let Some(cmd) = r.commands.as_ref().and_then(|m| m.get("forward")) {
                println!("  forward: {cmd}");
            }
        }
        None => println!("done"),
    }
}

fn render_table(sandboxes: &[Sandbox]) {
    let header = ["ID", "STATE", "TYPE", "IP", "URL", "STOPS IN"]
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>();
    let rows: Vec<Vec<String>> = sandboxes
        .iter()
        .map(|s| {
            vec![
                s.id.clone(),
                s.state.clone(),
                s.ty.clone(),
                s.ip.clone().unwrap_or_default(),
                s.url.clone().unwrap_or_default(),
                stops_in(&s.stop_after),
            ]
        })
        .collect();
    print!("{}", table_string(&header, &rows));
}

fn stops_in(stop_after: &Option<String>) -> String {
    let Some(ts) = stop_after else {
        return "-".to_string();
    };
    match chrono::DateTime::parse_from_rfc3339(ts) {
        Ok(t) => {
            let diff = t.with_timezone(&chrono::Utc) - chrono::Utc::now();
            if diff < chrono::Duration::zero() {
                return "expired".to_string();
            }
            // Round to the nearest minute.
            let mins = (diff.num_seconds() + 30) / 60;
            format!("{mins}m")
        }
        Err(_) => ts.clone(),
    }
}

fn render_info(s: &Sandbox) {
    let rows = [
        ("id", s.id.clone()),
        ("name", s.name.clone()),
        ("state", s.state.clone()),
        (
            "type",
            format!("{} ({} vCPU, {} GB)", s.ty, s.vcpu, s.memory_gb),
        ),
        ("url", s.url.clone().unwrap_or_else(|| "-".to_string())),
        ("ip", s.ip.clone().unwrap_or_else(|| "-".to_string())),
        (
            "environment",
            format!("{} v{}", s.environment, s.environment_version),
        ),
        (
            "stopAfter",
            s.stop_after.clone().unwrap_or_else(|| "-".to_string()),
        ),
        (
            "snapshotAvailable",
            if s.snapshot_available {
                "yes".to_string()
            } else {
                "no".to_string()
            },
        ),
        (
            "setupStatus",
            s.setup_status.clone().unwrap_or_else(|| "-".to_string()),
        ),
        ("provider", s.provider.clone()),
        ("team", s.team.clone().unwrap_or_else(|| "-".to_string())),
    ];
    let w = rows.iter().map(|(k, _)| k.len()).max().unwrap_or(0);
    for (k, v) in rows {
        println!("{:<w$}  {v}", k, w = w);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_parsing() {
        let map = parse_env(&["A=B".into(), "C=D=E".into()]).unwrap();
        assert_eq!(map.get("A").unwrap(), "B");
        assert_eq!(map.get("C").unwrap(), "D=E");
        assert!(parse_env(&["BROKEN".into()]).is_err());
        assert!(parse_env(&["=x".into()]).is_err());
    }

    #[test]
    fn type_validation() {
        assert!(validate_type(None).is_ok());
        assert!(validate_type(Some("default")).is_ok());
        assert!(validate_type(Some("gigantic")).is_err());
    }

    #[test]
    fn stops_in_renders_minutes() {
        let future = (chrono::Utc::now() + chrono::Duration::minutes(12)).to_rfc3339();
        assert_eq!(stops_in(&Some(future)), "12m");
        assert_eq!(stops_in(&None), "-");
    }
}
