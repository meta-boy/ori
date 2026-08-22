//! Integration tests for the control plane, against the real route table with
//! an in-memory SQLite database and a `MockProvider`. Each test drives the
//! server over HTTP (in-process via `tower::ServiceExt`); the NDJSON
//! flush-per-line test uses a real loopback socket because that is the only
//! way to observe actual wire timing.

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx::SqlitePool;
use tower::ServiceExt;

use ori_server::config::Config;
use ori_server::db;
use ori_server::mock::MockProvider;
use ori_server::pool::{PoolConfig, PoolKey, PoolManager};
use ori_server::proto::{MachineType, Provider, SnapshotRef};
use ori_server::state::AppState;
use ori_server::tasks;

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

struct TestApp {
    app: Router,
    provider: Arc<MockProvider>,
    db: SqlitePool,
}

async fn test_app() -> TestApp {
    let db = db::open_in_memory().await.unwrap();
    let provider = Arc::new(MockProvider::new());
    let config = Config {
        domain: "ori.test".to_string(),
        default_ttl_seconds: 900,
        ..Config::default()
    };
    let app = ori_server::build_app(db.clone(), provider.clone(), config);
    TestApp { app, provider, db }
}

fn req(method: Method, path: &str, token: Option<&str>, body: Option<Value>) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(path);
    if let Some(t) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {t}"));
    }
    let body = match body {
        Some(v) => {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
            Body::from(v.to_string())
        }
        None => Body::empty(),
    };
    builder.body(body).unwrap()
}

async fn call(app: &Router, req: Request<Body>) -> (StatusCode, String) {
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    (status, String::from_utf8_lossy(&bytes).to_string())
}

async fn call_json(app: &Router, req: Request<Body>) -> (StatusCode, Value) {
    let (status, body) = call(app, req).await;
    let v = if body.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str(&body).unwrap()
    };
    (status, v)
}

async fn bootstrap_key(app: &Router) -> String {
    let (status, v) = call_json(
        app,
        req(Method::POST, "/api/v1/api-keys", None, Some(json!({}))),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "bootstrap key creation: {v}");
    v["secret"].as_str().unwrap().to_string()
}

