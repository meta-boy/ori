//! Wire protocol between the guest agent and the control plane.
//!
//! One JSON object per WebSocket text message, tagged by `"type"`, camelCase
//! field names (matching the control-plane API conventions in
//! `docs/SPEC-API.md`). This is the contract the control plane speaks; it is
//! deliberately self-contained so the server-side tunnel adapter (another
//! crate) can implement against these shapes without pulling this crate in.
//!
//! Flow:
//!
//! ```text
//! agent ──> plane   {"type":"hello", ...}            (sent on every connect)
//! plane ──> agent  {"type":"apply"|"exec"|"execStatus"|"host"|"ping", "id":...}
//! agent ──> plane  {"type":"stream", "id", "fd", "dataB64"}   (0..n, exec output)
//! agent ──> plane  {"type":"execResult"|"applyResult"|"hostResult"|"execStatusResult",
//!                    "id":...}
//! agent ──> plane  {"type":"setupStatus", "status":"pending|running|done|failed",
//!                    "error":...}
//! agent ──> plane  {"type":"error", "id", "code", "message"}   (request failed)
//! ```
//!
//! `exec` streams stdout/stderr as `stream` frames as it arrives, then sends
//! one terminal `execResult`. The plane may ignore the stream frames and use
//! only the aggregated `stdout`/`stderr` in `execResult`, or render them live.
//! A non-zero remote exit code is carried in `execResult.exitCode`; the CLI
//! exits with it, so `ori exec mycmd || handle` can distinguish a failed remote
//! command from a failed API call.
//!
//! ## Byte streams (`plans/C13-agent-streams.md`)
//!
//! ```text
//! plane ──> agent  {"type":"streamOpen", "id", "kind"}       (JSON text)
//! plane ──> agent  [8-byte LE id][bytes]...                  (binary `streamData`)
//! plane ──> agent  {"type":"streamClose", "id", "code"}      (JSON text)
//! agent ──> plane  [8-byte LE id][bytes]...                  (binary `streamData`)
//! agent ──> plane  {"type":"streamClose", "id", "code"}      (JSON text)
//! ```
//!
//! `streamData` is a **binary** WebSocket frame — the raw bytes are not
//! base64-in-JSON, which would inflate every byte ~33% on the hot path. The
//! frame is an 8-byte little-endian stream id followed by the chunk bytes
//! (see [`encode_stream_data`] / [`decode_stream_data`]). The JSON
//! `StreamData` variants below exist so the protocol shape is complete and a
//! stray text `streamData` is not misparsed; the transport is binary.
//!
//! Stream ids are `u64`s chosen by the control plane and are agent-scoped.
//! `streamClose.code` is 0 for a clean close (EOF / all data written) and
//! non-zero for failure:
//!
//! - [`STREAM_CLOSE_OK`] = 0 clean, [`STREAM_CLOSE_REFUSED`] = 1 dial/open
//!   refused, [`STREAM_CLOSE_REJECTED`] = 2 path escaped the work dir,
//!   [`STREAM_CLOSE_IO`] = 3 mid-stream I/O error.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::AgentError;

/// Timeout clamp for `exec`, matching `ori exec --timeout <1-600>`.
pub const EXEC_TIMEOUT_MIN_SECS: u64 = 1;
pub const EXEC_TIMEOUT_MAX_SECS: u64 = 600;
pub const EXEC_TIMEOUT_DEFAULT_SECS: u64 = 30;

/// The conventional exit code for a command killed by the agent timeout, the
/// same value GNU `timeout` uses. Documented so scripts can rely on it.
pub const EXIT_CODE_TIMED_OUT: i32 = 124;

/// Maximum size of the setup-script payload, per `plans/C6-agent.md`.
pub const SETUP_SCRIPT_MAX_BYTES: usize = 64 * 1024;

