//! TCP and file byte streams (`plans/C13-agent-streams.md`).
//!
//! The control plane opens a stream with a `streamOpen` JSON frame; the agent
//! dials `127.0.0.1:<port>` (the primitive behind `ori forward` and the SSH
//! splice) or reads/writes a path rooted at the sandbox work dir. Data flows
//! as binary `streamData` frames; either side closes with `streamClose`.
//!
//! ## Backpressure
//!
//! Every stream buffer is bounded, because an unbounded one kills the agent and
//! takes every other stream on that tunnel with it:
//!
//! - **Outbound (agent→plane)** chunks flow through one shared bounded channel
//!   drained by the tunnel writer. A relay blocks on `send` when it is full,
//!   which stops it reading the source — a 20 GiB file never occupies more than
//!   `(OUTBOUND_BUFFER_CHUNKS + 1) * STREAM_CHUNK_BYTES` of agent memory.
//! - **Inbound (plane→agent)** data is buffered per stream in a bounded
//!   channel; when it fills, the tunnel stops reading the socket, applying
//!   backpressure to the plane.
//!
//! The [`Streams::gauge`] counter tracks bytes read from sources but not yet
//! handed to the writer, so the bounded-memory property is directly observable
//! in tests (see `tests/streams.rs`).
//!
//! Each stream runs as its own task, so a wedged socket or slow file cannot
//! head-of-line-block another stream's relay; the only shared point is the
//! single WebSocket writer, which is the tunnel's bottleneck by definition.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::process::Command;
use tokio::sync::mpsc;

use crate::wire::{
    Outgoing, StreamDataFrame, StreamFileMode, StreamId, StreamKind, STREAM_CLOSE_IO,
    STREAM_CLOSE_OK, STREAM_CLOSE_REFUSED, STREAM_CLOSE_REJECTED,
};

/// Chunk size for every stream read. 16 KiB keeps per-chunk allocation
/// overhead low relative to the number of in-flight chunks.
pub const STREAM_CHUNK_BYTES: usize = 16 * 1024;

/// Capacity of the shared outbound binary channel, in chunks. This is the
/// agent-side bound on stream data: the writer can be at most this far behind
/// the sources before the relays stop reading.
pub const OUTBOUND_BUFFER_CHUNKS: usize = 16;

/// Capacity of a single stream's inbound buffer (plane→agent), in chunks.
pub const STREAM_INBOUND_CHUNKS: usize = 4;

/// Upper bound on wall-clock time spent waiting for a `tar` subprocess to
/// exit. A hostile or malformed tar stream must not be able to wedge a stream
/// task forever.
const TAR_WAIT_TIMEOUT: Duration = Duration::from_secs(10);

/// How a relay loop ended.
enum End {
    /// Source hit EOF, or all inbound data was written — clean.
    Eof,
    /// The control plane closed the stream.
    PlaneClosed,
    /// A socket/file I/O error mid-stream.
    Io,
    /// The tunnel itself went away; stop immediately and send nothing.
    Gone,
}

impl End {
    fn code(&self) -> u16 {
        match self {
            End::Eof | End::PlaneClosed => STREAM_CLOSE_OK,
            End::Io => STREAM_CLOSE_IO,
            End::Gone => STREAM_CLOSE_OK,
        }
    }
}

/// Per-connection stream state: the shared outbound binary sender, the inbound
/// routing table, and the backpressure gauge. Cloneable so spawned handler
/// tasks share one registry; the mutex is held only for map lookups and
/// inserts, never across an await.
#[derive(Clone)]
pub struct Streams {
    out: mpsc::Sender<StreamDataFrame>,
    inbound: Arc<Mutex<HashMap<StreamId, mpsc::Sender<Vec<u8>>>>>,
    gauge: Arc<AtomicUsize>,
}

