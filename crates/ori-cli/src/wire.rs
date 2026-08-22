//! Wire DTOs, NDJSON events, and request shapes for the control-plane API.
//!
//! TODO(reconcile): these types mirror `crates/ori-proto` (being written in
//! parallel). When it lands, replace this module with re-exports of
//! `ori_proto` and delete the local definitions.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// `GET /sandboxes` page. `pageInfo{hasMore,limit,nextCursor}`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxListResponse {
    pub sandboxes: Vec<Sandbox>,
    pub page_info: PageInfo,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageInfo {
    pub has_more: bool,
    pub limit: Option<u32>,
    pub next_cursor: Option<String>,
}

/// The sandbox object from `docs/SPEC-API.md`. Field names are load-bearing:
/// the real client parses these and serialises them back out verbatim.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sandbox {
    pub id: String,
    pub name: String,
    pub state: String,
    #[serde(rename = "type")]
    pub ty: String,
    pub vcpu: u32,
    #[serde(rename = "memoryGB")]
    pub memory_gb: u32,
    pub billing_multiplier: f64,
    pub slug: String,
    pub url: Option<String>,
    pub ip: Option<String>,
    pub ssh_endpoint: Option<String>,
    pub desktop_available: bool,
    pub desktop_url: Option<String>,
    pub environment: String,
    pub environment_version: i32,
    pub created_at: String,
    pub updated_at: String,
    pub stop_after: Option<String>,
    pub snapshot_available: bool,
    pub last_snapshot_attempt_at: Option<String>,
    pub last_snapshot_status: Option<String>,
    pub snapshot_completed_at: Option<String>,
    pub setup_status: Option<String>,
    pub setup_error: Option<String>,
    pub provider: String,
    pub team: Option<String>,
}

/// `GET /sandboxes/{id}` wraps the sandbox — the wrapper is load-bearing.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxResponse {
    pub sandbox: Sandbox,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopRequest {
    pub force: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ty: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttl_seconds: Option<u64>,
    pub no_auto_stop: bool,
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    pub env: HashMap<String, String>,
    pub no_env: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub setup_script: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_snapshot: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team: Option<String>,
    pub personal: bool,
}

/// `POST /sandboxes/{id}/exec`. Wire shape TODO(reconcile) with ori-proto.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecRequest {
    pub command: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub timeout: u32,
    pub detach: bool,
}

/// `POST /sandboxes/{id}/exec` / `GET /sandboxes/{id}/exec/{pid}` result.
/// Wire shape TODO(reconcile) with ori-proto.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResponse {
    pub pid: u64,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub stdout: Option<String>,
    #[serde(default)]
    pub stderr: Option<String>,
}

/// `POST /cli/login/start`. Wire shape TODO(reconcile) with ori-proto.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStartRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStartResponse {
    pub id: String,
    pub code: String,
    pub url: String,
    #[serde(default)]
    pub verification_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginPollResponse {
    pub status: String,
    #[serde(default)]
    pub token: Option<String>,
}

/// `GET /me` — account identity for `ori status`. Wire shape TODO(reconcile).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeResponse {
    pub identifier: String,
    #[serde(default)]
    pub login_state: String,
    #[serde(default)]
    pub plan: String,
    #[serde(default)]
    pub status: String,
}

/// `ori status` output object (matches the JSON in `docs/SPEC-API.md`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusOutput {
    pub account: Option<AccountStatus>,
    pub api: ApiStatus,
    pub config: ConfigStatus,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    pub identifier: String,
    pub login_state: String,
    pub plan: String,
    pub status: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiStatus {
    pub healthy: bool,
    pub status: String,
    pub url: String,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigStatus {
    pub api_url: String,
    pub channel: String,
    pub path: String,
}

/// NDJSON lifecycle events for `new` / `resume` / `fork`. Serialises to the
/// exact lines quoted in `docs/SPEC-API.md`.
#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "event",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Event {
    Created {
        id: String,
        #[serde(default)]
        ttl_seconds: Option<u64>,
        #[serde(default)]
        team: Option<String>,
    },
    State {
        id: String,
        state: String,
    },
    Accepted {
        id: String,
        status: String,
    },
    Ready {
        id: String,
        #[serde(default)]
        state: String,
        #[serde(default)]
        ip: Option<String>,
        #[serde(default)]
        url: Option<String>,
        #[serde(default)]
        desktop_url: Option<String>,
        #[serde(default)]
        stop_after: Option<String>,
        #[serde(default)]
        commands: Option<HashMap<String, String>>,
    },
    Error {
        #[serde(default)]
        id: Option<String>,
        code: String,
        message: String,
    },
}

