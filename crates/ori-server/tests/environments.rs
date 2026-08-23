//! C19 integration tests for environments, driven over real HTTP against a
//! running server (in-process `axum::serve` on a loopback socket) with an
//! in-memory SQLite database and the mock provider.
//!
//! The headline test runs a **real WebSocket agent** against the server's
//! `/api/v1/agent/tunnel`, so the claim push is exercised end to end: the
//! server builds the claim from the pinned environment version, hands it to
//! the agent on `hello`, and hands the upgraded claim on `env upgrade`. A log
//! capture asserts no secret value ever appears in a log line.

use std::io;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use serde_json::{json, Value};
use sqlx::SqlitePool;
use tokio_tungstenite::tungstenite::Message;

use ori_server::config::Config;
use ori_server::db;
use ori_server::mock::MockProvider;

// ---------------------------------------------------------------------------
// harness: a real server on a loopback socket
// ---------------------------------------------------------------------------

struct Server {
    addr: SocketAddr,
    db: SqlitePool,
}

async fn spawn_server() -> Server {
    let db = db::open_in_memory().await.unwrap();
    let provider = Arc::new(MockProvider::new());
    let config = Config {
        domain: "ori.test".to_string(),
        webhook_allow_private: true,
        ..Config::default()
    };
    let app = ori_server::build_app(db.clone(), provider.clone(), config);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    Server { addr, db }
}

async fn bootstrap_key(addr: &SocketAddr) -> String {
    let client = reqwest::Client::new();
    let res = client
        .post(format!("http://{addr}/api/v1/api-keys"))
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    res.json::<Value>().await.unwrap()["secret"]
        .as_str()
        .unwrap()
        .to_string()
}

async fn call(
    addr: &SocketAddr,
    token: &str,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> (reqwest::StatusCode, Value) {
    let client = reqwest::Client::new();
    let mut req = client
        .request(method, format!("http://{addr}/api/v1{path}"))
        .bearer_auth(token);
    if let Some(b) = body {
        req = req.json(&b);
    }
    let res = req.send().await.unwrap();
    let status = res.status();
    let text = res.text().await.unwrap();
    let v = if text.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str(&text).unwrap()
    };
    (status, v)
}

/// Create a sandbox over HTTP, streaming NDJSON; returns its id.
async fn create_sandbox(addr: &SocketAddr, token: &str, body: Value) -> String {
    let client = reqwest::Client::new();
    let res = client
        .post(format!("http://{addr}/api/v1/sandboxes"))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200, "create status");
    let text = res.text().await.unwrap();
    let events: Vec<Value> = text
        .lines()
        .filter(|l| l.trim_start().starts_with('{'))
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let id = events[0]["id"].as_str().unwrap().to_string();
    assert_eq!(events.last().unwrap()["event"], "ready");
    id
}

async fn env_set_var(
    addr: &SocketAddr,
    token: &str,
    name: &str,
    key: &str,
    value: &str,
    secret: bool,
) {
    let (status, v) = call(
        addr,
        token,
        reqwest::Method::POST,
        &format!("/environments/{name}/vars"),
        Some(json!({ "key": key, "value": value, "secret": secret })),
    )
    .await;
    assert_eq!(status, 200, "set-var: {v}");
}

async fn env_set_file(
    addr: &SocketAddr,
    token: &str,
    name: &str,
    path: &str,
    content: &str,
    secret: bool,
) {
    let (status, v) = call(
        addr,
        token,
        reqwest::Method::POST,
        &format!("/environments/{name}/files"),
        Some(json!({ "path": path, "content": content, "secret": secret })),
    )
    .await;
    assert_eq!(status, 200, "set-file: {v}");
}

async fn env_rm_file(addr: &SocketAddr, token: &str, name: &str, path: &str) {
    let (status, v) = call(
        addr,
        token,
        reqwest::Method::DELETE,
        &format!("/environments/{name}/files/{path}"),
        None,
    )
    .await;
    assert_eq!(status, 200, "rm-file: {v}");
}

async fn env_add_repo(addr: &SocketAddr, token: &str, name: &str, url: &str, branch: Option<&str>) {
    let (status, v) = call(
        addr,
        token,
        reqwest::Method::POST,
        &format!("/environments/{name}/repos"),
        Some(json!({ "url": url, "branch": branch })),
    )
    .await;
    assert_eq!(status, 200, "add-repo: {v}");
}

