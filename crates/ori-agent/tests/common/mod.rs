//! Shared helpers for `ori-agent` integration tests. These go through the
//! public `Agent::handle` API — the exact path the tunnel uses — so they
//! exercise the real request pipeline (wire frame → handler → result).
//!
//! Compiled into every test binary; each binary uses a subset, so silence the
//! per-crate unused warnings.

#![allow(dead_code)]

use std::path::Path;
use std::time::Duration;

use ori_agent::{
    Agent, Config, Incoming, Outgoing, StreamDataFrame, Streams, OUTBOUND_BUFFER_CHUNKS,
};
use tokio::sync::mpsc;

/// A minimal config pointed at a throwaway control-plane URL. The tunnel is
/// never dialed in tests; only the handler is exercised.
pub fn cfg(work_dir: &Path) -> Config {
    Config {
        control_plane_url: "ws://127.0.0.1:1".into(),
        token: "test-token".into(),
        sandbox_id: "ori_test".into(),
        work_dir: work_dir.to_path_buf(),
        claim: Default::default(),
    }
}

/// Everything a handler run emitted: JSON text frames plus any binary stream
/// data.
#[derive(Debug)]
pub struct Frames {
    pub json: Vec<Outgoing>,
    pub bin: Vec<StreamDataFrame>,
}

impl Frames {
    /// A handler emitted no stream data.
    pub fn assert_no_stream_data(&self) {
        assert!(
            self.bin.is_empty(),
            "expected no stream data: {:?}",
            self.bin
        );
    }
}

/// Drive one request through `Agent::handle` and collect every frame it emits.
/// Frames that legitimately arrive after the handler returns (e.g. proactive
/// `setupStatus`, or a stream relay's terminal `streamClose`) are caught by a
/// short grace poll.
pub async fn request(agent: &Agent, msg: Incoming) -> Frames {
    let (tx, mut rx) = mpsc::channel(64);
    let (bin_tx, mut bin_rx) = mpsc::channel::<StreamDataFrame>(OUTBOUND_BUFFER_CHUNKS);
    let streams = Streams::new(bin_tx);
    agent
        .handle(msg, tx.clone(), &streams)
        .await
        .expect("handler must not error");
    drain(&mut rx, &mut bin_rx).await
}

/// Poll `request` until a predicate holds or a deadline passes.
pub async fn request_until(
    agent: &Agent,
    msg: Incoming,
    deadline: tokio::time::Instant,
    mut pred: impl FnMut(&Outgoing) -> bool,
) -> Frames {
    let (tx, mut rx) = mpsc::channel(64);
    let (bin_tx, mut bin_rx) = mpsc::channel::<StreamDataFrame>(OUTBOUND_BUFFER_CHUNKS);
    let streams = Streams::new(bin_tx);
    agent
        .handle(msg, tx.clone(), &streams)
        .await
        .expect("handler must not error");
    let mut out = Frames {
        json: Vec::new(),
        bin: Vec::new(),
    };
    loop {
        tokio::select! {
            f = rx.recv() => {
                match f {
                    Some(f) => {
                        let hit = pred(&f);
                        out.json.push(f);
                        if hit {
                            break;
                        }
                    }
                    None => break,
                }
            }
            f = bin_rx.recv() => {
                match f {
                    Some(f) => out.bin.push(f),
                    None => break,
                }
            }
            _ = tokio::time::sleep_until(deadline) => break,
        }
    }
    out
}

/// Drain both channels until 200 ms of quiet (or closure of either).
async fn drain(
    rx: &mut mpsc::Receiver<Outgoing>,
    bin_rx: &mut mpsc::Receiver<StreamDataFrame>,
) -> Frames {
    let mut out = Frames {
        json: Vec::new(),
        bin: Vec::new(),
    };
    let mut idle = false;
    while !idle {
        tokio::select! {
            f = rx.recv() => match f {
                Some(f) => out.json.push(f),
                None => break,
            },
            f = bin_rx.recv() => match f {
                Some(f) => out.bin.push(f),
                None => break,
            },
            _ = tokio::time::sleep(Duration::from_millis(200)) => idle = true,
        }
    }
    out
}

/// Extract the terminal `execResult` from a batch of frames.
pub fn exec_result(frames: &Frames) -> Option<&Outgoing> {
    frames
        .json
        .iter()
        .find(|f| matches!(f, Outgoing::ExecResult { .. }))
}

/// Extract a `setupStatus` frame from a batch.
pub fn setup_status(frames: &Frames) -> Option<&Outgoing> {
    frames
        .json
        .iter()
        .find(|f| matches!(f, Outgoing::SetupStatus { .. }))
}

/// Concatenate the stream data for one stream id from a batch of frames.
pub fn stream_bytes(frames: &Frames, id: u64) -> Vec<u8> {
    frames
        .bin
        .iter()
        .filter(|f| f.id == id)
        .flat_map(|f| f.bytes.iter().copied())
        .collect()
}