/// A request from the control plane to the agent.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Incoming {
    /// Liveness probe. The agent replies with an `ack` carrying the same id.
    Ping {
        #[serde(default)]
        id: Option<String>,
    },

    /// Claim-time configuration: env vars, secret files, repo checkouts, and an
    /// optional setup script. Applied before the sandbox is reported ready.
    #[serde(rename_all = "camelCase")]
    Apply {
        id: String,
        #[serde(default)]
        env: Option<HashMap<String, String>>,
        #[serde(default)]
        secret_files: Option<Vec<SecretFileMsg>>,
        #[serde(default)]
        repos: Option<Vec<RepoMsg>>,
        #[serde(default)]
        setup: Option<SetupMsg>,
    },

    /// Run a command. Mirrors `ori exec <id> <cmd...>` with `--cwd`, `--timeout`,
    /// `--detach`, and request-scoped env.
    #[serde(rename_all = "camelCase")]
    Exec {
        id: String,
        /// argv, e.g. `["sh", "-c", "curl ..."]`. Never empty.
        cmd: Vec<String>,
        /// Working directory, relative to the sandbox work dir unless absolute.
        #[serde(default)]
        cwd: Option<String>,
        /// Seconds, clamped to 1..=600; defaults to 30.
        #[serde(default)]
        timeout: Option<u64>,
        #[serde(default)]
        env: Option<HashMap<String, String>>,
        #[serde(default)]
        detach: Option<bool>,
    },

    /// Poll a previously detached process (`ori exec --status <pid>`).
    #[serde(rename_all = "camelCase")]
    ExecStatus { id: String, pid: i64 },

    /// Register a port for reverse proxying and report whether anything is
    /// actually listening on it (and whether it is loopback-only).
    #[serde(rename_all = "camelCase")]
    Host {
        id: String,
        port: u16,
        #[serde(default)]
        public: Option<bool>,
    },

    /// Open a byte stream. `Tcp` dials `127.0.0.1:<port>` inside the sandbox —
    /// the primitive behind `ori forward` and the SSH splice, and it works
    /// because the agent dials outward so nothing needs to be routable inbound.
    /// `File` reads or writes a path rooted at the sandbox work dir; a
    /// directory is tarred (read) or extracted from a tar stream (write). See
    /// `plans/C13-agent-streams.md`.
    #[serde(rename_all = "camelCase")]
    StreamOpen { id: StreamId, kind: StreamKind },

    /// Data for a stream. On the wire this is a *binary* frame (8-byte LE id +
    /// raw bytes), never base64-in-JSON; this variant is here so the protocol
    /// shape is complete and the tunnel can route a text `streamData` too.
    #[serde(rename_all = "camelCase")]
    StreamData { id: StreamId, bytes: Vec<u8> },

    /// Close a stream from the control-plane side. The agent tears down its end
    /// and acks with its own `streamClose`.
    #[serde(rename_all = "camelCase")]
    StreamClose { id: StreamId, code: u16 },
}

/// A secret file to materialize on the sandbox. Contents are base64 so
/// arbitrary bytes survive JSON; the file is written 0600, owned by the sandbox
/// user, directly to its final path — never through a world-readable temp file.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretFileMsg {
    pub path: PathBuf,
    pub contents_b64: String,
}

/// A repo to check out. `ref` is a branch/tag/commit; when absent the remote
/// default branch is used.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoMsg {
    pub url: String,
    #[serde(default)]
    pub r#ref: Option<String>,
    pub path: PathBuf,
}

/// The setup-script payload: either inline base64 script (≤ 64 KiB) or a path
/// to a script the provisioning already placed on the sandbox.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SetupMsg {
    pub script_b64: Option<String>,
    pub path: Option<PathBuf>,
}

/// A frame the agent sends to the control plane.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Outgoing {
    /// Sent immediately after the WebSocket connects. Authenticates the tunnel
    /// and lets the plane route the connection to the right sandbox.
    #[serde(rename_all = "camelCase")]
    Hello {
        #[serde(default)]
        sandbox_id: Option<String>,
        #[serde(default)]
        hostname: Option<String>,
        version: String,
        pid: u32,
    },

    /// Reply to `ping`.
    #[serde(rename_all = "camelCase")]
    Ack { id: String },

    /// Result of `apply`.
    #[serde(rename_all = "camelCase")]
    ApplyResult {
        id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },

    /// A chunk of a running command's output. `fd` is 1 (stdout) or 2 (stderr);
    /// data is base64.
    #[serde(rename_all = "camelCase")]
    Stream {
        id: String,
        fd: u8,
        data_b64: String,
    },

    /// Terminal result of an `exec` request.
    #[serde(rename_all = "camelCase")]
    ExecResult {
        id: String,
        /// Agent-side process id (0 when the command never spawned).
        pid: i64,
        /// True when the command ran to completion; false for `--detach`
        /// (poll with `execStatus`) or when killed by the timeout.
        completed: bool,
        /// The remote exit code. For a timed-out command this is 124
        /// (`EXIT_CODE_TIMED_OUT`). The CLI must exit with this value.
        exit_code: i64,
        duration_ms: i64,
        timed_out: bool,
        detached: bool,
        #[serde(default, skip_serializing_if = "String::is_empty")]
        stdout: String,
        #[serde(default, skip_serializing_if = "String::is_empty")]
        stderr: String,
    },

    /// Result of `execStatus`. `state` is one of `running|exited|lost`.
    /// `lost` means the agent no longer has the process — it may have
    /// restarted under the pid, or the pid was never one of ours.
    #[serde(rename_all = "camelCase")]
    ExecStatusResult {
        id: String,
        state: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        exit_code: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        log_tail: Option<String>,
    },

    /// Result of `host`, and the registration itself: the plane sets up the
    /// reverse proxy for the port and records the listening report.
    #[serde(rename_all = "camelCase")]
    HostResult {
        id: String,
        listening: bool,
        /// True when the listener is bound to 127.0.0.1 / ::1 and would be
        /// unreachable through the public URL. The single most common
        /// `ori host` mistake — detected and called out, not papered over.
        loopback_only: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },

    /// Proactive setup-script status. `status` is one of
    /// `pending|running|done|failed`; `error` is the failure detail for
    /// `failed` (mirrors the sandbox's `setupStatus`/`setupError` fields).
    #[serde(rename_all = "camelCase")]
    SetupStatus {
        status: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },

    /// Data for a stream. The hot path sends this as a *binary* frame (see
    /// [`encode_stream_data`]); if one ever reaches the JSON channel the tunnel
    /// still encodes it binary, never base64.
    #[serde(rename_all = "camelCase")]
    StreamData { id: StreamId, bytes: Vec<u8> },

    /// A stream closed or failed from the agent side. `code` is 0 for a clean
    /// close; see the module docs for the code table.
    #[serde(rename_all = "camelCase")]
    StreamClose { id: StreamId, code: u16 },

    /// A request failed at the transport/parse/spawn level. Carries the request
    /// id when the failure is tied to one.
    #[serde(rename_all = "camelCase")]
    Error {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        code: String,
        message: String,
    },
}