/// Human-renderable summary of the terminal `ready` event.
#[derive(Debug, Clone)]
pub struct ReadyInfo {
    pub id: String,
    pub state: String,
    pub ip: Option<String>,
    pub url: Option<String>,
    pub desktop_url: Option<String>,
    pub stop_after: Option<String>,
    pub commands: Option<HashMap<String, String>>,
}

pub fn valid_types() -> &'static [&'static str] {
    &["small", "default", "large"]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_deserialise_from_spec_lines() {
        let created: Event = serde_json::from_str(
            r#"{"event":"created","id":"ori_a1b2c3d4","ttlSeconds":900,"team":null}"#,
        )
        .unwrap();
        assert!(
            matches!(created, Event::Created { id, ttl_seconds: Some(900), .. } if id == "ori_a1b2c3d4")
        );

        let state: Event =
            serde_json::from_str(r#"{"event":"state","id":"ori_a1b2c3d4","state":"cloning"}"#)
                .unwrap();
        assert!(matches!(state, Event::State { state, .. } if state == "cloning"));

        let ready: Event = serde_json::from_str(
            r#"{"event":"ready","id":"ori_a1b2c3d4","state":"ready","ip":"10.0.0.12","url":"https://slug.domain","desktopUrl":"x","stopAfter":"t","commands":{"ssh":"ori ssh ori_a1b2c3d4"}}"#,
        )
        .unwrap();
        match ready {
            Event::Ready {
                id, ip, commands, ..
            } => {
                assert_eq!(id, "ori_a1b2c3d4");
                assert_eq!(ip.as_deref(), Some("10.0.0.12"));
                assert_eq!(
                    commands.as_ref().unwrap().get("ssh").unwrap(),
                    "ori ssh ori_a1b2c3d4"
                );
            }
            _ => panic!("expected ready"),
        }

        let error: Event =
            serde_json::from_str(r#"{"event":"error","id":"ori_a1b2c3d4","code":"provider_unavailable","message":"..."}"#)
                .unwrap();
        match error {
            Event::Error { code, message, .. } => {
                assert_eq!(code, "provider_unavailable");
                assert_eq!(message, "...");
            }
            _ => panic!("expected error"),
        }
    }

    #[test]
    fn sandbox_uses_exact_wire_field_names() {
        let raw = r#"{"id":"ori_a1b2c3d4","name":"n","state":"ready","type":"default","vcpu":4,
            "memoryGB":8,"billingMultiplier":1,"slug":"s","url":null,"ip":"10.0.0.12",
            "sshEndpoint":null,"desktopAvailable":true,"desktopUrl":null,"environment":"base",
            "environmentVersion":1,"createdAt":"t","updatedAt":"t","stopAfter":null,
            "snapshotAvailable":true,"lastSnapshotAttemptAt":null,"lastSnapshotStatus":null,
            "snapshotCompletedAt":null,"setupStatus":"done","setupError":null,"provider":"proxmox",
            "team":null}"#;
        let s: Sandbox = serde_json::from_str(raw).unwrap();
        assert_eq!(s.ty, "default");
        assert_eq!(s.memory_gb, 8);
        assert_eq!(s.billing_multiplier, 1.0);
        assert_eq!(s.ip.as_deref(), Some("10.0.0.12"));
        // And serialises back out with the same field names.
        let out = serde_json::to_value(&s).unwrap();
        assert!(out.get("type").is_some(), "must serialise `type`, not `ty`");
        assert!(out.get("memoryGB").is_some());
        assert!(out.get("billingMultiplier").is_some());
        assert!(out.get("ty").is_none());
    }
}
