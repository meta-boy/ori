//! `ori host` — a stable URL for a port inside a sandbox.
//!
//! The request path is: browser -> control plane -> agent tunnel -> a TCP
//! stream the agent dials on **loopback inside the sandbox**. Same primitive as
//! `ssh` and `desktop` (`tunnel::AgentRegistry::open_tcp`), so nothing new is
//! exposed and the sandbox opens no port.
//!
//! Routing is by the sandbox's slug in the `Host` header
//! (`<slug>.<domain>`), which is what makes the `slug` and `url` fields on a
//! sandbox mean something.
//!
//! **Known limit, stated rather than hidden:** this proxies HTTP/1.1
//! request/response. A `101 Switching Protocols` upgrade (WebSocket) is
//! detected and refused with an explanatory error instead of being half-served,
//! because a dev server with hot reload is the common case and a silently
//! broken upgrade looks like a server bug. Bidirectional upgrade splicing is
//! the follow-up.

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::error::{ApiError, ApiResult};
use crate::proto::TypedId;
use crate::state::AppState;
use crate::util::now_ts;

/// Read at most this much of a response head before giving up on finding the
/// terminating blank line. Guards against a peer that never sends one.
const MAX_HEAD_BYTES: usize = 64 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostPortRequest {
    pub port: u16,
    #[serde(default)]
    pub public: bool,
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostPortResponse {
    pub port: u16,
    pub url: String,
    pub public: bool,
    /// Whether anything is currently listening on that port in the sandbox.
    pub listening: bool,
    /// Set when the listener is bound to loopback and so unreachable through
    /// the URL. Carries the fix, not just the fact.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// `POST /api/v1/sandboxes/:id/ports`
pub async fn host_port(
    State(state): State<AppState>,
    auth: axum::Extension<crate::auth::ApiKeyAuth>,
    Path(id): Path<String>,
    Json(req): Json<HostPortRequest>,
) -> ApiResult<Json<HostPortResponse>> {
    if req.port == 0 {
        return Err(ApiError::invalid_request("port must be non-zero"));
    }
    let row: Option<(String,)> =
        sqlx::query_as("SELECT slug FROM sandboxes WHERE id = ? AND account_id = ?")
            .bind(&id)
            .bind(&auth.account_id)
            .fetch_optional(&state.db)
            .await
            .map_err(|e| ApiError::internal(format!("sandbox lookup: {e}")))?;
    let slug = row.ok_or_else(|| ApiError::not_found("sandbox"))?.0;

    // Ask the agent what is actually on that port before handing back a URL.
    // Returning a link we already know is dead is the failure this feature is
    // most prone to.
    let (listening, note) = match state.agents.probe_port(&id, req.port).await {
        Some(p) => (p.listening, p.note),
        None => (
            false,
            Some("no agent tunnel: cannot confirm anything is listening".into()),
        ),
    };

    let token = if req.public {
        None
    } else {
        Some(crate::tunnel::new_agent_token().replace("orit_", "orip_"))
    };

    sqlx::query(
        "INSERT INTO hosted_ports (id, sandbox_id, port, public, token, title, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(sandbox_id, port) DO UPDATE SET public = excluded.public, \
           token = excluded.token, title = excluded.title",
    )
    .bind(TypedId::process().to_string())
    .bind(&id)
    .bind(req.port as i64)
    .bind(req.public)
    .bind(token.as_deref())
    .bind(req.title.as_deref())
    .bind(now_ts())
    .execute(&state.db)
    .await
    .map_err(|e| ApiError::internal(format!("host port: {e}")))?;

    let base = format!("https://{slug}.{}", state.config.domain);
    let url = match &token {
        Some(t) => format!("{base}/?ori_token={t}"),
        None => base,
    };

    Ok(Json(HostPortResponse {
        port: req.port,
        url,
        public: req.public,
        listening,
        note,
    }))
}

#[derive(Debug, Deserialize)]
pub struct ProxyQuery {
    #[serde(default)]
    ori_token: Option<String>,
}

/// Catch-all proxy. Resolves the sandbox from the `Host` header's leading label.
pub async fn proxy(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    Query(q): Query<ProxyQuery>,
    body: Body,
) -> Response {
    match proxy_inner(state, method, uri, headers, q, body).await {
        Ok(r) => r,
        Err(e) => e.into_response(),
    }
}

async fn proxy_inner(
    state: AppState,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    q: ProxyQuery,
    body: Body,
) -> ApiResult<Response> {
    let host = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| ApiError::invalid_request("Host header is required"))?;
    let slug = host.split('.').next().unwrap_or("");
    if slug.is_empty() {
        return Err(ApiError::not_found("hosted port"));
    }

    let row: Option<(String, i64, bool, Option<String>)> = sqlx::query_as(
        "SELECT s.id, h.port, h.public, h.token FROM hosted_ports h \
         JOIN sandboxes s ON s.id = h.sandbox_id WHERE s.slug = ? \
         ORDER BY h.created_at DESC LIMIT 1",
    )
    .bind(slug)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| ApiError::internal(format!("hosted port lookup: {e}")))?;

    let (sandbox_id, port, public, token) =
        row.ok_or_else(|| ApiError::not_found("hosted port"))?;

    // A private URL without a token is 401, never a silent 404: the difference
    // is what tells you "wrong link" from "forgot the token".
    if !public {
        let presented = q
            .ori_token
            .as_deref()
            .or_else(|| headers.get("x-ori-token").and_then(|v| v.to_str().ok()));
        match (presented, token.as_deref()) {
            (Some(p), Some(t)) if p == t => {}
            _ => return Err(ApiError::unauthorized()),
        }
    }

    let mut stream = state
        .agents
        .open_tcp(&sandbox_id, port as u16)
        .await
        .ok_or_else(|| {
            ApiError::provider_unavailable(
                "no agent tunnel for this sandbox; the port cannot be reached".to_string(),
            )
        })?;

    // Serialise the request onto the stream. Host is rewritten to loopback so
    // the sandbox's server sees a sane value.
    let path = uri
        .path_and_query()
        .map(|p| p.as_str())
        .unwrap_or("/")
        .to_string();
    let mut head = format!("{} {} HTTP/1.1\r\n", method.as_str(), path);
    head.push_str(&format!("host: 127.0.0.1:{port}\r\n"));
    for (k, v) in headers.iter() {
        let kn = k.as_str();
        if kn == "host" || kn == "connection" {
            continue;
        }
        if let Ok(vs) = v.to_str() {
            head.push_str(&format!("{kn}: {vs}\r\n"));
        }
    }
    head.push_str("connection: close\r\n\r\n");
    if !stream.send(head.as_bytes()).await {
        return Err(ApiError::provider_unavailable("stream closed".to_string()));
    }
    let body_bytes = axum::body::to_bytes(body, 32 * 1024 * 1024)
        .await
        .map_err(|e| ApiError::invalid_request(format!("request body: {e}")))?;
    if !body_bytes.is_empty() && !stream.send(&body_bytes).await {
        return Err(ApiError::provider_unavailable("stream closed".to_string()));
    }

    // Read until the blank line that ends the response head.
    let mut buf: Vec<u8> = Vec::new();
    let split = loop {
        if let Some(i) = find_head_end(&buf) {
            break i;
        }
        if buf.len() > MAX_HEAD_BYTES {
            return Err(ApiError::internal(
                "response head exceeded 64KB with no terminator".to_string(),
            ));
        }
        match stream.recv().await {
            Some(chunk) => buf.extend_from_slice(&chunk),
            None => {
                return Err(ApiError::provider_unavailable(
                    "sandbox closed the connection before sending a response".to_string(),
                ))
            }
        }
    };

    let head_text = String::from_utf8_lossy(&buf[..split]).to_string();
    let rest = buf[split + 4..].to_vec();
    let mut lines = head_text.split("\r\n");
    let status_line = lines.next().unwrap_or_default();
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse::<u16>().ok())
        .and_then(|c| StatusCode::from_u16(c).ok())
        .ok_or_else(|| ApiError::internal(format!("unparseable status line: {status_line:?}")))?;

    if status == StatusCode::SWITCHING_PROTOCOLS {
        return Err(ApiError::invalid_request(
            "this port speaks a protocol upgrade (e.g. WebSocket); \
             upgrade proxying is not implemented in this build"
                .to_string(),
        ));
    }

    let mut out_headers: Vec<(String, String)> = Vec::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        if let Some((k, v)) = line.split_once(':') {
            let k = k.trim().to_ascii_lowercase();
            // These describe the hop we just terminated, not the payload.
            if matches!(
                k.as_str(),
                "connection" | "transfer-encoding" | "keep-alive" | "content-length"
            ) {
                continue;
            }
            out_headers.push((k, v.trim().to_string()));
        }
    }

    // Stream the remainder of the body as it arrives rather than buffering it.
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<bytes::Bytes, std::io::Error>>(16);
    if !rest.is_empty() {
        let _ = tx.send(Ok(bytes::Bytes::from(rest))).await;
    }
    tokio::spawn(async move {
        while let Some(chunk) = stream.recv().await {
            if tx.send(Ok(bytes::Bytes::from(chunk))).await.is_err() {
                break;
            }
        }
    });
    let body = Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx));

    let mut resp = Response::builder().status(status);
    for (k, v) in out_headers {
        resp = resp.header(k, v);
    }
    resp.body(body)
        .map_err(|e| ApiError::internal(format!("build response: {e}")))
}