/// Base64-decode a payload.
pub fn decode_b64(s: &str) -> Result<Vec<u8>, AgentError> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(s.trim())
        .map_err(|e| AgentError::Config(format!("bad base64 payload: {e}")))
}

/// Stream ids are `u64`s chosen by the control plane. Agent-scoped: the id
/// space starts fresh on every tunnel reconnect.
pub type StreamId = u64;

/// What a `streamOpen` asks the agent to relay.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StreamKind {
    /// Dial `127.0.0.1:<port>` inside the sandbox and relay bytes both ways.
    Tcp { port: u16 },
    /// Read or write a path rooted at the sandbox work dir. A directory is
    /// tarred over the same stream (read: `tar -cf -`, write: `tar -xf -`).
    File { path: String, mode: StreamFileMode },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StreamFileMode {
    Read,
    Write,
}

/// `streamClose` codes. `STREAM_CLOSE_OK` means clean (EOF, or all data
/// written); the rest are failures the plane should surface to the user.
pub const STREAM_CLOSE_OK: u16 = 0;
pub const STREAM_CLOSE_REFUSED: u16 = 1;
pub const STREAM_CLOSE_REJECTED: u16 = 2;
pub const STREAM_CLOSE_IO: u16 = 3;

/// One binary `streamData` chunk queued for the WebSocket writer. Kept as a
/// struct (rather than a raw `Vec<u8>`) so the writer knows the id to encode
/// and tests can inspect chunks without re-parsing a binary header.
#[derive(Debug, Clone)]
pub struct StreamDataFrame {
    pub id: StreamId,
    pub bytes: Vec<u8>,
}

/// Encode a binary `streamData` frame: 8-byte little-endian stream id followed
/// by the raw chunk bytes.
pub fn encode_stream_data(id: StreamId, bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + bytes.len());
    out.extend_from_slice(&id.to_le_bytes());
    out.extend_from_slice(bytes);
    out
}