async fn env_latest_version(server: &Server, name: &str) -> i64 {
    let row: (Option<i64>,) = sqlx::query_as(
        "SELECT version FROM environment_versions WHERE environment_id = \
         (SELECT id FROM environments WHERE name = ?) ORDER BY version DESC LIMIT 1",
    )
    .bind(name)
    .fetch_one(&server.db)
    .await
    .unwrap();
    row.0.unwrap()
}

// ---------------------------------------------------------------------------
// fake agent: a WebSocket client speaking the agent protocol
// ---------------------------------------------------------------------------

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

type AgentWs =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// A JSON value as a WebSocket text frame.
fn ws_text(v: &Value) -> Message {
    #[allow(clippy::useless_conversion)]
    Message::Text(v.to_string().into())
}

/// Connect a WebSocket as the sandbox's agent, send `hello`, and return the
/// socket plus the server-pushed `apply` frame.
async fn connect_agent(addr: &SocketAddr, server: &Server, sandbox_id: &str) -> (AgentWs, Value) {
    let agent_token: String =
        sqlx::query_as::<_, (String,)>("SELECT agent_token FROM sandboxes WHERE id = ?")
            .bind(sandbox_id)
            .fetch_one(&server.db)
            .await
            .expect("sandbox row")
            .0;

    let url = format!("ws://{addr}/api/v1/agent/tunnel");
    let mut req = url.into_client_request().unwrap();
    req.headers_mut().insert(
        "Authorization",
        format!("Bearer {agent_token}").parse().unwrap(),
    );
    req.headers_mut()
        .insert("x-ori-sandbox", sandbox_id.parse().unwrap());

    let (mut ws, _) = tokio_tungstenite::connect_async(req)
        .await
        .expect("agent connect");

    // the agent greets first; the server replies by pushing the claim
    ws.send(ws_text(
        &json!({ "type": "hello", "version": "test", "pid": 1 }),
    ))
    .await
    .unwrap();

    let apply = loop {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("apply frame never arrived")
            .expect("ws closed")
            .expect("ws err");
        let Message::Text(text) = msg else {
            continue;
        };
        let v: Value = serde_json::from_str(&text).unwrap();
        if v["type"] == "apply" {
            break v;
        }
    };
    // complete the round trip so the server's pending request resolves
    ws.send(ws_text(
        &json!({ "type": "applyResult", "id": apply["id"], "ok": true }),
    ))
    .await
    .unwrap();
    (ws, apply)
}

/// Wait up to `timeout` for an `apply` frame, replying `ok` and returning it.
/// `None` when none arrives (used to assert the running sandbox stays pinned
/// until upgrade).
async fn wait_for_apply(ws: &mut AgentWs, timeout: Duration) -> Option<Value> {
    loop {
        let Ok(msg) = tokio::time::timeout(timeout, ws.next()).await else {
            return None;
        };
        let msg = msg?;
        let Ok(Message::Text(text)) = msg else {
            continue;
        };
        let v: Value = serde_json::from_str(&text).ok()?;
        if v["type"] == "apply" {
            ws.send(ws_text(
                &json!({ "type": "applyResult", "id": v["id"], "ok": true }),
            ))
            .await
            .ok();
            return Some(v);
        }
    }
}

// ---------------------------------------------------------------------------
// log capture: secrets must never appear in a log line, any level
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct CaptureWriter(Arc<Mutex<Vec<u8>>>);

impl io::Write for CaptureWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl tracing_subscriber::fmt::MakeWriter<'_> for CaptureWriter {
    type Writer = Self;
    fn make_writer(&self) -> Self {
        self.clone()
    }
}

