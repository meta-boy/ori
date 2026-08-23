//! `ori prompt` / `interrupt` / `events` — running a coding agent in a sandbox.
//!
//! A run is a **detached process inside the sandbox** plus an append-only event
//! log. That reuses machinery already verified rather than inventing a second
//! execution path: the guest agent's `--detach` gives a pid, `--status <pid>`
//! gives its state and output tail, and the tunnel carries both.
//!
//! What this deliberately is **not**: a model integration. The provider's own
//! CLI runs inside the sandbox, which is where a coding agent belongs — it has
//! the repo, the toolchain and docker. If that CLI is not installed in the
//! image, the run fails with that as its reason rather than this service
//! pretending to be the agent.
//!
//! The prompt is stored (a run is not reconstructible without it) and is never
//! written to a log line.

use axum::extract::{Extension, Path, Query};
use axum::response::Response;
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::auth::ApiKeyAuth;
use crate::error::{ApiError, ApiResult};
use crate::proto::TypedId;
use crate::state::AppState;
use crate::util::now_ts;

/// Providers we know how to launch, and the argv that launches them.
///
/// Kept explicit rather than accepting a caller-supplied command: `prompt`
/// takes untrusted text, and turning that into a shell string is how the
/// ssh-key endpoint acquired a command injection. The message is passed as its
/// own argv element, never interpolated.
fn provider_argv(provider: &str, model: Option<&str>, effort: Option<&str>) -> Option<Vec<String>> {
    let mut argv: Vec<String> = match provider {
        "claude" | "claude-code" => vec!["claude".into(), "-p".into()],
        "codex" => vec!["codex".into(), "exec".into()],
        _ => return None,
    };
    if let Some(m) = model {
        argv.push("--model".into());
        argv.push(m.to_string());
    }
    if let Some(e) = effort {
        argv.push("--reasoning-effort".into());
        argv.push(e.to_string());
    }
    Some(argv)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptRequest {
    pub provider: String,
    pub message: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptResponse {
    pub run_id: String,
    pub sandbox_id: String,
    pub provider: String,
    pub status: String,
    pub pid: i64,
}

async fn owned_sandbox(state: &AppState, id: &str, account: &str) -> ApiResult<String> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT id FROM sandboxes WHERE id = ? AND account_id = ?")
            .bind(id)
            .bind(account)
            .fetch_optional(&state.db)
            .await
            .map_err(|e| ApiError::internal(format!("sandbox lookup: {e}")))?;
    row.map(|(v,)| v)
        .ok_or_else(|| ApiError::not_found("sandbox"))
}

/// `POST /api/v1/sandboxes/:id/prompt`
pub async fn prompt_sandbox(
    axum::extract::State(state): axum::extract::State<AppState>,
    auth: Extension<ApiKeyAuth>,
    Path(id): Path<String>,
    Json(req): Json<PromptRequest>,
) -> ApiResult<Json<PromptResponse>> {
    owned_sandbox(&state, &id, &auth.account_id).await?;
    if req.message.trim().is_empty() {
        return Err(ApiError::invalid_request("message must not be empty"));
    }
    let mut argv = provider_argv(
        &req.provider,
        req.model.as_deref(),
        req.reasoning_effort.as_deref(),
    )
    .ok_or_else(|| {
        ApiError::invalid_request(format!(
            "unknown provider {:?}; expected claude or codex",
            req.provider
        ))
    })?;
    // The message is its own argv element. Never a shell string.
    argv.push(req.message.clone());

    // Only one run at a time per sandbox: two agents editing the same working
    // tree is a data-loss shape, not a concurrency feature.
    let live: Option<(String,)> = sqlx::query_as(
        "SELECT id FROM agent_runs WHERE sandbox_id = ? AND status = 'running' LIMIT 1",
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| ApiError::internal(format!("run lookup: {e}")))?;
    if let Some((run,)) = live {
        return Err(ApiError::conflict(format!(
            "run {run} is still going; interrupt it first"
        )));
    }

    let frame = state
        .agents
        .exec(&id, &argv, None, Some(600), true)
        .await
        .ok_or_else(|| {
            ApiError::provider_unavailable(
                "no agent tunnel for this sandbox; cannot start a run".to_string(),
            )
        })?;
    if frame.get("type").and_then(|v| v.as_str()) == Some("error") {
        let msg = frame
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("agent rejected the run");
        return Err(ApiError::invalid_request(format!("agent: {msg}")));
    }
    let pid = frame.get("pid").and_then(|v| v.as_i64()).unwrap_or(0);

    let run_id = format!(
        "orirun_{}",
        TypedId::process().to_string().replace("orip_", "")
    );
    sqlx::query(
        "INSERT INTO agent_runs (id, account_id, sandbox_id, provider, model, effort, prompt, \
         status, pid, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)",
    )
    .bind(&run_id)
    .bind(&auth.account_id)
    .bind(&id)
    .bind(&req.provider)
    .bind(req.model.as_deref())
    .bind(req.reasoning_effort.as_deref())
    .bind(&req.message)
    .bind(pid)
    .bind(now_ts())
    .execute(&state.db)
    .await
    .map_err(|e| ApiError::internal(format!("record run: {e}")))?;

    append_event(
        &state,
        &run_id,
        "started",
        &serde_json::json!({"provider": req.provider, "pid": pid}),
    )
    .await;

    Ok(Json(PromptResponse {
        run_id,
        sandbox_id: id,
        provider: req.provider,
        status: "running".into(),
        pid,
    }))
}

async fn append_event(state: &AppState, run_id: &str, kind: &str, payload: &serde_json::Value) {
    let seq: Option<(i64,)> =
        sqlx::query_as("SELECT COALESCE(MAX(seq), 0) + 1 FROM agent_events WHERE run_id = ?")
            .bind(run_id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();
    let _ = sqlx::query(
        "INSERT INTO agent_events (id, run_id, seq, kind, payload, created_at) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(TypedId::process().to_string())
    .bind(run_id)
    .bind(seq.map(|(s,)| s).unwrap_or(1))
    .bind(kind)
    .bind(payload.to_string())
    .bind(now_ts())
    .execute(&state.db)
    .await;
}

/// `POST /api/v1/sandboxes/:id/interrupt`
pub async fn interrupt_sandbox(
    axum::extract::State(state): axum::extract::State<AppState>,
    auth: Extension<ApiKeyAuth>,
    Path(id): Path<String>,
) -> ApiResult<Json<serde_json::Value>> {
    owned_sandbox(&state, &id, &auth.account_id).await?;
    let run: Option<(String, i64)> = sqlx::query_as(
        "SELECT id, COALESCE(pid, 0) FROM agent_runs WHERE sandbox_id = ? AND status = 'running' \
         ORDER BY started_at DESC LIMIT 1",
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| ApiError::internal(format!("run lookup: {e}")))?;
    let Some((run_id, pid)) = run else {
        return Err(ApiError::not_found("no running agent"));
    };

    // TERM the process group, so a provider CLI that spawned children does not
    // leave them behind holding the working tree.
    if pid > 0 {
        let _ = state
            .agents
            .exec(
                &id,
                &[
                    "sh".to_string(),
                    "-c".to_string(),
                    "kill -TERM -\"$1\" 2>/dev/null || kill -TERM \"$1\" 2>/dev/null || true"
                        .to_string(),
                    "ori-interrupt".to_string(),
                    pid.to_string(),
                ],
                None,
                Some(30),
                false,
            )
            .await;
    }
    sqlx::query("UPDATE agent_runs SET status = 'interrupted', finished_at = ? WHERE id = ?")
        .bind(now_ts())
        .bind(&run_id)
        .execute(&state.db)
        .await
        .map_err(|e| ApiError::internal(format!("update run: {e}")))?;
    append_event(&state, &run_id, "interrupted", &serde_json::json!({})).await;
    Ok(Json(
        serde_json::json!({"runId": run_id, "status": "interrupted"}),
    ))
}

#[derive(Debug, Deserialize)]
pub struct EventsQuery {
    /// Resume after this sequence number rather than replaying the whole log.
    #[serde(default)]
    pub after: Option<i64>,
}

/// `GET /api/v1/sandboxes/:id/events` — NDJSON, one event per line.
///
/// Before returning, the latest run is reconciled against the sandbox: a
/// detached process that has exited is recorded as finished with its output,
/// so a run does not sit at `running` forever once its process is gone.
pub async fn events_sandbox(
    axum::extract::State(state): axum::extract::State<AppState>,
    auth: Extension<ApiKeyAuth>,
    Path(id): Path<String>,
    Query(q): Query<EventsQuery>,
) -> ApiResult<Response> {
    owned_sandbox(&state, &id, &auth.account_id).await?;
    reconcile_latest_run(&state, &id).await;

    let after = q.after.unwrap_or(0);
    let rows: Vec<(String, i64, String, String, String)> = sqlx::query_as(
        "SELECT e.run_id, e.seq, e.kind, e.payload, e.created_at FROM agent_events e \
         JOIN agent_runs r ON r.id = e.run_id WHERE r.sandbox_id = ? AND e.seq > ? \
         ORDER BY e.created_at, e.seq",
    )
    .bind(&id)
    .bind(after)
    .fetch_all(&state.db)
    .await
    .map_err(|e| ApiError::internal(format!("events: {e}")))?;

    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    for (run_id, seq, kind, payload, at) in rows {
        let parsed: serde_json::Value =
            serde_json::from_str(&payload).unwrap_or(serde_json::Value::Null);
        let line = serde_json::json!({
            "event": kind, "runId": run_id, "seq": seq, "at": at, "data": parsed,
        });
        // One object per line, newline-terminated: the client parses per line.
        let mut bytes = serde_json::to_vec(&line).unwrap_or_default();
        bytes.push(b'\n');
        let _ = tx.send(axum::body::Bytes::from(bytes));
    }
    drop(tx);
    Ok(crate::ndjson::ndjson_response(
        rx,
        axum::http::StatusCode::OK,
    ))
}

/// Ask the sandbox whether the latest run's process is still alive, and close
/// the run out if it is not.
async fn reconcile_latest_run(state: &AppState, sandbox_id: &str) {
    let run: Option<(String, i64)> = sqlx::query_as(
        "SELECT id, COALESCE(pid, 0) FROM agent_runs WHERE sandbox_id = ? AND status = 'running' \
         ORDER BY started_at DESC LIMIT 1",
    )
    .bind(sandbox_id)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten();
    let Some((run_id, pid)) = run else { return };
    if pid <= 0 {
        return;
    }
    // `--status` on the guest agent reports running | exited | lost plus a tail
    // of the log. `lost` means the agent restarted under the process and can no
    // longer speak for it, which is not the same as success.
    let Some(frame) = state.agents.exec_status(sandbox_id, pid).await else {
        return;
    };
    let st = frame.get("state").and_then(|v| v.as_str()).unwrap_or("");
    if st == "running" {
        return;
    }
    let code = frame.get("exitCode").and_then(|v| v.as_i64()).unwrap_or(-1);
    let out = frame.get("logTail").and_then(|v| v.as_str()).unwrap_or("");
    if !out.is_empty() {
        append_event(state, &run_id, "output", &serde_json::json!({"text": out})).await;
    }
    let status = match (st, code) {
        ("lost", _) => "failed",
        (_, 0) => "completed",
        _ => "failed",
    };
    let _ = sqlx::query(
        "UPDATE agent_runs SET status = ?, exit_code = ?, finished_at = ? WHERE id = ?",
    )
    .bind(status)
    .bind(code)
    .bind(now_ts())
    .bind(&run_id)
    .execute(&state.db)
    .await;
    append_event(
        state,
        &run_id,
        status,
        &serde_json::json!({"exitCode": code, "agentState": st}),
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_argv_is_argv_not_a_shell_string() {
        let a = provider_argv("claude", Some("opus"), Some("high")).unwrap();
        assert_eq!(a[0], "claude");
        assert!(a.contains(&"--model".to_string()));
        assert!(a.contains(&"opus".to_string()));
        assert!(provider_argv("codex", None, None).is_some());
        assert!(provider_argv("gpt-hallucinated", None, None).is_none());
    }

    #[test]
    fn a_prompt_with_shell_metacharacters_stays_one_argument() {
        let mut argv = provider_argv("claude", None, None).unwrap();
        let nasty = "fix this; rm -rf / `id` $(whoami) && echo pwned";
        argv.push(nasty.to_string());
        // The message is exactly one element - nothing split it, so there is no
        // shell to inject into.
        assert_eq!(argv.last().unwrap(), nasty);
        assert_eq!(argv.len(), 3);
    }
}
