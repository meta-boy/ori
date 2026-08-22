use axum::Router;
use axum::routing::{get, post};
use axum::extract::Path;
use axum::body::Body;
use axum::http::Request;
use tower::ServiceExt;

async fn handler(Path(id): Path<String>) -> String { id }

#[tokio::main]
async fn main() {
    let app = Router::new()
        .route("/api/v1/sandboxes/{id}", get(handler))
        .route("/api/v1/sandboxes/{id}/stop", post(handler));
    let resp = app.clone().oneshot(Request::builder().uri("/api/v1/sandboxes/abc123").body(Body::empty()).unwrap()).await.unwrap();
    println!("GET sandboxes/abc123 -> {}", resp.status());
    let resp = app.clone().oneshot(Request::builder().method("POST").uri("/api/v1/sandboxes/abc123/stop").body(Body::empty()).unwrap()).await.unwrap();
    println!("POST sandboxes/abc123/stop -> {}", resp.status());
}