/// Install a DEBUG-level fmt subscriber that captures every line. Returns a
/// guard that must outlive the assertions (dropping it restores the prior
/// default); the captured bytes are readable through the clone.
fn install_capture() -> (CaptureWriter, tracing::subscriber::DefaultGuard) {
    let buf = Arc::new(Mutex::new(Vec::new()));
    let writer = CaptureWriter(buf);
    let sub = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::DEBUG)
        .with_writer(writer.clone())
        .finish();
    let guard = tracing::subscriber::set_default(sub);
    (writer, guard)
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn env_crud_mints_versions_and_redacts_secrets() {
    let server = spawn_server().await;
    let token = bootstrap_key(&server.addr).await;

    // new
    let (status, v) = call(
        &server.addr,
        &token,
        reqwest::Method::POST,
        "/environments",
        Some(json!({ "name": "prod" })),
    )
    .await;
    assert_eq!(status, 201);
    assert_eq!(v["environment"]["name"], "prod");
    assert_eq!(v["environment"]["version"], 1);

    // every mutation bumps the version
    env_set_var(&server.addr, &token, "prod", "API_URL", "https://x", false).await;
    assert_eq!(env_latest_version(&server, "prod").await, 2);
    env_set_var(&server.addr, &token, "prod", "TOKEN", "hunter2", true).await;
    assert_eq!(env_latest_version(&server, "prod").await, 3);
    env_set_file(
        &server.addr,
        &token,
        "prod",
        ".netrc",
        "machine example login u password p",
        true,
    )
    .await;
    assert_eq!(env_latest_version(&server, "prod").await, 4);
    env_add_repo(
        &server.addr,
        &token,
        "prod",
        "https://github.com/example/repo",
        Some("main"),
    )
    .await;
    assert_eq!(env_latest_version(&server, "prod").await, 5);

    // info redacts secret values, keeps plain ones
    let (status, v) = call(
        &server.addr,
        &token,
        reqwest::Method::GET,
        "/environments/prod",
        None,
    )
    .await;
    assert_eq!(status, 200);
    let env = &v["environment"];
    assert_eq!(env["version"], 5);
    let api_url = env["vars"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["key"] == "API_URL")
        .unwrap();
    assert_eq!(api_url["value"], "https://x");
    assert_eq!(api_url["secret"], false);
    let token_var = env["vars"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["key"] == "TOKEN")
        .unwrap();
    assert_eq!(token_var["secret"], true);
    assert!(
        token_var.get("value").is_none(),
        "secret value must never be returned"
    );
    let netrc = env["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["path"] == ".netrc")
        .unwrap();
    assert_eq!(netrc["secret"], true);
    assert!(netrc.get("content").is_none(), "secret content redacted");

    // immutability: the version-1 bundle is empty, never retroactively edited
    let v1_vars: i64 = sqlx::query_as::<_, (i64,)>(
        "SELECT count(*) FROM environment_vars WHERE version_id = \
         (SELECT id FROM environment_versions WHERE environment_id = \
          (SELECT id FROM environments WHERE name = 'prod') AND version = 1)",
    )
    .fetch_one(&server.db)
    .await
    .unwrap()
    .0;
    assert_eq!(v1_vars, 0, "version 1 must stay immutable and empty");

    // rename + default
    let (status, _) = call(
        &server.addr,
        &token,
        reqwest::Method::POST,
        "/environments/prod/rename",
        Some(json!({ "newName": "production" })),
    )
    .await;
    assert_eq!(status, 200);
    let (status, _) = call(
        &server.addr,
        &token,
        reqwest::Method::POST,
        "/environments/production/default",
        None,
    )
    .await;
    assert_eq!(status, 200);

    // list
    let (_, v) = call(
        &server.addr,
        &token,
        reqwest::Method::GET,
        "/environments",
        None,
    )
    .await;
    let envs = v["environments"].as_array().unwrap();
    assert_eq!(envs.len(), 1);
    assert_eq!(envs[0]["name"], "production");
    assert_eq!(envs[0]["isDefault"], true);

    // rm
    let (status, _) = call(
        &server.addr,
        &token,
        reqwest::Method::DELETE,
        "/environments/production",
        None,
    )
    .await;
    assert_eq!(status, 200);
    let (_, v) = call(
        &server.addr,
        &token,
        reqwest::Method::GET,
        "/environments",
        None,
    )
    .await;
    assert_eq!(v["environments"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn sandbox_pins_latest_environment_version_and_no_env_is_empty() {
    let server = spawn_server().await;
    let token = bootstrap_key(&server.addr).await;
    let (status, _) = call(
        &server.addr,
        &token,
        reqwest::Method::POST,
        "/environments",
        Some(json!({ "name": "prod" })),
    )
    .await;
    assert_eq!(status, 201);
    env_set_var(&server.addr, &token, "prod", "SECRET", "hunter2", true).await;
    env_set_var(&server.addr, &token, "prod", "PLAIN", "x", false).await;
    let latest = env_latest_version(&server, "prod").await;

    let id = create_sandbox(
        &server.addr,
        &token,
        json!({ "environment": "prod", "noEnv": true }),
    )
    .await;
    let (_, v) = call(
        &server.addr,
        &token,
        reqwest::Method::GET,
        &format!("/sandboxes/{id}"),
        None,
    )
    .await;
    let sandbox = &v["sandbox"];
    assert_eq!(sandbox["environment"], "prod");
    assert_eq!(sandbox["environmentVersion"], latest);

    // the no-env claim is empty: nothing from the account, secrets scrubbed
    let claim = ori_server::env::build_claim(&server.db, "default", "prod", latest, true)
        .await
        .unwrap();
    assert!(claim.env.is_empty());
    assert!(claim.secret_files.is_empty());

    // a plain sandbox on the same version does get the claim
    let claim = ori_server::env::build_claim(&server.db, "default", "prod", latest, false)
        .await
        .unwrap();
    assert_eq!(claim.env["PLAIN"], "x");
    assert_eq!(claim.env["SECRET"], "hunter2");

    // unknown environment is refused
    let (status, _) = call(
        &server.addr,
        &token,
        reqwest::Method::POST,
        "/sandboxes",
        Some(json!({ "environment": "nope" })),
    )
    .await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn upgrade_withholds_removed_secrets_and_bumps_running_sandboxes() {
    let server = spawn_server().await;
    let token = bootstrap_key(&server.addr).await;
    let (status, _) = call(
        &server.addr,
        &token,
        reqwest::Method::POST,
        "/environments",
        Some(json!({ "name": "prod" })),
    )
    .await;
    assert_eq!(status, 201);
    env_set_var(&server.addr, &token, "prod", "TOKEN", "hunter2", true).await;
    env_set_file(
        &server.addr,
        &token,
        "prod",
        ".aws/creds",
        "AKIA-SECRET-CONTENT",
        true,
    )
    .await;
    let v1 = env_latest_version(&server, "prod").await;

    let id = create_sandbox(&server.addr, &token, json!({ "environment": "prod" })).await;
    let (_, v) = call(
        &server.addr,
        &token,
        reqwest::Method::GET,
        &format!("/sandboxes/{id}"),
        None,
    )
    .await;
    assert_eq!(v["sandbox"]["environmentVersion"], v1);

    // the environment removes both secrets
    let (status, _v) = call(
        &server.addr,
        &token,
        reqwest::Method::DELETE,
        "/environments/prod/vars/TOKEN",
        None,
    )
    .await;
    assert_eq!(status, 200);
    env_rm_file(&server.addr, &token, "prod", ".aws/creds").await;
    let v2 = env_latest_version(&server, "prod").await;
    assert!(v2 > v1);

    // the sandbox is still pinned to v1
    let (_, v) = call(
        &server.addr,
        &token,
        reqwest::Method::GET,
        &format!("/sandboxes/{id}"),
        None,
    )
    .await;
    assert_eq!(v["sandbox"]["environmentVersion"], v1);

    // the new version's claim withholds the removed secrets
    let claim = ori_server::env::build_claim(&server.db, "default", "prod", v2, false)
        .await
        .unwrap();
    assert!(claim.env.is_empty(), "removed secret var must be withheld");
    assert!(
        claim.secret_files.is_empty(),
        "removed secret file must be withheld"
    );

    // upgrade moves the sandbox and reports it
    let (status, report) = call(
        &server.addr,
        &token,
        reqwest::Method::POST,
        "/environments/prod/upgrade",
        None,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(report["version"], v2);
    assert_eq!(report["sandboxes"], 1);
    let (_, v) = call(
        &server.addr,
        &token,
        reqwest::Method::GET,
        &format!("/sandboxes/{id}"),
        None,
    )
    .await;
    assert_eq!(v["sandbox"]["environmentVersion"], v2);
}

/// The headline: a real WebSocket agent, full claim lifecycle, and a log
/// capture proving no secret value ever appears in a log line.
#[tokio::test]
async fn full_flow_with_agent_and_secret_log_capture() {
    let (writer, _guard) = install_capture();

    let server = spawn_server().await;
    let token = bootstrap_key(&server.addr).await;

    let (status, _) = call(
        &server.addr,
        &token,
        reqwest::Method::POST,
        "/environments",
        Some(json!({ "name": "prod" })),
    )
    .await;
    assert_eq!(status, 201);
    env_set_var(
        &server.addr,
        &token,
        "prod",
        "API_URL",
        "https://api.example",
        false,
    )
    .await;
    env_set_var(
        &server.addr,
        &token,
        "prod",
        "SECRET_TOKEN",
        "s3cr3t-v4lu3",
        true,
    )
    .await;
    env_set_file(
        &server.addr,
        &token,
        "prod",
        ".credentials/netrc",
        "s3cr3t-f1le-c0ntent",
        true,
    )
    .await;
    env_add_repo(
        &server.addr,
        &token,
        "prod",
        "https://github.com/example/backend",
        Some("main"),
    )
    .await;
    let v1 = env_latest_version(&server, "prod").await;

    // launch a sandbox pinned to the latest version
    let id = create_sandbox(&server.addr, &token, json!({ "environment": "prod" })).await;

    // a real agent connects and is handed the claim on hello
    let (mut ws, apply) = connect_agent(&server.addr, &server, &id).await;
    assert_eq!(apply["type"], "apply");
    assert_eq!(apply["env"]["API_URL"], "https://api.example");
    assert_eq!(apply["env"]["SECRET_TOKEN"], "s3cr3t-v4lu3");
    let files = apply["secretFiles"].as_array().unwrap();
    assert_eq!(files.len(), 1);
    let b64 = files[0]["contentsB64"].as_str().unwrap();
    let content = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .unwrap();
    assert_eq!(content, b"s3cr3t-f1le-c0ntent");
    let repos = apply["repos"].as_array().unwrap();
    assert_eq!(repos.len(), 1);
    assert_eq!(repos[0]["url"], "https://github.com/example/backend");
    assert_eq!(repos[0]["ref"], "main");
    assert_eq!(repos[0]["path"], "backend");

    // mint a new version: rotate the secret, remove the secret file
    env_set_var(
        &server.addr,
        &token,
        "prod",
        "SECRET_TOKEN",
        "r0t4ted-v4lu3",
        true,
    )
    .await;
    env_rm_file(&server.addr, &token, "prod", ".credentials/netrc").await;
    let v2 = env_latest_version(&server, "prod").await;
    assert!(v2 > v1);

    // the RUNNING sandbox is unchanged: no new claim is pushed until upgrade
    let unexpected = wait_for_apply(&mut ws, Duration::from_millis(400)).await;
    assert!(
        unexpected.is_none(),
        "the running sandbox must stay pinned to its version until upgrade"
    );

    // upgrade pushes the new claim; the HTTP call waits for the agent's
    // applyResult, so the WS read runs concurrently
    let upgrade_task = {
        let addr = server.addr;
        let token = token.clone();
        tokio::spawn(async move {
            call(
                &addr,
                &token,
                reqwest::Method::POST,
                "/environments/prod/upgrade",
                None,
            )
            .await
        })
    };
    let apply = wait_for_apply(&mut ws, Duration::from_secs(5))
        .await
        .expect("upgrade must push a new claim");
    assert_eq!(apply["env"]["SECRET_TOKEN"], "r0t4ted-v4lu3");
    assert_eq!(
        apply["env"]["API_URL"], "https://api.example",
        "a plain var untouched by the upgrade must still be present"
    );
    assert!(
        apply["secretFiles"].as_array().unwrap().is_empty(),
        "the removed secret file must be withheld from the upgraded sandbox"
    );
    assert_eq!(
        apply["repos"].as_array().unwrap().len(),
        1,
        "a repo untouched by the upgrade must still be present"
    );
    let (status, _) = upgrade_task.await.unwrap();
    assert_eq!(status, 200);

    // the sandbox's pinned version moved
    let (_, v) = call(
        &server.addr,
        &token,
        reqwest::Method::GET,
        &format!("/sandboxes/{id}"),
        None,
    )
    .await;
    assert_eq!(v["sandbox"]["environmentVersion"], v2);

    // and the captured logs never contain a secret value, not even a prefix
    let captured = writer.0.lock().unwrap();
    let logs = String::from_utf8_lossy(&captured);
    for needle in ["s3cr3t-v4lu3", "r0t4ted-v4lu3", "s3cr3t-f1le-c0ntent"] {
        assert!(
            !logs.contains(needle),
            "secret {needle:?} leaked into the logs:\n{logs}"
        );
    }
}
