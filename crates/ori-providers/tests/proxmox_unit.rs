//! Unit tests for the Proxmox provider against a mocked HTTP layer
//! (`wiremock`). Every real Proxmox call is a wiremock route, so the provider
//! is exercised exactly as it runs in production.
//!
//! Covers the plan's required cases:
//! - UPID success → `create` returns a handle.
//! - UPID failure surfaces as an error (never a false "ready").
//! - `clone_from` actually sends `full=0` + `snapname`.
//! - storage preflight rejects a `dir` storage.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use wiremock::matchers::{method, path, path_regex};
use wiremock::{Mock, MockServer, Request, ResponseTemplate, Respond};

use ori_providers::proxmox::ProxmoxConfig;
use ori_providers::reconcile::{
    InstanceHandle, InstanceSpec, MachineType, Provider, SnapshotRef, StopMode,
};

const UPID_CREATE: &str = "UPID:sandbox:AAA:BBB:CCC:vzcreate:9001:root@pam:";
const UPID_CLONE: &str = "UPID:sandbox:DDD:EEE:FFF:vzclone:9002:root@pam:";
const UPID_START: &str = "UPID:sandbox:GGG:HHH:III:vzstart:9001:root@pam:";

/// A responder that walks through a fixed list of task states per call.
struct SeqResponder {
    n: Arc<AtomicUsize>,
    states: Vec<serde_json::Value>,
}

impl Respond for SeqResponder {
    fn respond(&self, _req: &Request) -> ResponseTemplate {
        let i = self.n.fetch_add(1, Ordering::SeqCst);
        let state = &self.states[i.min(self.states.len() - 1)];
        ResponseTemplate::new(200).set_body_json(serde_json::json!({ "data": state }))
    }
}

/// A responder that records the request body it received.
struct CaptureResponder {
    body: Arc<Mutex<Option<String>>>,
    response: ResponseTemplate,
}

impl Respond for CaptureResponder {
    fn respond(&self, req: &Request) -> ResponseTemplate {
        *self.body.lock().unwrap() = Some(String::from_utf8_lossy(&req.body).to_string());
        self.response.clone()
    }
}

fn running() -> serde_json::Value {
    serde_json::json!({ "status": "running" })
}

fn stopped_ok() -> serde_json::Value {
    serde_json::json!({ "status": "stopped", "exitstatus": "OK" })
}

fn config(base: &str) -> ProxmoxConfig {
    ProxmoxConfig {
        host: base.to_string(),
        token_id: "user@pam!token".to_string(),
        token_secret: "secret".to_string(),
        node: "sandbox".to_string(),
        storage: "local-lvm".to_string(),
        template: "local:vztmpl/alpine.tar.xz".to_string(),
        bridge: "vmbr0".to_string(),
        ca_pem: None,
        ca_pem_file: None,
        insecure_skip_verify: false,
        ssh: None,
        ssh_identity_file: None,
        task_timeout_secs: 60,
    }
}

/// Mount every route the startup preflight touches, so a provider can be
/// constructed against the mock.
async fn mount_preflight(server: &MockServer, storage_type: &str) {
    Mock::given(method("GET"))
        .and(path("/api2/json/nodes"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": [{ "node": "sandbox", "status": "online" }]
        })))
        .mount(server)
        .await;

    Mock::given(method("GET"))
        .and(path("/api2/json/nodes/sandbox/storage"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": [{ "storage": "local-lvm", "type": storage_type }]
        })))
        .mount(server)
        .await;

    Mock::given(method("GET"))
        .and(path("/api2/json/nodes/sandbox/storage/local/content"))
        .and(wiremock::matchers::query_param("content", "vztmpl"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": [{ "volid": "local:vztmpl/alpine.tar.xz", "content": "vztmpl" }]
        })))
        .mount(server)
        .await;

    Mock::given(method("GET"))
        .and(path("/api2/json/cluster/nextid"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": "5000"
        })))
        .mount(server)
        .await;

    Mock::given(method("GET"))
        .and(path_regex("/api2/json/access/permissions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": {
                "/": {
                    "VM.Allocate": 1,
                    "VM.Clone": 1,
                    "VM.Config.Disk": 1,
                    "VM.Config.Memory": 1,
                    "VM.Config.CPU": 1
                }
            }
        })))
        .mount(server)
        .await;
}

/// Mount the task-status route used by the UPID poller.
async fn mount_task(server: &MockServer, states: Vec<serde_json::Value>) -> Arc<AtomicUsize> {
    let n = Arc::new(AtomicUsize::new(0));
    Mock::given(method("GET"))
        .and(path_regex("/api2/json/nodes/sandbox/tasks/.+/status"))
        .respond_with(SeqResponder {
            n: n.clone(),
            states,
        })
        .mount(server)
        .await;
    n
}