impl Streams {
    pub fn new(out: mpsc::Sender<StreamDataFrame>) -> Self {
        Self {
            out,
            inbound: Arc::new(Mutex::new(HashMap::new())),
            gauge: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// Bytes read from stream sources but not yet handed to the WebSocket
    /// writer. Upper-bounded by the buffer sizes; the backpressure test asserts
    /// this to prove memory stays bounded under a push larger than the buffer.
    pub fn gauge(&self) -> Arc<AtomicUsize> {
        self.gauge.clone()
    }

    /// Open a stream: validate, register the inbound buffer, and spawn the
    /// relay task. Invalid opens (path traversal, malformed shape) reply with a
    /// `streamClose` carrying a non-zero code and register nothing.
    pub async fn open(
        &self,
        id: StreamId,
        kind: &StreamKind,
        work_dir: &Path,
        json: mpsc::Sender<Outgoing>,
    ) {
        match kind {
            StreamKind::Tcp { port } => {
                let (tx, rx) = mpsc::channel(STREAM_INBOUND_CHUNKS);
                self.inbound.lock().unwrap().insert(id, tx);
                tokio::spawn(tcp_relay(
                    id,
                    *port,
                    rx,
                    RelayCtx {
                        out: self.out.clone(),
                        json: json.clone(),
                        gauge: self.gauge.clone(),
                    },
                ));
            }
            StreamKind::File { path, mode } => {
                match resolve_under_workdir(work_dir, path) {
                    Ok(rooted) => {
                        let is_dir = match *mode {
                            StreamFileMode::Read => rooted.is_dir(),
                            // A trailing slash, or an existing directory, says
                            // "extract a tar here"; anything else is a raw file.
                            StreamFileMode::Write => path.ends_with('/') || rooted.is_dir(),
                        };
                        let (tx, rx) = mpsc::channel(STREAM_INBOUND_CHUNKS);
                        self.inbound.lock().unwrap().insert(id, tx);
                        tokio::spawn(file_relay(
                            id,
                            rooted,
                            *mode,
                            is_dir,
                            rx,
                            RelayCtx {
                                out: self.out.clone(),
                                json: json.clone(),
                                gauge: self.gauge.clone(),
                            },
                        ));
                    }
                    Err(()) => {
                        let _ = json
                            .send(Outgoing::StreamClose {
                                id,
                                code: STREAM_CLOSE_REJECTED,
                            })
                            .await;
                    }
                }
            }
        }
    }

    /// Route an inbound `streamData` chunk to its stream's relay. The bounded
    /// per-stream channel provides backpressure: once full, `send` blocks,
    /// which stops the tunnel reading the socket until the stream drains.
    /// Frames for a closed or unknown stream are dropped (and a stale entry
    /// cleaned up) rather than buffered.
    pub async fn route_data(&self, id: StreamId, bytes: Vec<u8>) {
        let tx = match self.inbound.lock().unwrap().get(&id) {
            Some(tx) => tx.clone(),
            None => {
                eprintln!("ori agent: streamData for unknown stream {id}");
                return;
            }
        };
        match tx.try_send(bytes) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Closed(_)) => {
                self.inbound.lock().unwrap().remove(&id);
            }
            Err(mpsc::error::TrySendError::Full(bytes)) => {
                if tx.send(bytes).await.is_err() {
                    self.inbound.lock().unwrap().remove(&id);
                }
            }
        }
    }

    /// Forget a stream (control-plane `streamClose`). Dropping the sender tells
    /// the relay its inbound channel is gone; it tears down and acks.
    pub fn close(&self, id: StreamId) {
        self.inbound.lock().unwrap().remove(&id);
    }
}

/// Shared channels every relay hands data to: the outbound binary channel
/// (drained by the tunnel writer), the JSON channel (terminal `streamClose`),
/// and the backpressure gauge.
#[derive(Clone)]
struct RelayCtx {
    out: mpsc::Sender<StreamDataFrame>,
    json: mpsc::Sender<Outgoing>,
    gauge: Arc<AtomicUsize>,
}

/// Full-duplex TCP relay: one stream per connection, dialing
/// `127.0.0.1:<port>`. Reads push outbound chunks under backpressure; inbound
/// chunks are written to the socket. Ends cleanly on EOF, plane close, I/O
/// error, or tunnel loss.
async fn tcp_relay(id: StreamId, port: u16, mut rx: mpsc::Receiver<Vec<u8>>, ctx: RelayCtx) {
    let tcp = match TcpStream::connect(("127.0.0.1", port)).await {
        Ok(t) => t,
        Err(_) => {
            let _ = ctx
                .json
                .send(Outgoing::StreamClose {
                    id,
                    code: STREAM_CLOSE_REFUSED,
                })
                .await;
            return;
        }
    };
    let (mut rd, mut wr) = tcp.into_split();
    let mut buf = [0u8; STREAM_CHUNK_BYTES];
    let end = loop {
        tokio::select! {
            n = rd.read(&mut buf) => {
                match n {
                    Ok(0) => break End::Eof,
                    Ok(n) => {
                        ctx.gauge.fetch_add(n, Ordering::Relaxed);
                        let sent = ctx
                            .out
                            .send(StreamDataFrame { id, bytes: buf[..n].to_vec() })
                            .await;
                        ctx.gauge.fetch_sub(n, Ordering::Relaxed);
                        if sent.is_err() {
                            break End::Gone;
                        }
                    }
                    Err(_) => break End::Io,
                }
            }
            data = rx.recv() => {
                match data {
                    Some(bytes) => {
                        if wr.write_all(&bytes).await.is_err() {
                            break End::Io;
                        }
                    }
                    None => break End::PlaneClosed,
                }
            }
        }
    };
    finish(id, end, ctx).await;
}