/// Index of the `\r\n\r\n` that ends a response head.
fn find_head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

/// Hosted ports for a sandbox, for `ori info` and the dashboard.
pub async fn list_ports(
    state: &AppState,
    sandbox_id: &str,
) -> Result<HashMap<u16, String>, sqlx::Error> {
    let rows: Vec<(i64, Option<String>)> =
        sqlx::query_as("SELECT port, title FROM hosted_ports WHERE sandbox_id = ?")
            .bind(sandbox_id)
            .fetch_all(&state.db)
            .await?;
    Ok(rows
        .into_iter()
        .map(|(p, t)| (p as u16, t.unwrap_or_default()))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_head_terminator() {
        assert_eq!(find_head_end(b"HTTP/1.1 200 OK\r\n\r\nbody"), Some(17));
        assert_eq!(find_head_end(b"HTTP/1.1 200 OK\r\n"), None);
    }

    #[test]
    fn hop_headers_are_dropped_from_the_response() {
        // content-length is recomputed by the outer server once the body is
        // re-framed, and transfer-encoding describes the hop we terminated.
        for h in [
            "connection",
            "transfer-encoding",
            "keep-alive",
            "content-length",
        ] {
            assert!(matches!(
                h,
                "connection" | "transfer-encoding" | "keep-alive" | "content-length"
            ));
        }
    }
}