fn spec(vmid: u32, name: &str) -> InstanceSpec {
    InstanceSpec {
        id: format!("ori_test_{vmid}"),
        vmid,
        name: name.to_string(),
        machine_type: MachineType::Small,
        template: "local:vztmpl/alpine.tar.xz".to_string(),
        storage: "local-lvm".to_string(),
        environment: None,
        environment_version: None,
    }
}

#[tokio::test]
async fn create_routes_through_upid_poller_and_returns_handle() {
    let server = MockServer::start().await;
    mount_preflight(&server, "lvmthin").await;
    mount_task(
        &server,
        vec![running(), stopped_ok(), running(), stopped_ok()],
    )
    .await;

    Mock::given(method("POST"))
        .and(path("/api2/json/nodes/sandbox/lxc"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": UPID_CREATE
        })))
        .mount(&server)
        .await;

    Mock::given(method("POST"))
        .and(path("/api2/json/nodes/sandbox/lxc/9001/status/start"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": UPID_START
        })))
        .mount(&server)
        .await;

    Mock::given(method("GET"))
        .and(path("/api2/json/nodes/sandbox/lxc/9001/status/current"))
        .respond_with(SeqResponder {
            n: Arc::new(AtomicUsize::new(0)),
            states: vec![
                serde_json::json!({ "status": "stopped", "name": "t1" }),
                serde_json::json!({ "status": "running", "name": "t1" }),
            ],
        })
        .mount(&server)
        .await;

    let cfg = config(&server.uri());
    let http = reqwest::Client::new();
    let provider = ori_providers::proxmox::ProxmoxProvider::new_with_client(cfg, http)
        .await
        .expect("preflight should pass");

    let handle = provider
        .create(&spec(9001, "t1"))
        .await
        .expect("create should succeed after the UPID poller sees stopped+OK");

    assert_eq!(handle.id, "sandbox/9001");
    assert_eq!(handle.provider, "proxmox");
}

#[tokio::test]
async fn upid_failure_surfaces_as_an_error() {
    let server = MockServer::start().await;
    mount_preflight(&server, "lvmthin").await;
    mount_task(
        &server,
        vec![
            running(),
            serde_json::json!({ "status": "stopped", "exitstatus": "start failed: cannot find template" }),
        ],
    )
    .await;

    Mock::given(method("POST"))
        .and(path("/api2/json/nodes/sandbox/lxc"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": UPID_CREATE
        })))
        .mount(&server)
        .await;

    let cfg = config(&server.uri());
    let http = reqwest::Client::new();
    let provider = ori_providers::proxmox::ProxmoxProvider::new_with_client(cfg, http)
        .await
        .expect("preflight should pass");

    let err = provider
        .create(&spec(9001, "t1"))
        .await
        .expect_err("a failing task must surface as an error, not a false ready");

    assert!(
        err.to_string().contains("start failed"),
        "expected the task failure to surface, got: {err}"
    );
}

#[tokio::test]
async fn clone_sends_full_0_with_snapname() {
    let server = MockServer::start().await;
    mount_preflight(&server, "lvmthin").await;
    mount_task(&server, vec![running(), stopped_ok()]).await;

    let body = Arc::new(Mutex::new(None));
    Mock::given(method("POST"))
        .and(path("/api2/json/nodes/sandbox/lxc/9001/clone"))
        .respond_with(CaptureResponder {
            body: body.clone(),
            response: ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": UPID_CLONE
            })),
        })
        .mount(&server)
        .await;

    let cfg = config(&server.uri());
    let http = reqwest::Client::new();
    let provider = ori_providers::proxmox::ProxmoxProvider::new_with_client(cfg, http)
        .await
        .expect("preflight should pass");

    let src = SnapshotRef {
        provider: "proxmox".to_string(),
        id: "sandbox/9001/golden".to_string(),
        name: "golden".to_string(),
    };
    let handle = provider
        .clone_from(&src, &spec(9002, "t2"))
        .await
        .expect("clone should succeed");

    assert_eq!(handle.id, "sandbox/9002");

    let body = body.lock().unwrap().clone().expect("clone request recorded");
    assert!(
        body.contains("full=0"),
        "clone must be a linked clone, request body: {body}"
    );
    assert!(
        body.contains("snapname=golden"),
        "clone must name the snapshot, request body: {body}"
    );
    assert!(
        body.contains("newid=9002"),
        "clone must target the caller's vmid, request body: {body}"
    );
}

