//! Byte streams (`plans/C13-agent-streams.md`) through the real handler: TCP
//! relay against a local listener, file round-trip including a directory
//! (tarred), traversal rejection, and — the important one — a backpressure
//! test that pushes more than the buffer and asserts memory stays bounded.

mod common;

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::Duration;

use common::cfg;
use ori_agent::{
    Agent, Incoming, Outgoing, StreamDataFrame, StreamFileMode, StreamId, StreamKind, Streams,
    OUTBOUND_BUFFER_CHUNKS, STREAM_CHUNK_BYTES,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

fn temp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("ori-agent-stream-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// A handler wired to real channels, mirroring the tunnel's setup: the handler
/// gets a JSON sender + the shared `Streams`, and the test drives the plane's
/// side (route inbound data, close, drain outbound data).
struct Harness {
    agent: Agent,
    streams: Streams,
    tx: mpsc::Sender<Outgoing>,
    rx: mpsc::Receiver<Outgoing>,
    bin_rx: mpsc::Receiver<StreamDataFrame>,
}

impl Harness {
    async fn new(dir: &Path) -> Self {
        let work = dir.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let agent = Agent::with_logs_dir(cfg(&work), dir.join("state"));
        let (tx, rx) = mpsc::channel::<Outgoing>(64);
        let (bin_tx, bin_rx) = mpsc::channel::<StreamDataFrame>(OUTBOUND_BUFFER_CHUNKS);
        let streams = Streams::new(bin_tx);
        Harness {
            agent,
            streams,
            tx,
            rx,
            bin_rx,
        }
    }

    async fn open(&self, id: StreamId, kind: StreamKind) {
        self.agent
            .handle(
                Incoming::StreamOpen { id, kind },
                self.tx.clone(),
                &self.streams,
            )
            .await
            .expect("streamOpen must not error");
    }

    async fn close(&self, id: StreamId) {
        self.agent
            .handle(
                Incoming::StreamClose { id, code: 0 },
                self.tx.clone(),
                &self.streams,
            )
            .await
            .expect("streamClose must not error");
    }

    /// Collect every chunk for one stream id plus the terminal close code,
    /// until a quiet moment or the channels close.
    async fn drain_stream(&mut self, id: StreamId) -> (Vec<u8>, Option<u16>) {
        let mut bytes = Vec::new();
        let mut close = None;
        loop {
            tokio::select! {
                f = self.bin_rx.recv() => match f {
                    Some(f) if f.id == id => bytes.extend_from_slice(&f.bytes),
                    Some(_) => {}
                    None => break,
                },
                f = self.rx.recv() => match f {
                    Some(Outgoing::StreamClose { id: cid, code }) if cid == id => close = Some(code),
                    Some(_) => {}
                    None => break,
                },
                _ = tokio::time::sleep(Duration::from_millis(200)) => break,
            }
        }
        (bytes, close)
    }

    /// The next `streamClose` for `id`, or `None` if it never comes.
    async fn next_close(&mut self, id: StreamId) -> Option<u16> {
        loop {
            tokio::select! {
                f = self.rx.recv() => match f {
                    Some(Outgoing::StreamClose { id: cid, code }) if cid == id => return Some(code),
                    Some(_) => {}
                    None => return None,
                },
                _ = tokio::time::sleep(Duration::from_secs(5)) => return None,
            }
        }
    }
}

#[tokio::test]
async fn tcp_relay_echoes_both_ways() {
    let dir = temp_dir("tcp");
    let mut h = Harness::new(&dir).await;

    // A local loopback echo server.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let mut buf = vec![0u8; 4096];
                loop {
                    match sock.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if sock.write_all(&buf[..n]).await.is_err() {
                                break;
                            }
                        }
                    }
                }
            });
        }
    });

    let id = 1u64;
    h.open(id, StreamKind::Tcp { port }).await;

    // Plane → agent → tcp → agent → plane: the echo comes back as stream data.
    h.streams
        .route_data(id, b"hello over the tunnel".to_vec())
        .await;
    let (bytes, _close) = tokio::time::timeout(Duration::from_secs(5), h.drain_stream(id))
        .await
        .expect("echo never arrived");
    assert_eq!(bytes, b"hello over the tunnel");

    // The stream stays open until either side closes it; the plane closes and
    // the agent acks cleanly.
    h.close(id).await;
    let code = h.next_close(id).await;
    assert_eq!(
        code,
        Some(0),
        "tcp stream should close cleanly after plane close"
    );

    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn tcp_relay_refuses_when_nothing_listens() {
    let dir = temp_dir("tcp-refused");
    let mut h = Harness::new(&dir).await;

    // Bind then drop to guarantee a closed port.
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };

    let id = 1u64;
    h.open(id, StreamKind::Tcp { port }).await;
    let code = h.next_close(id).await;
    assert_eq!(code, Some(1), "a refused dial must surface as close code 1");

    // No stream data should have flowed.
    assert!(h.bin_rx.try_recv().is_err(), "no data on a refused dial");

    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn file_round_trip_including_a_directory() {
    let dir = temp_dir("file");
    let work = dir.join("work");
    std::fs::create_dir_all(work.join("sub/nested")).unwrap();
    // A real file, a nested file, and a hidden one.
    let payload: Vec<u8> = (0..=255).cycle().take(200_000).collect();
    std::fs::write(work.join("data.bin"), &payload).unwrap();
    std::fs::write(work.join("sub/a.txt"), b"alpha").unwrap();
    std::fs::write(work.join("sub/nested/deep.txt"), b"bravo").unwrap();
    std::fs::write(work.join("sub/.hidden"), b"hidden").unwrap();

    let mut h = Harness::new(&dir).await;

    // --- Read a file: bytes come back exactly. ---
    h.open(
        1,
        StreamKind::File {
            path: "data.bin".into(),
            mode: StreamFileMode::Read,
        },
    )
    .await;
    let (bytes, close) = h.drain_stream(1).await;
    assert_eq!(bytes, payload);
    assert_eq!(close, Some(0));

    // --- Write a file: bytes land on disk. ---
    h.open(
        2,
        StreamKind::File {
            path: "out.bin".into(),
            mode: StreamFileMode::Write,
        },
    )
    .await;
    for chunk in payload.chunks(STREAM_CHUNK_BYTES) {
        h.streams.route_data(2, chunk.to_vec()).await;
    }
    h.close(2).await;
    let close = h.next_close(2).await;
    assert_eq!(close, Some(0), "write must ack with a clean close");
    assert_eq!(std::fs::read(work.join("out.bin")).unwrap(), payload);

    // --- Read a directory: it comes back tarred. ---
    h.open(
        3,
        StreamKind::File {
            path: "sub".into(),
            mode: StreamFileMode::Read,
        },
    )
    .await;
    let (tar_bytes, close) = h.drain_stream(3).await;
    assert!(!tar_bytes.is_empty());
    assert_eq!(close, Some(0));

    // --- Write that tar back to a new directory: the tree round-trips. ---
    h.open(
        4,
        StreamKind::File {
            path: "sub2/".into(),
            mode: StreamFileMode::Write,
        },
    )
    .await;
    for chunk in tar_bytes.chunks(STREAM_CHUNK_BYTES) {
        h.streams.route_data(4, chunk.to_vec()).await;
    }
    h.close(4).await;
    let close = h.next_close(4).await;
    assert_eq!(close, Some(0), "tar write must ack clean");
    assert_trees_equal(&work.join("sub"), &work.join("sub2"));

    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn rejects_path_traversal() {
    let dir = temp_dir("traversal");
    let work = dir.join("work");
    std::fs::create_dir_all(&work).unwrap();
    let outside = dir.join("outside-secret");
    std::fs::write(&outside, b"s3cr3t").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, work.join("evil")).unwrap();

    let mut h = Harness::new(&dir).await;

    let cases: Vec<(StreamId, StreamKind)> = vec![
        (
            1,
            StreamKind::File {
                path: "../escape".into(),
                mode: StreamFileMode::Read,
            },
        ),
        (
            2,
            StreamKind::File {
                path: "/etc/passwd".into(),
                mode: StreamFileMode::Read,
            },
        ),
        (
            3,
            StreamKind::File {
                path: "a/../../escape".into(),
                mode: StreamFileMode::Write,
            },
        ),
        (
            4,
            StreamKind::File {
                path: "evil".into(),
                mode: StreamFileMode::Read,
            },
        ),
    ];

    for (id, kind) in cases {
        h.open(id, kind).await;
        let code = h.next_close(id).await;
        assert_eq!(code, Some(2), "stream {id} must be rejected as traversal");
        assert!(
            h.bin_rx.try_recv().is_err(),
            "a rejected stream must not produce data (id {id})"
        );
    }

    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn backpressure_keeps_memory_bounded_under_a_large_push() {
    let dir = temp_dir("backpressure");
    let work = dir.join("work");
    std::fs::create_dir_all(&work).unwrap();

    // Far more than the buffer: (cap + 1) * chunk is ~272 KiB.
    let big = 8 * 1024 * 1024;
    let mut pattern = Vec::with_capacity(big);
    let seed: Vec<u8> = (0..=255).collect();
    while pattern.len() < big {
        pattern.extend_from_slice(&seed);
    }
    pattern.truncate(big);
    std::fs::write(work.join("big.bin"), &pattern).unwrap();

    let mut h = Harness::new(&dir).await;
    let gauge = h.streams.gauge();
    let id = 1u64;
    h.open(
        id,
        StreamKind::File {
            path: "big.bin".into(),
            mode: StreamFileMode::Read,
        },
    )
    .await;

    // Leave the writer undrained: the relay fills the bounded channel, then
    // must stop reading the file. The gauge (bytes read but not yet handed to
    // the writer) stays under one chunk, and the channel holds at most its
    // capacity.
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        gauge.load(Ordering::Relaxed) <= STREAM_CHUNK_BYTES,
        "relay held {} bytes while the channel was full",
        gauge.load(Ordering::Relaxed)
    );

    let mut buffered = 0usize;
    while let Ok(frame) = h.bin_rx.try_recv() {
        buffered += frame.bytes.len();
    }
    assert!(
        buffered <= OUTBOUND_BUFFER_CHUNKS * STREAM_CHUNK_BYTES,
        "channel held {buffered} bytes (capacity {})",
        OUTBOUND_BUFFER_CHUNKS * STREAM_CHUNK_BYTES
    );
    assert!(
        buffered > 0,
        "the relay must have filled the channel before blocking"
    );

    // Now drain fully: the whole file arrives intact, and the relay's own
    // in-flight chunk never exceeds the bound at any sampled instant.
    // `buffered` (the 16 chunks parked in the channel) counts toward the
    // total too.
    let mut received = Vec::with_capacity(pattern.len());
    let mut peak = 0usize;
    loop {
        tokio::select! {
            f = h.bin_rx.recv() => match f {
                Some(f) => {
                    received.extend_from_slice(&f.bytes);
                    peak = peak.max(gauge.load(Ordering::Relaxed));
                }
                None => break,
            },
            _ = tokio::time::sleep(Duration::from_millis(200)) => break,
        }
    }
    assert_eq!(
        received.len() + buffered,
        pattern.len(),
        "received {} bytes of {}",
        received.len() + buffered,
        pattern.len()
    );
    assert_eq!(
        received,
        &pattern[buffered..],
        "backpressured stream must deliver every byte"
    );
    assert!(
        peak <= STREAM_CHUNK_BYTES,
        "peak in-flight bytes {peak} exceeded one chunk"
    );

    std::fs::remove_dir_all(&dir).ok();
}

/// Recursively compare two directory trees (names + file contents).
fn assert_trees_equal(a: &Path, b: &Path) {
    let mut entries: Vec<PathBuf> = std::fs::read_dir(a)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    entries.sort();
    for entry in entries {
        let rel = entry.strip_prefix(a).unwrap();
        let other = b.join(rel);
        if entry.is_dir() {
            assert!(other.is_dir(), "{}: missing directory {rel:?}", b.display());
            assert_trees_equal(&entry, &other);
        } else {
            assert!(other.is_file(), "{}: missing file {rel:?}", b.display());
            assert_eq!(
                std::fs::read(&entry).unwrap(),
                std::fs::read(&other).unwrap(),
                "{rel:?} differs"
            );
        }
    }
}