/// Create a sandbox and return (id, full stream body).
async fn create_sandbox(app: &Router, token: &str, body: Value) -> (String, String) {
    let (status, stream) = call(
        app,
        req(Method::POST, "/api/v1/sandboxes", Some(token), Some(body)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "create status; stream: {stream}");
    let id = parse_stream(&stream)
        .into_iter()
        .find_map(|ev| ev["id"].as_str().map(|s| s.to_string()))
        .unwrap();
    (id, stream)
}

/// Parse an NDJSON stream into its JSON objects. Tolerates chunked-transfer
/// framing from a raw-socket read: chunk-size lines and empty lines are
/// skipped, and trailing `\r` (from `\r\n` framing) is trimmed.
fn parse_stream(stream: &str) -> Vec<Value> {
    stream
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && l.starts_with('{'))
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

async fn sandbox_info(app: &Router, token: &str, id: &str) -> (StatusCode, Value) {
    call_json(
        app,
        req(
            Method::GET,
            &format!("/api/v1/sandboxes/{id}"),
            Some(token),
            None,
        ),
    )
    .await
}

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

#[tokio::test]
async fn auth_requires_bearer_token() {
    let t = test_app().await;
    let (status, v) = call_json(&t.app, req(Method::GET, "/api/v1/me", None, None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(v["error"]["code"], "unauthorized");

    // wrong key
    let (status, v) = call_json(
        &t.app,
        req(Method::GET, "/api/v1/me", Some("ori_sk_bogus"), None),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(v["error"]["code"], "unauthorized");
}

#[tokio::test]
async fn bootstrap_mints_first_key_and_it_authenticates() {
    let t = test_app().await;
    let (status, v) = call_json(
        &t.app,
        req(Method::POST, "/api/v1/api-keys", None, Some(json!({}))),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let secret = v["secret"].as_str().unwrap().to_string();
    assert!(secret.starts_with("ori_sk_"));
    assert_eq!(v["prefix"].as_str().unwrap().len(), 6);
    assert_eq!(v["lastFour"].as_str().unwrap().len(), 4);

    let (status, v) = call_json(&t.app, req(Method::GET, "/api/v1/me", Some(&secret), None)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["identifier"], "default");
    assert_eq!(v["loginState"], "active");
    assert_eq!(v["plan"], "free");
    assert_eq!(v["status"], "active");

    // second key without a token must now be rejected (bootstrap is over)
    let (status, _) = call_json(
        &t.app,
        req(Method::POST, "/api/v1/api-keys", None, Some(json!({}))),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn key_listing_shows_prefix_and_last_four_not_secret() {
    let t = test_app().await;
    let secret = bootstrap_key(&t.app).await;
    let (status, v) = call_json(
        &t.app,
        req(Method::GET, "/api/v1/api-keys", Some(&secret), None),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let key = &v["apiKeys"][0];
    assert!(key["prefix"].as_str().unwrap().starts_with("ori_s"));
    assert_eq!(key["lastFour"].as_str().unwrap().len(), 4);
    assert!(key.get("secret").is_none());
}

#[tokio::test]
async fn revoke_kills_the_key() {
    let t = test_app().await;
    let secret = bootstrap_key(&t.app).await;
    let (_status, v) = call_json(
        &t.app,
        req(Method::GET, "/api/v1/api-keys", Some(&secret), None),
    )
    .await;
    let id = v["apiKeys"][0]["id"].as_str().unwrap().to_string();
    let (status, _) = call_json(
        &t.app,
        req(
            Method::POST,
            &format!("/api/v1/api-keys/{id}/revoke"),
            Some(&secret),
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = call_json(&t.app, req(Method::GET, "/api/v1/me", Some(&secret), None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

// ---------------------------------------------------------------------------
// account / limits / teams
// ---------------------------------------------------------------------------

#[tokio::test]
async fn limits_reflects_counts() {
    let t = test_app().await;
    let token = bootstrap_key(&t.app).await;
    let (_, id) = create_sandbox(&t.app, &token, json!({})).await;
    let _ = id;
    let (status, v) = call_json(
        &t.app,
        req(Method::GET, "/api/v1/limits", Some(&token), None),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["plan"], "free");
    assert_eq!(v["currentTotal"], 1);
    assert_eq!(v["currentRunning"], 1);
    assert!(v["maxRunningSandboxes"].as_i64().unwrap() > 0);
}

#[tokio::test]
async fn teams_is_single_personal_scope() {
    let t = test_app().await;
    let token = bootstrap_key(&t.app).await;
    let (status, v) = call_json(
        &t.app,
        req(Method::GET, "/api/v1/teams", Some(&token), None),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let team = &v["teams"][0];
    assert_eq!(team["id"], "personal");
    assert_eq!(team["scope"], "personal");
    assert_eq!(team["role"], "owner");
}

// ---------------------------------------------------------------------------
// sandbox lifecycle
// ---------------------------------------------------------------------------

#[tokio::test]
async fn create_streams_ndjson_with_exact_line_shapes() {
    let t = test_app().await;
    let token = bootstrap_key(&t.app).await;
    let (id, stream) = create_sandbox(&t.app, &token, json!({ "type": "small" })).await;
    let events = parse_stream(&stream);
    let kinds: Vec<&str> = events
        .iter()
        .map(|e| e["event"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, vec!["created", "state", "state", "state", "ready"]);

    assert_eq!(events[0]["event"], "created");
    assert_eq!(events[0]["id"], id);
    assert_eq!(events[0]["ttlSeconds"], 900);
    assert_eq!(events[0]["team"], Value::Null);

    assert_eq!(events[1]["event"], "state");
    assert_eq!(events[1]["state"], "provisioning");
    assert_eq!(events[2]["state"], "cloning");
    assert_eq!(events[3]["state"], "ready");

    assert_eq!(events[4]["event"], "ready");
    assert_eq!(events[4]["state"], "ready");
    assert!(events[4]["ip"].is_string());
    assert!(events[4]["url"].as_str().unwrap().starts_with("https://"));
    assert!(events[4]["url"].as_str().unwrap().ends_with(".ori.test"));
    assert!(events[4]["commands"]["ssh"].as_str().unwrap().contains(&id));
    assert!(events[4]["commands"]["forward"]
        .as_str()
        .unwrap()
        .contains(&id));
}

// ---------------------------------------------------------------------------
// warm pool: create claims a pre-started slot, cold-creates on a miss
// ---------------------------------------------------------------------------

/// A `test_app` with the warm pool enabled. The pool is seeded manually
/// (golden + refill) so tests are deterministic; `build_app` spawns no refill
/// loop, matching how tests use the rest of the server.
async fn test_app_with_pool() -> TestApp {
    let db = db::open_in_memory().await.unwrap();
    let provider = Arc::new(MockProvider::new());
    let config = Config {
        domain: "ori.test".to_string(),
        pool_depth: 1,
        ..Config::default()
    };
    let app = ori_server::build_app(db.clone(), provider.clone(), config);
    TestApp { app, provider, db }
}

fn pool_key() -> PoolKey {
    PoolKey {
        provider: "mock".into(),
        machine_type: MachineType::Default,
        environment_version: 1,
    }
}

/// Seed warm slots for the default key the way the background refill loop
/// does: register a golden snapshot, then clone+start from it.
async fn seed_pool(app: &TestApp, depth: usize) {
    let pm = PoolManager::new(
        app.db.clone(),
        app.provider.clone(),
        PoolConfig {
            depth,
            ..PoolConfig::default()
        },
    );
    let key = pool_key();
    pm.register_golden(
        &key,
        "base",
        &SnapshotRef {
            provider: "mock".into(),
            name: "golden-base".into(),
        },
    )
    .await
    .unwrap();
    assert_eq!(pm.refill_key(&key).await.unwrap(), depth);
    assert_eq!(pm.available_count(&key).await.unwrap(), depth);
}

/// `ori new` with a warm slot takes the claim, never cold-creates, and the
/// stream has no `cloning` event (nothing was cloned).
#[tokio::test]
async fn create_claims_a_warm_slot_instead_of_cold_creating() {
    let t = test_app_with_pool().await;
    seed_pool(&t, 1).await;

    let token = bootstrap_key(&t.app).await;
    let (id, stream) = create_sandbox(&t.app, &token, json!({})).await;

    let events = parse_stream(&stream);
    let kinds: Vec<&str> = events
        .iter()
        .map(|e| e["event"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, vec!["created", "state", "state", "ready"]);
    assert_eq!(events[1]["state"], "provisioning");
    assert_eq!(events[2]["state"], "ready");

    // the provider was never asked to cold-create, and the slot is gone
    assert_eq!(t.provider.registry.lock().unwrap().create_calls, 0);
    let pm = PoolManager::new(
        t.db.clone(),
        t.provider.clone(),
        PoolConfig {
            depth: 1,
            ..PoolConfig::default()
        },
    );
    assert_eq!(pm.available_count(&pool_key()).await.unwrap(), 0);

    let (_, v) = sandbox_info(&t.app, &token, &id).await;
    assert_eq!(v["sandbox"]["state"], "ready");
    assert!(v["sandbox"]["ip"].is_string());
}

/// A miss falls back to the cold path and the `cloning` event makes the miss
/// visible in the stream instead of a silent ~9 s pause.
#[tokio::test]
async fn create_falls_back_to_cold_path_on_pool_miss_and_emits_cloning() {
    let t = test_app_with_pool().await;
    // pool enabled but empty: every create misses
    let token = bootstrap_key(&t.app).await;
    let (id, stream) = create_sandbox(&t.app, &token, json!({})).await;

    let events = parse_stream(&stream);
    let kinds: Vec<&str> = events
        .iter()
        .map(|e| e["event"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, vec!["created", "state", "state", "state", "ready"]);
    assert_eq!(events[1]["state"], "provisioning");
    assert_eq!(events[2]["state"], "cloning");
    assert_eq!(events[3]["state"], "ready");

    // the cold path really ran
    assert_eq!(t.provider.registry.lock().unwrap().create_calls, 1);
    let (_, v) = sandbox_info(&t.app, &token, &id).await;
    assert_eq!(v["sandbox"]["state"], "ready");
}

#[tokio::test]
async fn create_honours_machine_type_and_ttl() {
    let t = test_app().await;
    let token = bootstrap_key(&t.app).await;
    let (id, _) = create_sandbox(
        &t.app,
        &token,
        json!({ "type": "large", "ttlSeconds": 120 }),
    )
    .await;
    let (status, v) = sandbox_info(&t.app, &token, &id).await;
    assert_eq!(status, StatusCode::OK);
    let sandbox = &v["sandbox"];
    assert_eq!(sandbox["type"], "large");
    assert_eq!(sandbox["vcpu"], 8);
    assert_eq!(sandbox["memoryGB"], 16);
    assert_eq!(sandbox["billingMultiplier"], 2.0);
    assert_eq!(sandbox["environment"], "base");
    assert_eq!(sandbox["environmentVersion"], 1);
    assert_eq!(sandbox["provider"], "mock");
    assert!(sandbox["stopAfter"].as_str().unwrap().contains('T'));
    // the wrapper is load-bearing
    assert!(v.get("sandbox").is_some());
}

#[tokio::test]
async fn create_accepts_the_clis_field_names() {
    let t = test_app().await;
    let token = bootstrap_key(&t.app).await;
    // the current CLI sends `ty`, `setupScript`, `fromSnapshot`
    let (id, _) = create_sandbox(
        &t.app,
        &token,
        json!({ "ty": "small", "setupScript": "echo hi", "personal": false }),
    )
    .await;
    let (_, v) = sandbox_info(&t.app, &token, &id).await;
    assert_eq!(v["sandbox"]["type"], "small");
    assert_eq!(v["sandbox"]["setupStatus"], "done");
}

#[tokio::test]
async fn create_defaults_machine_type() {
    let t = test_app().await;
    let token = bootstrap_key(&t.app).await;
    let (id, _) = create_sandbox(&t.app, &token, json!({})).await;
    let (_, v) = sandbox_info(&t.app, &token, &id).await;
    assert_eq!(v["sandbox"]["type"], "default");
    assert_eq!(v["sandbox"]["vcpu"], 4);
    assert_eq!(v["sandbox"]["memoryGB"], 8);
}

#[tokio::test]
async fn create_rejects_snapshot_from() {
    let t = test_app().await;
    let token = bootstrap_key(&t.app).await;
    let (status, v) = call_json(
        &t.app,
        req(
            Method::POST,
            "/api/v1/sandboxes",
            Some(&token),
            Some(json!({
                "fromSnapshot": "orisnap_abc"
            })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(v["error"]["message"]
        .as_str()
        .unwrap()
        .contains("not implemented"));
}

#[tokio::test]
async fn create_hits_quota() {
    let t = test_app().await;
    let token = bootstrap_key(&t.app).await;
    for _ in 0..20 {
        create_sandbox(&t.app, &token, json!({})).await;
    }
    let (status, v) = call_json(
        &t.app,
        req(
            Method::POST,
            "/api/v1/sandboxes",
            Some(&token),
            Some(json!({})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(v["error"]["code"], "quota_exceeded");
}

#[tokio::test]
async fn list_defaults_to_running_filter_and_paginates() {
    let t = test_app().await;
    let token = bootstrap_key(&t.app).await;
    for _ in 0..3 {
        create_sandbox(&t.app, &token, json!({})).await;
    }
    let (status, v) = call_json(
        &t.app,
        req(Method::GET, "/api/v1/sandboxes", Some(&token), None),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["sandboxes"].as_array().unwrap().len(), 3);
    assert_eq!(v["pageInfo"]["hasMore"], false);
    assert_eq!(v["pageInfo"]["limit"], 50);
    assert_eq!(v["pageInfo"]["nextCursor"], Value::Null);

    // pagination with a tiny limit
    let (_, v) = call_json(
        &t.app,
        req(Method::GET, "/api/v1/sandboxes?limit=2", Some(&token), None),
    )
    .await;
    assert_eq!(v["sandboxes"].as_array().unwrap().len(), 2);
    assert_eq!(v["pageInfo"]["hasMore"], true);
    let cursor = v["pageInfo"]["nextCursor"].as_str().unwrap();
    let (_, v2) = call_json(
        &t.app,
        req(
            Method::GET,
            &format!("/api/v1/sandboxes?limit=2&cursor={cursor}"),
            Some(&token),
            None,
        ),
    )
    .await;
    assert_eq!(v2["sandboxes"].as_array().unwrap().len(), 1);
    assert_eq!(v2["pageInfo"]["hasMore"], false);
}

#[tokio::test]
async fn list_respects_state_filter() {
    let t = test_app().await;
    let token = bootstrap_key(&t.app).await;
    let (id, _) = create_sandbox(&t.app, &token, json!({})).await;
    // stop one so the running-only default filter excludes it
    let (status, _) = call_json(
        &t.app,
        req(
            Method::POST,
            &format!("/api/v1/sandboxes/{id}/stop"),
            Some(&token),
            Some(json!({})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, v) = call_json(
        &t.app,
        req(Method::GET, "/api/v1/sandboxes", Some(&token), None),
    )
    .await;
    assert_eq!(v["sandboxes"].as_array().unwrap().len(), 0);
    let (_, v) = call_json(
        &t.app,
        req(
            Method::GET,
            "/api/v1/sandboxes?filter=rspte",
            Some(&token),
            None,
        ),
    )
    .await;
    assert_eq!(v["sandboxes"].as_array().unwrap().len(), 1);
    assert_eq!(v["sandboxes"][0]["state"], "stopped");
    // bad filter letter is a 400
    let (status, _) = call_json(
        &t.app,
        req(
            Method::GET,
            "/api/v1/sandboxes?filter=x",
            Some(&token),
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn info_is_404_for_unknown_id() {
    let t = test_app().await;
    let token = bootstrap_key(&t.app).await;
    let (status, v) = sandbox_info(&t.app, &token, "ori_doesntexist").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(v["error"]["code"], "not_found");
}

#[tokio::test]
async fn stop_is_idempotent_and_clears_running_state() {
    let t = test_app().await;
    let token = bootstrap_key(&t.app).await;
    let (id, _) = create_sandbox(&t.app, &token, json!({})).await;

    let (status, v) = call_json(
        &t.app,
        req(
            Method::POST,
            &format!("/api/v1/sandboxes/{id}/stop"),
            Some(&token),
            Some(json!({})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["sandbox"]["state"], "stopped");

    // stopping again is a 200 no-op, not a 409
    let (status, v) = call_json(
        &t.app,
        req(
            Method::POST,
            &format!("/api/v1/sandboxes/{id}/stop"),
            Some(&token),
            Some(json!({})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["sandbox"]["state"], "stopped");

    // provider actually stopped the instance exactly once; the idempotent
    // second stop must not re-stop it
    assert_eq!(t.provider.registry.lock().unwrap().stop_calls, 1);
}

#[tokio::test]
async fn resume_streams_accepted_and_is_409_on_running() {
    let t = test_app().await;
    let token = bootstrap_key(&t.app).await;
    let (id, _) = create_sandbox(&t.app, &token, json!({})).await;

    // resume on a running sandbox is a 409 naming the edge
    let (status, v) = call_json(
        &t.app,
        req(
            Method::POST,
            &format!("/api/v1/sandboxes/{id}/resume"),
            Some(&token),
            Some(json!({})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(v["error"]["code"], "invalid_transition");
    assert!(v["error"]["message"]
        .as_str()
        .unwrap()
        .contains("ready -> provisioning"));

    // stop, then resume streams accepted + states + ready
    let (_, _) = call_json(
        &t.app,
        req(
            Method::POST,
            &format!("/api/v1/sandboxes/{id}/stop"),
            Some(&token),
            Some(json!({})),
        ),
    )
    .await;
    let (status, stream) = call(
        &t.app,
        req(
            Method::POST,
            &format!("/api/v1/sandboxes/{id}/resume"),
            Some(&token),
            Some(json!({})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let events = parse_stream(&stream);
    let kinds: Vec<&str> = events
        .iter()
        .map(|e| e["event"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, vec!["accepted", "state", "state", "ready"]);
    assert_eq!(events[0]["status"], "resuming");

    let (_, v) = sandbox_info(&t.app, &token, &id).await;
    assert_eq!(v["sandbox"]["state"], "ready");
    assert!(v["sandbox"]["ip"].is_string());
}

#[tokio::test]
async fn fork_returns_202_and_leaves_source_untouched() {
    let t = test_app().await;
    let token = bootstrap_key(&t.app).await;
    let (src, _) = create_sandbox(&t.app, &token, json!({ "type": "small" })).await;

    let (status, stream) = call(
        &t.app,
        req(
            Method::POST,
            &format!("/api/v1/sandboxes/{src}/fork"),
            Some(&token),
            Some(json!({})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let events = parse_stream(&stream);
    let child_id = events[0]["id"].as_str().unwrap();
    assert_eq!(events[0]["event"], "created");
    // fork TTL defaults to 1h
    assert_eq!(events[0]["ttlSeconds"], 3600);
    assert_ne!(child_id, src);
    assert_eq!(events.last().unwrap()["event"], "ready");

    // source is untouched and still running
    let (_, v) = sandbox_info(&t.app, &token, &src).await;
    assert_eq!(v["sandbox"]["state"], "ready");
    // child is ready and independent
    let (_, v) = sandbox_info(&t.app, &token, child_id).await;
    assert_eq!(v["sandbox"]["state"], "ready");
}

#[tokio::test]
async fn delete_returns_operation_then_completes() {
    let t = test_app().await;
    let token = bootstrap_key(&t.app).await;
    let (id, _) = create_sandbox(&t.app, &token, json!({})).await;

    let (status, v) = call_json(
        &t.app,
        req(
            Method::DELETE,
            &format!("/api/v1/sandboxes/{id}"),
            Some(&token),
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let op = &v["operation"];
    let op_id = op["id"].as_str().unwrap();
    assert!(op_id.starts_with("oriop_"));
    assert_eq!(op["sandboxId"], id);
    assert_eq!(op["status"], "pending");

    // sandbox is gone immediately
    let (status, _) = sandbox_info(&t.app, &token, &id).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // operation reaches completed (async)
    let mut status_str = String::new();
    for _ in 0..50 {
        let (s, v) = call_json(
            &t.app,
            req(
                Method::GET,
                &format!("/api/v1/operations/{op_id}"),
                Some(&token),
                None,
            ),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        status_str = v["operation"]["status"].as_str().unwrap().to_string();
        if status_str == "completed" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(status_str, "completed");
    assert!(t.provider.registry.lock().unwrap().destroy_calls >= 1);
}

#[tokio::test]
async fn exec_runs_and_reports_exit_codes() {
    let t = test_app().await;
    let token = bootstrap_key(&t.app).await;
    let (id, _) = create_sandbox(&t.app, &token, json!({})).await;

    let (status, v) = call_json(
        &t.app,
        req(
            Method::POST,
            &format!("/api/v1/sandboxes/{id}/exec"),
            Some(&token),
            Some(json!({
                "command": ["echo", "hello"],
                "cwd": "/root",
                "timeout": 30,
            })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["exitCode"], 0);
    assert_eq!(v["stdout"], "echo hello\n");
    assert_eq!(v["completed"], true);
    assert!(v["pid"].is_i64());

    // a failing command surfaces its exit code
    let (status, v) = call_json(
        &t.app,
        req(
            Method::POST,
            &format!("/api/v1/sandboxes/{id}/exec"),
            Some(&token),
            Some(json!({
                "command": ["fail"],
            })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["exitCode"], 1);
    assert!(v["stderr"].as_str().unwrap().contains("failed"));

    // exec on a stopped sandbox is a 409
    let (_, _) = call_json(
        &t.app,
        req(
            Method::POST,
            &format!("/api/v1/sandboxes/{id}/stop"),
            Some(&token),
            Some(json!({})),
        ),
    )
    .await;
    let (status, v) = call_json(
        &t.app,
        req(
            Method::POST,
            &format!("/api/v1/sandboxes/{id}/exec"),
            Some(&token),
            Some(json!({
                "command": ["echo"],
            })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(v["error"]["message"]
        .as_str()
        .unwrap()
        .contains("not running"));
}

#[tokio::test]
async fn exec_status_polls_a_detached_pid() {
    let t = test_app().await;
    let token = bootstrap_key(&t.app).await;
    let (id, _) = create_sandbox(&t.app, &token, json!({})).await;
    let (_, v) = call_json(
        &t.app,
        req(
            Method::POST,
            &format!("/api/v1/sandboxes/{id}/exec"),
            Some(&token),
            Some(json!({
                "command": ["echo", "hi"],
                "detach": true,
            })),
        ),
    )
    .await;
    let pid = v["pid"].as_i64().unwrap();
    let (status, v) = call_json(
        &t.app,
        req(
            Method::GET,
            &format!("/api/v1/sandboxes/{id}/exec/{pid}"),
            Some(&token),
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["exitCode"], 0);
    assert!(v["stdout"].as_str().unwrap().contains("echo hi"));
}

#[tokio::test]
async fn extend_moves_the_deadline() {
    let t = test_app().await;
    let token = bootstrap_key(&t.app).await;
    let (id, _) = create_sandbox(&t.app, &token, json!({ "ttlSeconds": 60 })).await;
    let (_, v) = sandbox_info(&t.app, &token, &id).await;
    let before = v["sandbox"]["stopAfter"].as_str().unwrap().to_string();

    let (status, v) = call_json(
        &t.app,
        req(
            Method::POST,
            &format!("/api/v1/sandboxes/{id}/extend"),
            Some(&token),
            Some(json!({
                "hours": 2
            })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let after = v["sandbox"]["stopAfter"].as_str().unwrap();
    assert_ne!(after, before);
    assert!(
        after > before.as_str(),
        "deadline moved later: {after} <= {before}"
    );

    // no-auto-stop clears it
    let (_, v) = call_json(
        &t.app,
        req(
            Method::POST,
            &format!("/api/v1/sandboxes/{id}/extend"),
            Some(&token),
            Some(json!({
                "noAutoStop": true
            })),
        ),
    )
    .await;
    assert_eq!(v["sandbox"]["stopAfter"], Value::Null);
}

// ---------------------------------------------------------------------------
// TTL reaper + reconciliation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ttl_reaper_stops_expired_sandboxes_once() {
    let t = test_app().await;
    let token = bootstrap_key(&t.app).await;
    let (id, _) = create_sandbox(&t.app, &token, json!({ "ttlSeconds": 1 })).await;

    tokio::time::sleep(Duration::from_millis(1200)).await;
    let state = AppState {
        db: t.db.clone(),
        provider: t.provider.clone(),
        config: Default::default(),
        pool: None,
    };
    tasks::reap_expired(&state).await.unwrap();

    let (_, v) = sandbox_info(&t.app, &token, &id).await;
    assert_eq!(v["sandbox"]["state"], "stopped");

    // a second pass must not double-stop (restart mid-reap safety)
    let stops_before = t.provider.registry.lock().unwrap().stop_calls;
    tasks::reap_expired(&state).await.unwrap();
    assert_eq!(t.provider.registry.lock().unwrap().stop_calls, stops_before);

    // a sandbox with no auto-stop deadline is left alone
    let (id2, _) = create_sandbox(&t.app, &token, json!({ "noAutoStop": true })).await;
    tasks::reap_expired(&state).await.unwrap();
    let (_, v) = sandbox_info(&t.app, &token, &id2).await;
    assert_eq!(v["sandbox"]["state"], "ready");
}

#[tokio::test]
async fn reconciler_marks_drift_error_and_destroys_orphans() {
    let t = test_app().await;
    let token = bootstrap_key(&t.app).await;
    let (id, _) = create_sandbox(&t.app, &token, json!({})).await;
    let handle = {
        let reg = t.provider.registry.lock().unwrap();
        reg.instances.keys().next().unwrap().clone()
    };

    let state = AppState {
        db: t.db.clone(),
        provider: t.provider.clone(),
        config: Default::default(),
        pool: None,
    };

    // 1. drift: provider says the instance is gone -> sandbox goes to error
    {
        let mut reg = t.provider.registry.lock().unwrap();
        reg.instances.get_mut(&handle).unwrap().state = ori_server::proto::InstanceStatus::Stopped;
    }
    tasks::reconcile_once(&state).await.unwrap();
    let (_, v) = sandbox_info(&t.app, &token, &id).await;
    assert_eq!(v["sandbox"]["state"], "error");

    // 2. orphan: a provider instance with no DB sandbox is destroyed
    let orphan = t
        .provider
        .create(&ori_server::proto::InstanceSpec {
            id: "orphan".into(),
            name: "orphan".into(),
            machine_type: MachineType::Default,
            environment: "base".into(),
            environment_version: 1,
            env_vars: Default::default(),
        })
        .await
        .unwrap();
    assert!(t
        .provider
        .registry
        .lock()
        .unwrap()
        .instances
        .contains_key(&orphan.id));
    tasks::reconcile_once(&state).await.unwrap();
    assert!(!t
        .provider
        .registry
        .lock()
        .unwrap()
        .instances
        .contains_key(&orphan.id));
}

/// Bug 3 regression: a sandbox whose provider still reports it up must survive
/// a reconcile pass. Earlier the combined "provider:id" handle was stored in
/// `provider_handle`, so reconstruction never matched the mock registry and
/// every fresh sandbox was demoted to `error` on the next reconcile.
#[tokio::test]
async fn reconcile_does_not_demote_a_healthy_ready_sandbox() {
    let t = test_app().await;
    let token = bootstrap_key(&t.app).await;
    let (id, _) = create_sandbox(&t.app, &token, json!({})).await;

    let state = AppState {
        db: t.db.clone(),
        provider: t.provider.clone(),
        config: Default::default(),
        pool: None,
    };
    tasks::reconcile_once(&state).await.unwrap();

    let (_, v) = sandbox_info(&t.app, &token, &id).await;
    assert_eq!(
        v["sandbox"]["state"], "ready",
        "healthy sandbox was demoted"
    );
    // the instance is still there (not destroyed as an orphan)
    assert_eq!(t.provider.registry.lock().unwrap().instances.len(), 1);

    // and it can still be stopped + resumed, exercising the handle round-trip
    let (status, _) = call_json(
        &t.app,
        req(
            Method::POST,
            &format!("/api/v1/sandboxes/{id}/stop"),
            Some(&token),
            Some(json!({})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, stream) = call(
        &t.app,
        req(
            Method::POST,
            &format!("/api/v1/sandboxes/{id}/resume"),
            Some(&token),
            Some(json!({})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let events = parse_stream(&stream);
    let kinds: Vec<&str> = events
        .iter()
        .map(|e| e["event"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, vec!["accepted", "state", "state", "ready"]);
}

// ---------------------------------------------------------------------------
// device login
// ---------------------------------------------------------------------------

#[tokio::test]
async fn device_login_full_flow() {
    let t = test_app().await;
    let (status, start) = call_json(
        &t.app,
        req(
            Method::POST,
            "/api/v1/cli/login/start",
            None,
            Some(json!({ "provider": "google" })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let code = start["code"].as_str().unwrap().to_string();
    let id = start["id"].as_str().unwrap().to_string();
    assert_eq!(code.len(), 9);
    assert!(start["url"].as_str().unwrap().contains(&code));

    // pending until approved
    let (status, v) = call_json(
        &t.app,
        req(
            Method::GET,
            &format!("/api/v1/cli/login/poll/{id}"),
            None,
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["status"], "pending");

    // approve mints a key
    let (status, _) = call_json(
        &t.app,
        req(
            Method::POST,
            &format!("/api/v1/cli/login/{id}/approve"),
            None,
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // poll hands the token out exactly once
    let (_, v) = call_json(
        &t.app,
        req(
            Method::GET,
            &format!("/api/v1/cli/login/poll/{id}"),
            None,
            None,
        ),
    )
    .await;
    assert_eq!(v["status"], "active");
    let token = v["token"].as_str().unwrap().to_string();
    let (_, v) = call_json(
        &t.app,
        req(
            Method::GET,
            &format!("/api/v1/cli/login/poll/{id}"),
            None,
            None,
        ),
    )
    .await;
    assert_eq!(v["status"], "active");
    assert!(v["token"].is_null());

    // the handed-out token authenticates
    let (status, _) = call_json(&t.app, req(Method::GET, "/api/v1/me", Some(&token), None)).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn prompt_interrupt_events_return_not_implemented() {
    let t = test_app().await;
    let token = bootstrap_key(&t.app).await;
    let (id, _) = create_sandbox(&t.app, &token, json!({})).await;
    // prompt/interrupt are POST; the events stream is a GET
    let (status, v) = call_json(
        &t.app,
        req(
            Method::POST,
            &format!("/api/v1/sandboxes/{id}/prompt"),
            Some(&token),
            Some(json!({})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
    assert_eq!(v["error"]["message"], "not implemented in this build");

    let (status, v) = call_json(
        &t.app,
        req(
            Method::POST,
            &format!("/api/v1/sandboxes/{id}/interrupt"),
            Some(&token),
            Some(json!({})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
    assert_eq!(v["error"]["message"], "not implemented in this build");

    let (status, v) = call_json(
        &t.app,
        req(
            Method::GET,
            &format!("/api/v1/sandboxes/{id}/events"),
            Some(&token),
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
    assert_eq!(v["error"]["message"], "not implemented in this build");
}

// ---------------------------------------------------------------------------
// NDJSON flush-per-line over a real socket
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ndjson_is_flushed_per_line_not_buffered() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let db = db::open_in_memory().await.unwrap();
    let provider = Arc::new(MockProvider::new().with_create_delay(Duration::from_millis(1200)));
    let config = Config {
        domain: "ori.test".into(),
        ..Config::default()
    };
    let app = ori_server::build_app(db.clone(), provider.clone(), config);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    // bootstrap a key over this server
    let body = r#"{}"#;
    let resp = raw_request(&addr, "POST", "/api/v1/api-keys", "", body).await;
    let key = extract_secret_from_response(&resp);
    let auth = format!("Bearer {key}");

    let body = r#"{"type":"small"}"#;
    let started = Instant::now();
    let mut sock = tokio::net::TcpStream::connect(addr).await.unwrap();
    let req_text = format!(
        "POST /api/v1/sandboxes HTTP/1.1\r\nHost: {addr}\r\nAuthorization: {auth}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    sock.write_all(req_text.as_bytes()).await.unwrap();

    // read byte-by-byte, timing when the first NDJSON line arrives
    let mut buf = [0u8; 4096];
    let mut received = String::new();
    let mut headers_done = false;
    let mut first_line_at: Option<Duration> = None;
    loop {
        let n = tokio::time::timeout(Duration::from_secs(5), sock.read(&mut buf))
            .await
            .expect("read timeout")
            .unwrap();
        if n == 0 {
            break;
        }
        received.push_str(&String::from_utf8_lossy(&buf[..n]));
        if !headers_done {
            if let Some(pos) = received.find("\r\n\r\n") {
                headers_done = true;
                let rest = &received[pos + 4..];
                if rest.contains('\n') {
                    first_line_at = Some(started.elapsed());
                }
            }
        } else if first_line_at.is_none() && received.contains('\n') {
            first_line_at = Some(started.elapsed());
        }
    }
    let first_line_at = first_line_at.expect("first NDJSON line never arrived");
    // The mock delays `create` by 1200ms; the first lines (created, state)
    // are emitted before create is called. A buffered response would deliver
    // nothing until >= 1200ms. Give generous slack for the local socket.
    assert!(
        first_line_at < Duration::from_millis(1000),
        "first line arrived after {first_line_at:?} — the stream was buffered"
    );

    // the whole stream has the expected events in order (body only — the raw
    // socket read includes the HTTP response headers)
    let body = received.split("\r\n\r\n").nth(1).unwrap_or(&received);
    let events = parse_stream(body);
    let kinds: Vec<&str> = events
        .iter()
        .map(|e| e["event"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, vec!["created", "state", "state", "state", "ready"]);

    // the harness endpoints still work: /me with the key
    let resp = raw_request(&addr, "GET", "/api/v1/me", &auth, "").await;
    assert!(
        resp.contains("\"status\":\"active\""),
        "me response: {resp}"
    );
}

/// Minimal raw-HTTP client over a loopback socket.
async fn raw_request(
    addr: &std::net::SocketAddr,
    method: &str,
    path: &str,
    auth: &str,
    body: &str,
) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut sock = tokio::net::TcpStream::connect(addr).await.unwrap();
    let auth_hdr = if auth.is_empty() {
        String::new()
    } else {
        format!("Authorization: {auth}\r\n")
    };
    let body = body.to_string();
    let content_len = body.len();
    let req_text = if method == "GET" {
        format!("{method} {path} HTTP/1.1\r\nHost: {addr}\r\n{auth_hdr}Connection: close\r\n\r\n")
    } else {
        format!(
            "{method} {path} HTTP/1.1\r\nHost: {addr}\r\n{auth_hdr}Content-Type: application/json\r\nContent-Length: {content_len}\r\nConnection: close\r\n\r\n{body}"
        )
    };
    sock.write_all(req_text.as_bytes()).await.unwrap();
    let mut out = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = sock.read(&mut buf).await.unwrap();
        if n == 0 {
            break;
        }
        out.extend_from_slice(&buf[..n]);
    }
    String::from_utf8_lossy(&out).to_string()
}

fn extract_secret_from_response(resp: &str) -> String {
    let body = resp.split("\r\n\r\n").nth(1).unwrap_or("");
    let v: Value = serde_json::from_str(body).expect("bootstrap response JSON");
    v["secret"].as_str().unwrap().to_string()
}
