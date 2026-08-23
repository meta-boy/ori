//! `prompt`, `interrupt`, `events` — driving a coding agent inside a sandbox.
//!
//! A run is a detached process in the sandbox plus an append-only event log,
//! so `events` both replays a finished run and follows a live one. The message
//! is sent as JSON and lands as a single argv element in the sandbox; it is
//! never interpolated into a shell string.

use std::io::{self, Write};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::cli::{EventsArgs, InterruptArgs, PromptArgs};
use crate::context::Ctx;
use crate::error::CliError;
use crate::render::print_json;

/// How often `--follow` asks for events newer than the last one seen.
const FOLLOW_POLL: Duration = Duration::from_millis(1500);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PromptBody {
    provider: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromptRes {
    run_id: String,
    sandbox_id: String,
    provider: String,
    status: String,
    pid: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InterruptRes {
    run_id: String,
    status: String,
}

pub async fn prompt(args: PromptArgs, ctx: &Ctx) -> Result<(), CliError> {
    let message = args.message.join(" ");
    if message.trim().is_empty() {
        return Err(CliError::usage("prompt requires a message"));
    }
    let res: PromptRes = ctx
        .api
        .post_json(
            &format!("/sandboxes/{}/prompt", args.id),
            &PromptBody {
                provider: args.provider.clone(),
                message,
                model: args.model.clone(),
                reasoning_effort: args.reasoning_effort.clone(),
            },
        )
        .await?;
    if ctx.json {
        print_json(&res)?;
        return Ok(());
    }
    let mut out = io::stdout();
    writeln!(out, "run {} started ({})", res.run_id, res.provider)?;
    writeln!(out, "follow it with:  ori events {} --follow", args.id)?;
    Ok(())
}

pub async fn interrupt(args: InterruptArgs, ctx: &Ctx) -> Result<(), CliError> {
    let res: InterruptRes = ctx
        .api
        .post_json(&format!("/sandboxes/{}/interrupt", args.id), &())
        .await?;
    if ctx.json {
        print_json(&res)?;
        return Ok(());
    }
    writeln!(io::stdout(), "run {} {}", res.run_id, res.status)?;
    Ok(())
}

/// Render the event stream, optionally following it.
///
/// Each poll asks only for events after the highest `seq` already seen, so
/// following does not re-print history and a long-running agent's log is not
/// re-fetched every interval.
pub async fn events(args: EventsArgs, ctx: &Ctx) -> Result<(), CliError> {
    let deadline = args
        .timeout
        .map(|s| Instant::now() + Duration::from_secs(s as u64));
    let mut after: i64 = 0;
    let mut out = io::stdout();

    loop {
        let path = format!("/sandboxes/{}/events?after={}", args.id, after);
        // `get` already turns a 4xx/5xx into an ApiError carrying the server's
        // reason, so only transport failures need handling here.
        let text = ctx
            .api
            .get(&path)
            .await?
            .text()
            .await
            .map_err(|e| CliError::usage(format!("reading events: {e}")))?;
        for line in text.lines().filter(|l| !l.trim().is_empty()) {
            if ctx.json {
                writeln!(out, "{line}")?;
            } else {
                match serde_json::from_str::<serde_json::Value>(line) {
                    Ok(v) => {
                        let kind = v.get("event").and_then(|x| x.as_str()).unwrap_or("event");
                        let data = v.get("data").cloned().unwrap_or(serde_json::Value::Null);
                        // `output` carries the agent's own text; print it as
                        // text rather than as a JSON blob a human has to decode.
                        if kind == "output" {
                            if let Some(t) = data.get("text").and_then(|x| x.as_str()) {
                                write!(out, "{t}")?;
                            }
                        } else {
                            writeln!(out, "[{kind}] {data}")?;
                        }
                    }
                    Err(_) => writeln!(out, "{line}")?,
                }
            }
            if let Some(seq) = serde_json::from_str::<serde_json::Value>(line)
                .ok()
                .and_then(|v| v.get("seq").and_then(|x| x.as_i64()))
            {
                after = after.max(seq);
            }
        }
        let _ = out.flush();

        if !args.follow {
            return Ok(());
        }
        if let Some(d) = deadline {
            if Instant::now() >= d {
                return Ok(());
            }
        }
        tokio::time::sleep(FOLLOW_POLL).await;
    }
}