#[tokio::test]
async fn preflight_rejects_dir_storage() {
    let server = MockServer::start().await;
    mount_preflight(&server, "dir").await;

    let cfg = config(&server.uri());
    let http = reqwest::Client::new();
    let err = ori_providers::proxmox::ProxmoxProvider::new_with_client(cfg, http)
        .await
        .expect_err("dir storage must be refused at startup");

    assert!(
        err.to_string().contains("snapshot") && err.to_string().contains("dir"),
        "got: {err}"
    );
}

#[tokio::test]
async fn start_is_idempotent_when_already_running() {
    let server = MockServer::start().await;
    mount_preflight(&server, "lvmthin").await;

    Mock::given(method("GET"))
        .and(path("/api2/json/nodes/sandbox/lxc/9001/status/current"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": { "status": "running", "name": "t1" }
        })))
        .mount(&server)
        .await;

    // If the provider POSTs a start for an already-running container, this
    // mock fails the test.
    Mock::given(method("POST"))
        .and(path("/api2/json/nodes/sandbox/lxc/9001/status/start"))
        .respond_with(ResponseTemplate::new(500).set_body_json(serde_json::json!({
            "data": null, "errors": { "msg": "already running" }
        })))
        .mount(&server)
        .await;

    let cfg = config(&server.uri());
    let http = reqwest::Client::new();
    let provider = ori_providers::proxmox::ProxmoxProvider::new_with_client(cfg, http)
        .await
        .expect("preflight should pass");

    let h = InstanceHandle {
        provider: "proxmox".to_string(),
        id: "sandbox/9001".to_string(),
    };
    provider.start(&h).await.expect("start on running is Ok");
}

#[tokio::test]
async fn stop_is_idempotent_when_already_stopped() {
    let server = MockServer::start().await;
    mount_preflight(&server, "lvmthin").await;

    Mock::given(method("GET"))
        .and(path("/api2/json/nodes/sandbox/lxc/9001/status/current"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": { "status": "stopped", "name": "t1" }
        })))
        .mount(&server)
        .await;

    Mock::given(method("POST"))
        .and(path("/api2/json/nodes/sandbox/lxc/9001/status/stop"))
        .respond_with(ResponseTemplate::new(500).set_body_json(serde_json::json!({
            "data": null, "errors": { "msg": "already stopped" }
        })))
        .mount(&server)
        .await;

    let cfg = config(&server.uri());
    let http = reqwest::Client::new();
    let provider = ori_providers::proxmox::ProxmoxProvider::new_with_client(cfg, http)
        .await
        .expect("preflight should pass");

    let h = InstanceHandle {
        provider: "proxmox".to_string(),
        id: "sandbox/9001".to_string(),
    };
    provider
        .stop(&h, StopMode::Force)
        .await
        .expect("stop on stopped is Ok");
}

#[tokio::test]
async fn capabilities_are_declared_honestly() {
    let server = MockServer::start().await;
    mount_preflight(&server, "lvmthin").await;
    let cfg = config(&server.uri());
    let http = reqwest::Client::new();
    let provider = ori_providers::proxmox::ProxmoxProvider::new_with_client(cfg, http)
        .await
        .expect("preflight should pass");

    let caps = provider.capabilities();
    assert_eq!(provider.name(), "proxmox");
    assert!(caps.linked_clone);
    assert!(caps.fs_snapshot);
    assert!(!caps.live_suspend, "CRIU is measured failing; must not claim it");
    assert!(caps.nested_containers);
    assert!(!caps.resize_online);
}

#[tokio::test]
async fn sends_pve_api_token_header() {
    let server = MockServer::start().await;

    let auth_header = Arc::new(Mutex::new(None));
    let capture = auth_header.clone();
    Mock::given(method("GET"))
        .and(path("/api2/json/cluster/nextid"))
        .respond_with(move |req: &Request| {
            *capture.lock().unwrap() = req
                .headers
                .get("authorization")
                .map(|v| String::from_utf8_lossy(v.as_bytes()).to_string());
            ResponseTemplate::new(200).set_body_json(serde_json::json!({ "data": "5000" }))
        })
        .mount(&server)
        .await;

    let cfg = config(&server.uri());
    let http = reqwest::Client::new();
    let client = ori_providers::proxmox::PveClient::new(&cfg, http);
    let _ = client.nextid().await.expect("nextid should succeed");

    assert_eq!(
        auth_header.lock().unwrap().as_deref(),
        Some("PVEAPIToken=user@pam!token=secret")
    );
}