/// Decode a binary `streamData` frame into `(id, payload)`.
pub fn decode_stream_data(frame: &[u8]) -> Option<(StreamId, &[u8])> {
    if frame.len() < 8 {
        return None;
    }
    let id = StreamId::from_le_bytes(frame[..8].try_into().ok()?);
    Some((id, &frame[8..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_exec_request_with_camel_case_fields() {
        let raw = r#"{"type":"exec","id":"r1","cmd":["echo","hi"],"cwd":"src","timeout":5,"env":{"A":"1"},"detach":false}"#;
        match serde_json::from_str::<Incoming>(raw).unwrap() {
            Incoming::Exec {
                id,
                cmd,
                cwd,
                timeout,
                env,
                detach,
            } => {
                assert_eq!(id, "r1");
                assert_eq!(cmd, vec!["echo", "hi"]);
                assert_eq!(cwd.as_deref(), Some("src"));
                assert_eq!(timeout, Some(5));
                assert_eq!(env.unwrap()["A"], "1");
                assert_eq!(detach, Some(false));
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn exec_defaults_to_no_detach_and_30s_timeout() {
        let raw = r#"{"type":"exec","id":"r1","cmd":["true"]}"#;
        match serde_json::from_str::<Incoming>(raw).unwrap() {
            Incoming::Exec {
                timeout, detach, ..
            } => {
                assert_eq!(timeout, None);
                assert_eq!(detach, None);
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn parses_apply_with_secrets_and_setup() {
        let raw = r#"{"type":"apply","id":"a1","env":{"K":"V"},"secretFiles":[{"path":"/home/u/.netrc","contentsB64":"c2VjcmV0"}],"repos":[{"url":"https://x/y","ref":"main","path":"repo"}],"setup":{"scriptB64":"ZWNobyBoaQ=="}}"#;
        match serde_json::from_str::<Incoming>(raw).unwrap() {
            Incoming::Apply {
                id,
                env,
                secret_files,
                repos,
                setup,
            } => {
                assert_eq!(id, "a1");
                assert_eq!(env.unwrap()["K"], "V");
                let sf = secret_files.unwrap();
                assert_eq!(sf[0].path, PathBuf::from("/home/u/.netrc"));
                let r = repos.unwrap();
                assert_eq!(r[0].r#ref.as_deref(), Some("main"));
                assert_eq!(setup.unwrap().script_b64.as_deref(), Some("ZWNobyBoaQ=="));
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn serializes_exec_result_camel_case() {
        let out = Outgoing::ExecResult {
            id: "r1".into(),
            pid: 42,
            completed: true,
            exit_code: 7,
            duration_ms: 123,
            timed_out: false,
            detached: false,
            stdout: "hi".into(),
            stderr: String::new(),
        };
        let json = serde_json::to_string(&out).unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["type"], "execResult");
        assert_eq!(v["exitCode"], 7);
        assert_eq!(v["stdout"], "hi");
        // Empty stderr is elided.
        assert!(v.get("stderr").is_none());
    }

    #[test]
    fn serializes_setup_status_camel_case() {
        let out = Outgoing::SetupStatus {
            status: "failed".into(),
            error: Some("boom".into()),
        };
        let v: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&out).unwrap()).unwrap();
        assert_eq!(v["type"], "setupStatus");
        assert_eq!(v["error"], "boom");
    }

    #[test]
    fn decodes_base64() {
        assert_eq!(decode_b64("c2VjcmV0").unwrap(), b"secret");
        assert!(decode_b64("not base64!!").is_err());
    }

    #[test]
    fn parses_stream_open_tcp_and_file() {
        let raw = r#"{"type":"streamOpen","id":7,"kind":{"type":"tcp","port":22}}"#;
        match serde_json::from_str::<Incoming>(raw).unwrap() {
            Incoming::StreamOpen { id, kind } => {
                assert_eq!(id, 7);
                assert!(matches!(kind, StreamKind::Tcp { port: 22 }));
            }
            other => panic!("unexpected: {other:?}"),
        }

        let raw = r#"{"type":"streamOpen","id":8,"kind":{"type":"file","path":"logs/x.txt","mode":"write"}}"#;
        match serde_json::from_str::<Incoming>(raw).unwrap() {
            Incoming::StreamOpen { id, kind } => {
                assert_eq!(id, 8);
                match kind {
                    StreamKind::File { path, mode } => {
                        assert_eq!(path, "logs/x.txt");
                        assert_eq!(mode, StreamFileMode::Write);
                    }
                    other => panic!("unexpected kind: {other:?}"),
                }
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn parses_stream_close() {
        let raw = r#"{"type":"streamClose","id":3,"code":0}"#;
        match serde_json::from_str::<Incoming>(raw).unwrap() {
            Incoming::StreamClose { id, code } => {
                assert_eq!(id, 3);
                assert_eq!(code, 0);
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn serializes_stream_close_camel_case() {
        let out = Outgoing::StreamClose { id: 5, code: 2 };
        let v: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&out).unwrap()).unwrap();
        assert_eq!(v["type"], "streamClose");
        assert_eq!(v["id"], 5);
        assert_eq!(v["code"], 2);
    }

    #[test]
    fn binary_stream_data_round_trips() {
        let payload = (0u8..250).collect::<Vec<_>>();
        let encoded = encode_stream_data(0x1122334455667788, &payload);
        let (id, bytes) = decode_stream_data(&encoded).unwrap();
        assert_eq!(id, 0x1122334455667788);
        assert_eq!(bytes, payload.as_slice());

        // The header is exactly 8 bytes, so a short frame decodes to empty.
        let encoded = encode_stream_data(1, &[]);
        let (id, bytes) = decode_stream_data(&encoded).unwrap();
        assert_eq!((id, bytes), (1, &[][..]));

        // Frames under the header length are malformed.
        assert!(decode_stream_data(&[0, 1, 2]).is_none());
        assert!(decode_stream_data(&[]).is_none());
    }
}