/// Stream a read-only source (file, or `tar` stdout) outbound. Stops on EOF,
/// plane close, I/O error, or tunnel loss.
async fn pump_read<R: AsyncRead + Unpin>(
    mut rd: R,
    id: StreamId,
    mut rx: mpsc::Receiver<Vec<u8>>,
    ctx: RelayCtx,
) -> End {
    let mut buf = [0u8; STREAM_CHUNK_BYTES];
    loop {
        tokio::select! {
            data = rx.recv() => {
                match data {
                    // Data on a read-only stream is a protocol slip; ignore it
                    // and keep streaming.
                    Some(_) => {}
                    None => break End::PlaneClosed,
                }
            }
            n = rd.read(&mut buf) => {
                let n = match n {
                    Ok(0) => break End::Eof,
                    Ok(n) => n,
                    Err(_) => break End::Io,
                };
                ctx.gauge.fetch_add(n, Ordering::Relaxed);
                let sent = ctx
                    .out
                    .send(StreamDataFrame { id, bytes: buf[..n].to_vec() })
                    .await;
                ctx.gauge.fetch_sub(n, Ordering::Relaxed);
                if sent.is_err() {
                    return End::Gone;
                }
            }
        }
    }
}

/// Dispatch a file stream: `File{path}` raw, directories tarred.
async fn file_relay(
    id: StreamId,
    path: PathBuf,
    mode: StreamFileMode,
    is_dir: bool,
    rx: mpsc::Receiver<Vec<u8>>,
    ctx: RelayCtx,
) {
    let end = match mode {
        StreamFileMode::Read => {
            if is_dir {
                tar_read(id, path, rx, ctx.clone()).await
            } else {
                match tokio::fs::File::open(&path).await {
                    Ok(f) => pump_read(f, id, rx, ctx.clone()).await,
                    Err(_) => End::Io,
                }
            }
        }
        StreamFileMode::Write => {
            if is_dir {
                tar_write(path, rx).await
            } else {
                file_write(path, rx).await
            }
        }
    };
    finish(id, end, ctx).await;
}

/// Write inbound chunks to a file, creating parent directories. A clean end
/// means every inbound byte was flushed.
async fn file_write(path: PathBuf, mut rx: mpsc::Receiver<Vec<u8>>) -> End {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && tokio::fs::create_dir_all(parent).await.is_err() {
            return End::Io;
        }
    }
    let mut f = match tokio::fs::File::create(&path).await {
        Ok(f) => f,
        Err(_) => return End::Io,
    };
    while let Some(bytes) = rx.recv().await {
        if f.write_all(&bytes).await.is_err() {
            return End::Io;
        }
    }
    if f.flush().await.is_err() {
        return End::Io;
    }
    End::Eof
}

/// Stream a directory as a tar (`tar -cf - -C <dir> .`). A non-zero tar exit
/// after a clean EOF — e.g. an unreadable entry — is surfaced as I/O.
async fn tar_read(id: StreamId, dir: PathBuf, rx: mpsc::Receiver<Vec<u8>>, ctx: RelayCtx) -> End {
    let mut child = match Command::new("tar")
        .args(["-cf", "-", "-C"])
        .arg(&dir)
        .arg(".")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return End::Io,
    };
    let stdout = child.stdout.take().expect("piped stdout");
    match pump_read(stdout, id, rx, ctx).await {
        End::Eof => match wait_or_kill(child).await {
            Some(status) if status.success() => End::Eof,
            _ => End::Io,
        },
        other => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            other
        }
    }
}

