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
use ori_server::proto::{HostCapacity, InstanceStatus, MachineType, Provider, SnapshotRef};
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
        webhook_allow_private: true,
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

#[tokio::test]
async fn rotate_revokes_the_old_key_and_mints_a_new_secret() {
    let t = test_app().await;
    let secret = bootstrap_key(&t.app).await;
    let (_status, v) = call_json(
        &t.app,
        req(Method::GET, "/api/v1/api-keys", Some(&secret), None),
    )
    .await;
    let id = v["apiKeys"][0]["id"].as_str().unwrap().to_string();

    let (status, v) = call_json(
        &t.app,
        req(
            Method::POST,
            &format!("/api/v1/api-keys/{id}/rotate"),
            Some(&secret),
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let new_secret = v["apiKey"]["secret"].as_str().unwrap().to_string();
    assert_ne!(new_secret, secret, "rotate must mint a fresh secret");
    assert_eq!(v["apiKey"]["name"], Value::Null);
    // the rotated key authenticated this request, so `current` is true
    assert_eq!(v["current"], true);

    // old secret is dead, new one works
    let (status, _) = call_json(&t.app, req(Method::GET, "/api/v1/me", Some(&secret), None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = call_json(
        &t.app,
        req(Method::GET, "/api/v1/me", Some(&new_secret), None),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // listing shows the old key revoked and the new one active
    let (_, list) = call_json(
        &t.app,
        req(Method::GET, "/api/v1/api-keys", Some(&new_secret), None),
    )
    .await;
    let keys = list["apiKeys"].as_array().unwrap();
    assert_eq!(keys.len(), 2);
    let active: Vec<_> = keys.iter().filter(|k| k["revokedAt"].is_null()).collect();
    assert_eq!(active.len(), 1, "exactly one active key after rotation");
    assert_eq!(active[0]["id"], v["apiKey"]["id"]);
}

// ---------------------------------------------------------------------------
// account / teams
// ---------------------------------------------------------------------------

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
        webhook_allow_private: true,
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
async fn create_refuses_when_thin_pool_storage_is_short() {
    let t = test_app().await;
    // storage below one slot (default slot_gb = 8): the pool footprint eats
    // the headroom and a default sandbox needs 8 GB
    *t.provider.capacity.lock().unwrap() = HostCapacity {
        storage_avail_gb: 4.0,
        free_memory_gb: 10_000.0,
    };
    let token = bootstrap_key(&t.app).await;
    let (status, v) = call_json(
        &t.app,
        req(
            Method::POST,
            "/api/v1/sandboxes",
            Some(&token),
            Some(json!({ "type": "default" })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(v["error"]["code"], "capacity_exceeded");
    let msg = v["error"]["message"].as_str().unwrap();
    assert!(
        msg.contains("storage"),
        "must name the short resource: {msg}"
    );
    assert!(
        msg.contains("headroom"),
        "must reuse preflight headroom: {msg}"
    );
    // nothing was created
    let (_, v) = call_json(
        &t.app,
        req(Method::GET, "/api/v1/sandboxes", Some(&token), None),
    )
    .await;
    assert_eq!(v["sandboxes"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn create_refuses_when_host_memory_is_short() {
    let t = test_app().await;
    // plenty of storage, but free memory cannot fit a `large` (16 GB) sandbox
    *t.provider.capacity.lock().unwrap() = HostCapacity {
        storage_avail_gb: 100_000.0,
        free_memory_gb: 8.0,
    };
    let token = bootstrap_key(&t.app).await;
    let (status, v) = call_json(
        &t.app,
        req(
            Method::POST,
            "/api/v1/sandboxes",
            Some(&token),
            Some(json!({ "type": "large" })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(v["error"]["code"], "capacity_exceeded");
    let msg = v["error"]["message"].as_str().unwrap();
    assert!(
        msg.contains("memory"),
        "must name the short resource: {msg}"
    );
    assert!(msg.contains("large"), "must name the machine type: {msg}");
}

#[tokio::test]
async fn create_allows_when_capacity_is_available() {
    let t = test_app().await;
    let token = bootstrap_key(&t.app).await;
    // default mock capacity is effectively unlimited: `new` succeeds
    let (id, _) = create_sandbox(&t.app, &token, json!({ "type": "small" })).await;
    let (status, v) = sandbox_info(&t.app, &token, &id).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["sandbox"]["state"], "ready");
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
async fn fork_of_running_source_without_snapshot_stops_snapshots_and_restarts() {
    let t = test_app().await;
    let token = bootstrap_key(&t.app).await;
    let (src, _) = create_sandbox(&t.app, &token, json!({ "type": "small" })).await;

    // C24: a running source with no stopped snapshot is the common path
    // (create, work, fork). Fork stops it, snapshots it stopped, restarts it,
    // then clones — the source downtime is announced on the stream first.
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
    assert_ne!(child_id, src);
    // the downtime is announced before the stop, never discovered after it
    let notice = events.iter().find(|e| e["event"] == "notice").unwrap();
    assert!(notice["message"].as_str().unwrap().contains("restarting"));
    assert_eq!(events.last().unwrap()["event"], "ready");

    // the stop produced a stopped-taken (fast-cloneable) snapshot for the source
    let (count,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM snapshots \
         WHERE sandbox_id = ? AND taken_while_stopped = 1 AND state = 'complete'",
    )
    .bind(&src)
    .fetch_one(&t.db)
    .await
    .unwrap();
    assert_eq!(count, 1);

    // source is running again afterwards; child is ready and independent
    let (_, v) = sandbox_info(&t.app, &token, &src).await;
    assert_eq!(v["sandbox"]["state"], "ready");
    let (_, v) = sandbox_info(&t.app, &token, child_id).await;
    assert_eq!(v["sandbox"]["state"], "ready");
}

#[tokio::test]
async fn fork_no_stop_refuses_running_source_without_snapshot() {
    let t = test_app().await;
    let token = bootstrap_key(&t.app).await;
    let (src, _) = create_sandbox(&t.app, &token, json!({ "type": "small" })).await;

    // `--no-stop` keeps the refusal: fork will not take the downtime.
    let (status, stream) = call(
        &t.app,
        req(
            Method::POST,
            &format!("/api/v1/sandboxes/{src}/fork"),
            Some(&token),
            Some(json!({ "noStop": true })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let events = parse_stream(&stream);
    assert_eq!(events.last().unwrap()["event"], "error");
    assert_eq!(events.last().unwrap()["code"], "invalid_request");
    let (_, v) = sandbox_info(&t.app, &token, &src).await;
    assert_eq!(v["sandbox"]["state"], "ready");
}

#[tokio::test]
async fn fork_clone_failure_still_restarts_source() {
    let t = test_app().await;
    let token = bootstrap_key(&t.app).await;
    let (src, _) = create_sandbox(&t.app, &token, json!({ "type": "small" })).await;

    // The source is restarted BEFORE the clone begins, so a failed clone can
    // never leave the user's sandbox powered off.
    t.provider
        .fail_next_clone
        .store(true, std::sync::atomic::Ordering::SeqCst);
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
    assert_eq!(events.last().unwrap()["event"], "error");
    assert_eq!(events.last().unwrap()["code"], "provider_unavailable");

    // the fork failed but the source came back up
    let (_, v) = sandbox_info(&t.app, &token, &src).await;
    assert_eq!(v["sandbox"]["state"], "ready");
    let (handle,): (String,) = sqlx::query_as("SELECT provider_handle FROM sandboxes WHERE id = ?")
        .bind(&src)
        .fetch_one(&t.db)
        .await
        .unwrap();
    let instance = t
        .provider
        .registry
        .lock()
        .unwrap()
        .instances
        .get(&handle)
        .cloned()
        .unwrap();
    assert_eq!(instance.state, InstanceStatus::Running);
}

#[tokio::test]
async fn fork_of_stopped_source_clones_its_snapshot() {
    let t = test_app().await;
    let token = bootstrap_key(&t.app).await;
    let (src, _) = create_sandbox(&t.app, &token, json!({ "type": "small" })).await;

    // stop produces a stopped-taken snapshot; fork of the stopped source then
    // clones from it (no fresh snapshot, no source downtime).
    let (_, _) = call_json(
        &t.app,
        req(
            Method::POST,
            &format!("/api/v1/sandboxes/{src}/stop"),
            Some(&token),
            Some(json!({})),
        ),
    )
    .await;
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
    // the stopped source carries its latest state, so nothing is omitted and
    // no notice is warranted
    assert!(!events.iter().any(|e| e["event"] == "notice"));

    // source is untouched and still stopped
    let (_, v) = sandbox_info(&t.app, &token, &src).await;
    assert_eq!(v["sandbox"]["state"], "stopped");
    // child is ready and independent
    let (_, v) = sandbox_info(&t.app, &token, child_id).await;
    assert_eq!(v["sandbox"]["state"], "ready");
}

#[tokio::test]
async fn fork_of_running_source_clones_stopped_snapshot_and_notices() {
    let t = test_app().await;
    let token = bootstrap_key(&t.app).await;
    let (src, _) = create_sandbox(&t.app, &token, json!({})).await;

    // stop -> resume so the source is running AND has a stopped snapshot.
    let (_, _) = call_json(
        &t.app,
        req(
            Method::POST,
            &format!("/api/v1/sandboxes/{src}/stop"),
            Some(&token),
            Some(json!({})),
        ),
    )
    .await;
    let (status, _) = call(
        &t.app,
        req(
            Method::POST,
            &format!("/api/v1/sandboxes/{src}/resume"),
            Some(&token),
            Some(json!({})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // fork the RUNNING source: clones the stopped-taken snapshot, so the
    // stream carries a notice that writes since that stop are not included.
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
    assert_eq!(events.last().unwrap()["event"], "ready");
    let notice = events.iter().find(|e| e["event"] == "notice").unwrap();
    assert!(notice["message"]
        .as_str()
        .unwrap()
        .contains("not in this fork"));

    // source is untouched and still running; child is ready and independent
    let (_, v) = sandbox_info(&t.app, &token, &src).await;
    assert_eq!(v["sandbox"]["state"], "ready");
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

/// C16 priority 2: `blocked` must be reachable and report *why* — a snapshot
/// with a dependent incremental cannot be deleted, and the operation must not
/// sit in `pending` forever.
#[tokio::test]
async fn operation_reports_blocked_with_reason() {
    let t = test_app().await;
    let token = bootstrap_key(&t.app).await;
    let (id, _) = create_sandbox(&t.app, &token, json!({})).await;
    let now = ori_server::util::now_ts();
    // this sandbox's snapshot, with a dependent incremental built on it
    sqlx::query(
        "INSERT INTO snapshots (id, account_id, sandbox_id, name, provider_snapshot, state, \
         is_incremental, parent_id, created_at, completed_at) \
         VALUES (?, ?, ?, ?, ?, 'complete', 0, NULL, ?, ?)",
    )
    .bind("orisnap_parent")
    .bind("default")
    .bind(&id)
    .bind("parent")
    .bind("pve/100/parent")
    .bind(&now)
    .bind(&now)
    .execute(&t.db)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO snapshots (id, account_id, sandbox_id, name, provider_snapshot, state, \
         is_incremental, parent_id, created_at, completed_at) \
         VALUES (?, ?, ?, ?, ?, 'complete', 1, 'orisnap_parent', ?, ?)",
    )
    .bind("orisnap_child")
    .bind("default")
    .bind("forked-child")
    .bind("child")
    .bind("pve/101/child")
    .bind(&now)
    .bind(&now)
    .execute(&t.db)
    .await
    .unwrap();

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
    let op_id = v["operation"]["id"].as_str().unwrap().to_string();

    // the operation reaches `blocked` and reports why (never `pending` forever)
    let mut status_str = String::new();
    let mut reason = String::new();
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
        reason = v["operation"]["blockedReason"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        if status_str != "pending" && status_str != "processing" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(status_str, "blocked");
    assert!(
        reason.contains("incremental"),
        "blocked must report why: {reason}"
    );
    // the provider instance was NOT destroyed
    assert_eq!(t.provider.registry.lock().unwrap().destroy_calls, 0);
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
    // the new deadline is stated at the top level, not just embedded
    let after = v["stopAfter"].as_str().unwrap().to_string();
    assert_ne!(after, before);
    assert!(after > before, "deadline moved later: {after} <= {before}");
    assert_eq!(
        v["sandbox"]["stopAfter"], after,
        "sandbox agrees with the stated deadline"
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
    assert_eq!(v["stopAfter"], Value::Null);
    assert_eq!(v["sandbox"]["stopAfter"], Value::Null);

    // a deadline in the past is refused — extend can move later, never back
    let (status, v) = call_json(
        &t.app,
        req(
            Method::POST,
            &format!("/api/v1/sandboxes/{id}/extend"),
            Some(&token),
            Some(json!({ "ttlSeconds": 0 })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(v["error"]["code"], "invalid_request");
    assert!(v["error"]["message"]
        .as_str()
        .unwrap()
        .contains("in the past"));
    let (_, _) = call_json(
        &t.app,
        req(
            Method::POST,
            &format!("/api/v1/sandboxes/{id}/extend"),
            Some(&token),
            Some(json!({ "hours": 0 })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

/// C16 priority 1: the reaper must honour the *new* deadline, not the old one.
/// A test that only checked the API response would pass while the sandbox
/// still died on the original schedule — so this drives the reaper directly.
#[tokio::test]
async fn reaper_honours_the_extended_deadline() {
    let t = test_app().await;
    let token = bootstrap_key(&t.app).await;
    let (id, _) = create_sandbox(&t.app, &token, json!({ "ttlSeconds": 1 })).await;
    let state = AppState {
        db: t.db.clone(),
        provider: t.provider.clone(),
        config: Default::default(),
        pool: None,
        agents: ori_server::tunnel::AgentRegistry::new(),
    };

    // the original 1 s deadline passes
    tokio::time::sleep(Duration::from_millis(1200)).await;
    // extend to +2 h before the reaper ever runs
    let (status, v) = call_json(
        &t.app,
        req(
            Method::POST,
            &format!("/api/v1/sandboxes/{id}/extend"),
            Some(&token),
            Some(json!({ "hours": 2 })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let extended = v["stopAfter"].as_str().unwrap().to_string();
    assert!(!extended.is_empty());

    // the reaper must NOT reap the extended sandbox even though its ORIGINAL
    // TTL has passed
    tasks::reap_expired(&state).await.unwrap();
    let (_, v) = sandbox_info(&t.app, &token, &id).await;
    assert_eq!(
        v["sandbox"]["state"], "ready",
        "reaper killed the extended sandbox on its old deadline"
    );

    // control: a sandbox left on its own schedule does die
    let (control, _) = create_sandbox(&t.app, &token, json!({ "ttlSeconds": 1 })).await;
    tokio::time::sleep(Duration::from_millis(1200)).await;
    tasks::reap_expired(&state).await.unwrap();
    let (_, v) = sandbox_info(&t.app, &token, &control).await;
    assert_eq!(
        v["sandbox"]["state"], "stopped",
        "control sandbox did not die on its TTL"
    );
    // ...and the extended one is still alive
    let (_, v) = sandbox_info(&t.app, &token, &id).await;
    assert_eq!(v["sandbox"]["state"], "ready");

    // the extended sandbox dies once ITS new deadline passes: move the stored
    // deadline (the value extend wrote) into the past and re-reap
    sqlx::query("UPDATE sandboxes SET stop_after = ? WHERE id = ?")
        .bind("2000-01-01T00:00:00Z")
        .bind(&id)
        .execute(&t.db)
        .await
        .unwrap();
    tasks::reap_expired(&state).await.unwrap();
    let (_, v) = sandbox_info(&t.app, &token, &id).await;
    assert_eq!(
        v["sandbox"]["state"], "stopped",
        "reaper must use the stored (extended) deadline"
    );
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
        agents: ori_server::tunnel::AgentRegistry::new(),
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
        agents: ori_server::tunnel::AgentRegistry::new(),
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
        agents: ori_server::tunnel::AgentRegistry::new(),
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
async fn prompt_requires_a_known_provider_and_an_agent_tunnel() {
    let t = test_app().await;
    let token = bootstrap_key(&t.app).await;
    let (id, _) = create_sandbox(&t.app, &token, json!({})).await;

    // An unknown provider is rejected before anything is spawned.
    let (status, v) = call_json(
        &t.app,
        req(
            Method::POST,
            &format!("/api/v1/sandboxes/{id}/prompt"),
            Some(&token),
            Some(json!({"provider": "not-a-provider", "message": "hi"})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{v}");

    // An empty message is rejected too.
    let (status, _) = call_json(
        &t.app,
        req(
            Method::POST,
            &format!("/api/v1/sandboxes/{id}/prompt"),
            Some(&token),
            Some(json!({"provider": "claude", "message": "   "})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // A valid request with no live agent tunnel reports that plainly rather
    // than pretending a run started. The MockProvider has no tunnel.
    let (status, v) = call_json(
        &t.app,
        req(
            Method::POST,
            &format!("/api/v1/sandboxes/{id}/prompt"),
            Some(&token),
            Some(json!({"provider": "claude", "message": "hello"})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{v}");
    assert!(
        v["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("no agent tunnel"),
        "should name the missing tunnel: {v}"
    );

    // `interrupt` with nothing running is a 404, not a silent success.
    let (status, _) = call_json(
        &t.app,
        req(
            Method::POST,
            &format!("/api/v1/sandboxes/{id}/interrupt"),
            Some(&token),
            Some(json!({})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // `events` on a sandbox that has never run an agent is an empty stream,
    // not an error.
    let (status, body) = call(
        &t.app,
        req(
            Method::GET,
            &format!("/api/v1/sandboxes/{id}/events"),
            Some(&token),
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.trim().is_empty(), "expected no events, got: {body}");
}

// ---------------------------------------------------------------------------
// NDJSON flush-per-line over a real socket
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ndjson_is_flushed_per_line_not_buffered() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let db = db::open_in_memory().await.unwrap();
    // `created` and `state` are emitted before `create` is called, so this delay
    // sits *between* the first line and the last one. That gap is the signal.
    const CREATE_DELAY: Duration = Duration::from_millis(1200);
    let provider = Arc::new(MockProvider::new().with_create_delay(CREATE_DELAY));
    let config = Config {
        domain: "ori.test".into(),
        webhook_allow_private: true,
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
    let stream_ended_at = started.elapsed();

    // Measure the GAP between the first line and the end of the stream, not the
    // absolute time to the first line.
    //
    // The absolute form asserted `first_line_at < 1000ms` against a 1200ms
    // create delay, leaving 200ms of headroom for connect + write + routing. On
    // a slower runner the first line took 1331ms and the test failed while the
    // stream was in fact perfectly incremental -- the machine was slower than
    // the very delay the assertion depended on, so it could no longer tell
    // streamed from buffered at all.
    //
    // The gap inverts that dependency. `create` sleeps between the first line
    // and the last, so a streaming response separates them by roughly
    // CREATE_DELAY while a buffered one delivers everything at once and
    // collapses the gap to ~0. A slow machine makes the gap *wider*, which
    // strengthens the assertion instead of breaking it.
    let gap = stream_ended_at.saturating_sub(first_line_at);
    assert!(
        gap >= CREATE_DELAY / 2,
        "first line at {first_line_at:?}, stream ended at {stream_ended_at:?} \
         — only {gap:?} apart, so the response was buffered rather than \
         flushed per line"
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

// ---------------------------------------------------------------------------
// webhooks: CRUD, HMAC-signed delivery, bounded retries
// ---------------------------------------------------------------------------

/// `POST /webhooks` and return (id, secret).
async fn create_webhook(app: &Router, token: &str, url: &str) -> (String, String) {
    let (status, v) = call_json(
        app,
        req(
            Method::POST,
            "/api/v1/webhooks",
            Some(token),
            Some(json!({ "url": url })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "webhook create: {v}");
    let id = v["id"].as_str().unwrap().to_string();
    let secret = v["secret"].as_str().unwrap().to_string();
    assert!(secret.starts_with("ori_ws_"), "secret prefix: {secret}");
    assert_eq!(v["events"], "ready,error,archived");
    (id, secret)
}

/// A local HTTP receiver that captures every webhook delivery (headers +
/// body) so tests can verify the signature and payload. Responds 200.
async fn spawn_receiver() -> (
    std::net::SocketAddr,
    std::sync::Arc<std::sync::Mutex<Vec<Received>>>,
) {
    use axum::routing::post;

    let captured: std::sync::Arc<std::sync::Mutex<Vec<Received>>> =
        std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let app = Router::new().route(
        "/hook",
        post({
            let captured = captured.clone();
            move |headers: axum::http::HeaderMap, body: String| {
                let captured = captured.clone();
                async move {
                    captured.lock().unwrap().push(Received { headers, body });
                    StatusCode::OK
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (addr, captured)
}

#[derive(Clone)]
struct Received {
    headers: axum::http::HeaderMap,
    body: String,
}

impl Received {
    fn header(&self, name: &str) -> Option<String> {
        self.headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string())
    }
}

/// Recompute `sha256=HMAC(secret, "{timestamp}.{body}")` and compare against
/// the delivered `X-Ori-Signature` header — the receiver's side of the handshake.
fn signature_verifies(secret: &str, ts: &str, body: &str, sig_header: &str) -> bool {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(format!("{ts}.{body}").as_bytes());
    let expected = format!("sha256={}", hex::encode(mac.finalize().into_bytes()));
    sig_header == expected
}

async fn wait_for_delivery(
    captured: &std::sync::Arc<std::sync::Mutex<Vec<Received>>>,
    expected: usize,
) -> Vec<Received> {
    for _ in 0..100 {
        let n = captured.lock().unwrap().len();
        if n >= expected {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    captured.lock().unwrap().clone()
}

#[tokio::test]
async fn webhook_crud_and_secret_shown_once() {
    let t = test_app().await;
    let token = bootstrap_key(&t.app).await;

    // empty list
    let (status, v) = call_json(
        &t.app,
        req(Method::GET, "/api/v1/webhooks", Some(&token), None),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["webhooks"].as_array().unwrap().len(), 0);

    let (id, secret) = create_webhook(&t.app, &token, "https://hooks.example.com/ori").await;
    // a second webhook must not be the same secret
    let (_id2, secret2) = create_webhook(&t.app, &token, "https://hooks.example.com/other").await;
    assert_ne!(secret, secret2);

    // list exposes prefix + last four, never the secret
    let (status, v) = call_json(
        &t.app,
        req(Method::GET, "/api/v1/webhooks", Some(&token), None),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let webhooks = v["webhooks"].as_array().unwrap();
    assert_eq!(webhooks.len(), 2);
    let first = webhooks.iter().find(|w| w["id"] == id).unwrap();
    assert_eq!(first["url"], "https://hooks.example.com/ori");
    assert_eq!(first["prefix"].as_str().unwrap().len(), 6);
    assert_eq!(first["lastFour"].as_str().unwrap().len(), 4);
    assert!(
        first.get("secret").is_none(),
        "list must never expose the secret"
    );

    // rotate: fresh secret shown once, old one no longer signs
    let (status, v) = call_json(
        &t.app,
        req(
            Method::POST,
            &format!("/api/v1/webhooks/{id}/rotate"),
            Some(&token),
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let new_secret = v["webhook"]["secret"].as_str().unwrap().to_string();
    assert_ne!(new_secret, secret);

    // remove
    let (status, _) = call_json(
        &t.app,
        req(
            Method::POST,
            &format!("/api/v1/webhooks/{id}/remove"),
            Some(&token),
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, v) = call_json(
        &t.app,
        req(Method::GET, "/api/v1/webhooks", Some(&token), None),
    )
    .await;
    assert_eq!(v["webhooks"].as_array().unwrap().len(), 1);

    // removing the last one leaves zero; removing a bogus id 404s
    let (_id2, _) = create_webhook(&t.app, &token, "https://x.example/h").await;
    let _ = call_json(
        &t.app,
        req(
            Method::POST,
            &format!("/api/v1/webhooks/{id}/remove"),
            Some(&token),
            None,
        ),
    )
    .await;
}

#[tokio::test]
async fn webhook_rejects_non_http_url() {
    let t = test_app().await;
    let token = bootstrap_key(&t.app).await;
    let (status, v) = call_json(
        &t.app,
        req(
            Method::POST,
            "/api/v1/webhooks",
            Some(&token),
            Some(json!({ "url": "file:///etc/hosts" })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(v["error"]["code"], "invalid_request");
    assert!(v["error"]["message"].as_str().unwrap().contains("http(s)"));
}

#[tokio::test]
async fn webhook_delivers_ready_signed_and_off_the_request_path() {
    let t = test_app().await;
    let token = bootstrap_key(&t.app).await;

    // A receiver that does not answer until this test says so. The gate is a
    // semaphore rather than a sleep on purpose: the old version slept 800 ms
    // and asserted create finished inside 500 ms, which is a 300 ms margin
    // measured on a shared CI runner -- it failed at 507 ms and 512 ms.
    //
    // Held open, the gate turns the claim into a structural one instead of a
    // timed one: if delivery were on the request path, create could not
    // possibly return while the receiver is still blocked. Returning at all is
    // the proof, and no clock is involved.
    let gate = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
    let captured: std::sync::Arc<std::sync::Mutex<Vec<Received>>> =
        std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let captured2 = captured.clone();
    let gate2 = gate.clone();
    let app = Router::new().route(
        "/hook",
        axum::routing::post(move |headers: axum::http::HeaderMap, body: String| {
            let captured = captured2.clone();
            let gate = gate2.clone();
            async move {
                // Permits persist, so releasing before the handler arrives here
                // is not a lost wakeup -- unlike `Notify::notify_waiters`.
                let _permit = gate.acquire().await.expect("gate open");
                captured.lock().unwrap().push(Received { headers, body });
                StatusCode::OK
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let (_id, secret) = create_webhook(&t.app, &token, &format!("http://{addr}/hook")).await;

    // Generous outer bound only so a regression fails instead of hanging CI.
    let (sandbox_id, _) = tokio::time::timeout(
        Duration::from_secs(30),
        create_sandbox(&t.app, &token, json!({})),
    )
    .await
    .expect("a blocked webhook receiver must not hold up the sandbox reaching ready");

    // Nothing can have been delivered yet: the receiver is still gated.
    assert!(
        captured.lock().unwrap().is_empty(),
        "delivery ran inline on the request path"
    );

    // Let the receiver answer; the delivery must still arrive, and be signed.
    gate.add_permits(1);

    // the delivery still arrives, signed, once the receiver finishes
    let received = wait_for_delivery(&captured, 1).await;
    assert_eq!(received.len(), 1, "expected exactly one ready delivery");
    let recv = &received[0];
    assert_eq!(recv.header("X-Ori-Event").as_deref(), Some("ready"));
    assert_eq!(
        recv.header("X-Ori-Delivery-Id")
            .as_deref()
            .map(|s| s.starts_with("oriwd_")),
        Some(true)
    );

    let ts = recv
        .header("X-Ori-Timestamp")
        .expect("delivery must carry a timestamp for replay rejection");
    let sig = recv
        .header("X-Ori-Signature")
        .expect("delivery must be HMAC-signed");
    assert!(
        signature_verifies(&secret, &ts, &recv.body, &sig),
        "delivery signature must verify against the webhook secret"
    );
    let payload: Value = serde_json::from_str(&recv.body).unwrap();
    assert_eq!(payload["event"], "ready");
    assert_eq!(payload["id"], sandbox_id);
    assert_eq!(payload["state"], "ready");
    assert!(payload["occurredAt"].is_string());
}

#[tokio::test]
async fn webhook_delivers_archived_on_delete() {
    let t = test_app().await;
    let token = bootstrap_key(&t.app).await;
    let (addr, captured) = spawn_receiver().await;
    let (_id, secret) = create_webhook(&t.app, &token, &format!("http://{addr}/hook")).await;

    let (sandbox_id, _) = create_sandbox(&t.app, &token, json!({})).await;
    // drain the ready delivery so we can assert the archived one cleanly
    let _ = wait_for_delivery(&captured, 1).await;
    let (status, _) = call_json(
        &t.app,
        req(
            Method::DELETE,
            &format!("/api/v1/sandboxes/{sandbox_id}"),
            Some(&token),
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let received = wait_for_delivery(&captured, 2).await;
    assert_eq!(received.len(), 2);
    let archived = &received[1];
    assert_eq!(archived.header("X-Ori-Event").as_deref(), Some("archived"));
    let payload: Value = serde_json::from_str(&archived.body).unwrap();
    assert_eq!(payload["id"], sandbox_id);
    let ts = archived.header("X-Ori-Timestamp").unwrap();
    let sig = archived.header("X-Ori-Signature").unwrap();
    assert!(signature_verifies(&secret, &ts, &archived.body, &sig));
}

/// A dead endpoint must stop being retried instead of accumulating pending
/// deliveries: the delivery is dropped after `max_attempts` and recorded as
/// dropped. Retries are driven via the same sweeper the server runs.
#[tokio::test]
async fn webhook_dead_endpoint_is_dropped_not_accumulated() {
    let t = test_app().await;
    let token = bootstrap_key(&t.app).await;

    // a port nothing listens on
    let dead = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = dead.local_addr().unwrap();
    drop(dead);

    let (id, _secret) = create_webhook(&t.app, &token, &format!("http://{addr}/hook")).await;
    let (sandbox_id, _) = create_sandbox(&t.app, &token, json!({})).await;

    // wait for the enqueued delivery row to exist
    let mut delivery_id: Option<String> = None;
    for _ in 0..100 {
        let row: Option<(String,)> = sqlx::query_as(
            "SELECT id FROM webhook_deliveries WHERE webhook_id = ? AND event = 'ready'",
        )
        .bind(&id)
        .fetch_optional(&t.db)
        .await
        .unwrap();
        if let Some((did,)) = row {
            delivery_id = Some(did);
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let delivery_id = delivery_id.expect("delivery row was never enqueued");

    // drive the sweeper until the cap is reached (force-due between passes so
    // the backoff does not slow the test)
    let state = AppState {
        db: t.db.clone(),
        provider: t.provider.clone(),
        config: Default::default(),
        pool: None,
        agents: ori_server::tunnel::AgentRegistry::new(),
    };
    for _ in 0..20 {
        ori_server::routes::webhook::attempt_due_deliveries(&state).await;
        let row: Option<(String, i64, i64)> = sqlx::query_as(
            "SELECT status, attempts, max_attempts FROM webhook_deliveries WHERE id = ?",
        )
        .bind(&delivery_id)
        .fetch_optional(&t.db)
        .await
        .unwrap();
        if let Some((status, attempts, max)) = row {
            if status == "dropped" {
                assert_eq!(attempts, max, "dropped after the attempt cap");
                break;
            }
            if attempts > 0 {
                // make the scheduled retry due immediately
                sqlx::query("UPDATE webhook_deliveries SET next_attempt_at = '2000-01-01T00:00:00Z' WHERE id = ?")
                    .bind(&delivery_id)
                    .execute(&t.db)
                    .await
                    .unwrap();
            }
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let (status, attempts, dropped_at): (String, i64, String) =
        sqlx::query_as("SELECT status, attempts, dropped_at FROM webhook_deliveries WHERE id = ?")
            .bind(&delivery_id)
            .fetch_one(&t.db)
            .await
            .unwrap();
    assert_eq!(
        status, "dropped",
        "dead endpoint must be dropped, not retried forever"
    );
    assert_eq!(attempts, 5, "exactly the attempt cap, no unbounded growth");
    assert!(!dropped_at.is_empty(), "the drop must be recorded");

    // exactly one delivery row for the whole retry saga — retries reuse the
    // row rather than appending
    let (count,): (i64,) =
        sqlx::query_as("SELECT count(*) FROM webhook_deliveries WHERE webhook_id = ?")
            .bind(&id)
            .fetch_one(&t.db)
            .await
            .unwrap();
    assert_eq!(count, 1, "retries must not accumulate pending deliveries");
    // ...and the sandbox itself was unaffected
    let (_, v) = sandbox_info(&t.app, &token, &sandbox_id).await;
    assert_eq!(v["sandbox"]["state"], "ready");
}

// ---------------------------------------------------------------------------
// data retention
// ---------------------------------------------------------------------------

#[tokio::test]
async fn data_retention_status_then_enable_skips_stop_snapshots() {
    let t = test_app().await;
    let token = bootstrap_key(&t.app).await;

    // disabled by default
    let (status, v) = call_json(
        &t.app,
        req(
            Method::GET,
            "/api/v1/account/data-retention",
            Some(&token),
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["enabled"], false);

    // stop snapshots while disabled
    let (id, _) = create_sandbox(&t.app, &token, json!({})).await;
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
    let (count,): (i64,) = sqlx::query_as("SELECT count(*) FROM snapshots WHERE sandbox_id = ?")
        .bind(&id)
        .fetch_one(&t.db)
        .await
        .unwrap();
    assert_eq!(count, 1, "disabled retention snapshots on stop");

    // enable (idempotent — second enable is a 200, not an error)
    let (status, v) = call_json(
        &t.app,
        req(
            Method::POST,
            "/api/v1/account/data-retention",
            Some(&token),
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["enabled"], true);
    let (status, _) = call_json(
        &t.app,
        req(
            Method::POST,
            "/api/v1/account/data-retention",
            Some(&token),
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, v) = call_json(
        &t.app,
        req(
            Method::GET,
            "/api/v1/account/data-retention",
            Some(&token),
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["enabled"], true);

    // now stop snapshots the data away
    let (id2, _) = create_sandbox(&t.app, &token, json!({})).await;
    let (status, _) = call_json(
        &t.app,
        req(
            Method::POST,
            &format!("/api/v1/sandboxes/{id2}/stop"),
            Some(&token),
            Some(json!({})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (count,): (i64,) = sqlx::query_as("SELECT count(*) FROM snapshots WHERE sandbox_id = ?")
        .bind(&id2)
        .fetch_one(&t.db)
        .await
        .unwrap();
    assert_eq!(count, 0, "enabled retention must skip the stop snapshot");
}

#[tokio::test]
async fn data_retention_is_per_account() {
    let t = test_app().await;
    let token = bootstrap_key(&t.app).await;
    let (_, v) = call_json(
        &t.app,
        req(
            Method::GET,
            "/api/v1/account/data-retention",
            Some(&token),
            None,
        ),
    )
    .await;
    assert_eq!(v["enabled"], false);
}

// ---------------------------------------------------------------------------
// dashboard + self-update version
// ---------------------------------------------------------------------------

#[tokio::test]
async fn dashboard_serves_a_page_derived_from_config() {
    let t = test_app().await;
    let (status, body) = call(&t.app, req(Method::GET, "/dashboard", None, None)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("ori"));
    assert!(
        body.contains("ori.test"),
        "dashboard must reflect the configured domain"
    );
}

#[tokio::test]
async fn cli_version_without_release_base_reports_up_to_date() {
    let t = test_app().await;
    let (status, v) = call_json(&t.app, req(Method::GET, "/api/v1/cli/version", None, None)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["current"], env!("CARGO_PKG_VERSION"));
    assert_eq!(v["latest"], v["current"]);
    assert_eq!(v["channel"], "stable");
    assert_eq!(v["updateAvailable"], false);
    assert!(v["releaseBaseUrl"].is_null());
}

#[tokio::test]
async fn cli_version_reads_the_latest_json_contract() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path();
    std::fs::write(
        base.join("latest.json"),
        r#"{"version":"99.1.0","channel":"stable","platforms":{}}"#,
    )
    .unwrap();

    let db = db::open_in_memory().await.unwrap();
    let provider = Arc::new(MockProvider::new());
    let config = Config {
        domain: "ori.test".to_string(),
        release_base_url: Some(base.display().to_string()),
        webhook_allow_private: true,
        ..Config::default()
    };
    let app = ori_server::build_app(db.clone(), provider.clone(), config);

    let (status, v) = call_json(&app, req(Method::GET, "/api/v1/cli/version", None, None)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["current"], env!("CARGO_PKG_VERSION"));
    assert_eq!(v["latest"], "99.1.0");
    assert_eq!(v["updateAvailable"], true);
    assert_eq!(v["releaseBaseUrl"], base.display().to_string());
}
