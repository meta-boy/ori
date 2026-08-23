//! The client's view of the wire contract.
//!
//! The shared shapes come from `ori-proto`. They used to be declared a second
//! time here and the copies drifted: this file required `memoryGB` while the
//! server emitted `memoryGb`, and `ori list` broke outright. Both sides
//! round-tripped their own copy perfectly, which is why no test caught it.
//!
//! What is left below is genuinely client-only -- the shape of rendered output
//! (`ori status`, `ReadyInfo`) that no endpoint returns, and request bodies the
//! server accepts structurally without naming.

pub use ori_proto::{
    Account, ApiKey, ApiKeyCreated, ApiKeyList, ApiKeyRotated, BoxState, CliVersionResponse,
    Commands, DataRetentionStatus, ExecRequestBody, ExecResponse, ExecStatusResponse,
    ExtendResponse, LoginPollResponse, LoginStartRequest, LoginStartResponse, MachineType,
    Operation, OperationDetail, PageInfo, Sandbox, SandboxDetail, SandboxList, StreamEvent, Team,
    TeamList, Webhook, WebhookCreated, WebhookList, WebhookRotated,
};

// Aliases where the client historically used a different name for the same
// shape. Kept so call sites do not churn for a rename that buys nothing.
pub type SandboxListResponse = SandboxList;
pub type SandboxResponse = SandboxDetail;
pub type OperationResponse = OperationDetail;
pub type ApiKeyListResponse = ApiKeyList;
pub type TeamListResponse = TeamList;
pub type WebhookListResponse = WebhookList;
pub type ExecRequest = ExecRequestBody;
/// The NDJSON lifecycle stream, named `Event` at every call site here.
pub type Event = StreamEvent;

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

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
    /// `fork --no-stop`: refuse a running source with no stopped snapshot
    /// instead of stopping, snapshotting and restarting it. Ignored on new
    /// and resume.
    pub no_stop: bool,
}

/// `GET /me` — account identity for `ori status`. Wire shape TODO(reconcile).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeResponse {
    pub identifier: String,
    #[serde(default)]
    pub login_state: String,
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

/// Human-renderable summary of the terminal `ready` event.
#[derive(Debug, Clone)]
pub struct ReadyInfo {
    pub id: String,
    pub state: String,
    pub ip: Option<String>,
    pub url: Option<String>,
    pub desktop_url: Option<String>,
    pub stop_after: Option<String>,
    pub commands: Option<Commands>,
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
                let c = commands.as_ref().unwrap();
                assert_eq!(c.ssh, "ori ssh ori_a1b2c3d4");
                // `forward` is absent from the line above on purpose: a partial
                // `commands` object must not fail the terminal event.
                assert_eq!(c.forward, "");
            }
            _ => panic!("expected ready"),
        }

        let notice: Event = serde_json::from_str(
            r#"{"event":"notice","id":"ori_a1b2c3d4","message":"forked from an older stopped snapshot"}"#,
        )
        .unwrap();
        match notice {
            Event::Notice { id, message } => {
                assert_eq!(id.as_deref(), Some("ori_a1b2c3d4"));
                assert!(message.contains("older stopped snapshot"));
            }
            _ => panic!("expected notice"),
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
        assert_eq!(s.machine_type.as_str(), "default");
        assert_eq!(s.memory_gb, 8);
        assert_eq!(s.billing_multiplier, 1.0);
        assert_eq!(s.ip.as_deref(), Some("10.0.0.12"));
        // And serialises back out with the same field names.
        let out = serde_json::to_value(&s).unwrap();
        assert!(out.get("type").is_some(), "must serialise `type`, not `ty`");
        assert!(out.get("memoryGB").is_some(), "not `memoryGb` -- this exact\n             letter broke `ori list` when each side had its own copy");
        assert!(out.get("billingMultiplier").is_some());
        assert!(out.get("machineType").is_none());
    }
}