/// Extract a tar stream into a directory (`mkdir -p <dir>` then
/// `tar -xf - -C <dir>`).
async fn tar_write(dir: PathBuf, mut rx: mpsc::Receiver<Vec<u8>>) -> End {
    if tokio::fs::create_dir_all(&dir).await.is_err() {
        return End::Io;
    }
    let mut child = match Command::new("tar")
        .args(["-xf", "-", "-C"])
        .arg(&dir)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return End::Io,
    };
    let mut stdin = child.stdin.take().expect("piped stdin");
    let mut io = false;
    while let Some(bytes) = rx.recv().await {
        if stdin.write_all(&bytes).await.is_err() {
            io = true;
            break;
        }
    }
    // Dropping stdin sends EOF to tar; then wait for it to finish extracting.
    drop(stdin);
    let ok = matches!(wait_or_kill(child).await, Some(s) if s.success());
    if io || !ok {
        End::Io
    } else {
        End::Eof
    }
}

/// Send the terminal `streamClose` for an ended relay, unless the tunnel
/// itself went away (then there is nobody to tell).
async fn finish(id: StreamId, end: End, ctx: RelayCtx) {
    if matches!(end, End::Gone) {
        return;
    }
    let _ = ctx
        .json
        .send(Outgoing::StreamClose {
            id,
            code: end.code(),
        })
        .await;
}

async fn wait_or_kill(mut child: tokio::process::Child) -> Option<std::process::ExitStatus> {
    match tokio::time::timeout(TAR_WAIT_TIMEOUT, child.wait()).await {
        Ok(res) => res.ok(),
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            None
        }
    }
}

/// Resolve a stream path relative to the sandbox work dir, rejecting escape.
/// Rejects absolute paths, `..` components, and anything whose existing
/// ancestor (symlinks resolved) lands outside the canonical work dir.
fn resolve_under_workdir(work_dir: &Path, rel: &str) -> Result<PathBuf, ()> {
    let p = Path::new(rel);
    if p.is_absolute() {
        return Err(());
    }
    for c in p.components() {
        if matches!(c, Component::ParentDir) {
            return Err(());
        }
    }
    let _ = std::fs::create_dir_all(work_dir);
    let canon_work = std::fs::canonicalize(work_dir).map_err(|_| ())?;
    let rooted = work_dir.join(p);
    let existing = canonicalize_existing(&rooted).map_err(|_| ())?;
    if !existing.starts_with(&canon_work) {
        return Err(());
    }
    Ok(rooted)
}

/// Canonicalize `path` itself, or its nearest existing ancestor when `path`
/// does not exist yet. Symlinks along the way are resolved.
fn canonicalize_existing(path: &Path) -> std::io::Result<PathBuf> {
    let mut p = path;
    loop {
        match std::fs::canonicalize(p) {
            Ok(c) => return Ok(c),
            Err(_) => match p.parent() {
                Some(parent) if parent != p => p = parent,
                _ => {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::NotFound,
                        "no existing ancestor",
                    ))
                }
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_paths_under_the_work_dir() {
        let dir = std::env::temp_dir().join(format!("ori-agent-streams-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        assert_eq!(resolve_under_workdir(&dir, "sub"), Ok(dir.join("sub")));
        assert_eq!(resolve_under_workdir(&dir, "a/b/c"), Ok(dir.join("a/b/c")));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_escape_paths() {
        let dir =
            std::env::temp_dir().join(format!("ori-agent-streams-bad-{}", std::process::id()));
        let work = dir.join("work");
        std::fs::create_dir_all(&work).unwrap();
        assert!(resolve_under_workdir(&work, "..").is_err());
        assert!(resolve_under_workdir(&work, "../secret").is_err());
        assert!(resolve_under_workdir(&work, "a/../../secret").is_err());
        assert!(resolve_under_workdir(&work, "/etc/passwd").is_err());

        // A symlink escaping the work dir is caught by canonicalization.
        #[cfg(unix)]
        {
            let outside = dir.join("outside-target");
            std::fs::write(&outside, "s3cr3t").unwrap();
            std::os::unix::fs::symlink(&outside, work.join("evil")).unwrap();
            assert!(resolve_under_workdir(&work, "evil").is_err());
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn gauge_starts_at_zero() {
        let (out, _rx) = mpsc::channel::<StreamDataFrame>(4);
        let streams = Streams::new(out);
        assert_eq!(streams.gauge().load(Ordering::Relaxed), 0);
    }
}
