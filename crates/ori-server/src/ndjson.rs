//! NDJSON response streaming. One JSON object per line, delivered as a
//! stream where each line is its own chunk: hyper writes chunks as they
//! arrive and tokio sets TCP_NODELAY on accepted sockets, so a client on
//! localhost sees each line as it is produced rather than one buffered blob.
//! A buffered response that arrives all at once is a bug even though the
//! bytes are identical.

use std::convert::Infallible;

use axum::body::{Body, Bytes};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use futures_util::stream::unfold;
use tokio::sync::mpsc;

/// Build a streamed response body from a channel of pre-serialised NDJSON
/// lines. The body ends when the sender is dropped.
pub fn ndjson_body(rx: mpsc::UnboundedReceiver<Bytes>) -> Body {
    Body::from_stream(unfold(rx, move |mut rx| async move {
        match rx.recv().await {
            Some(bytes) => Some((Ok::<Bytes, Infallible>(bytes), rx)),
            None => None,
        }
    }))
}

pub fn ndjson_response(rx: mpsc::UnboundedReceiver<Bytes>, status: StatusCode) -> Response {
    (
        status,
        [("content-type", "application/x-ndjson")],
        ndjson_body(rx),
    )
        .into_response()
}
