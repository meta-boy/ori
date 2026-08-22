//! NDJSON stream consumption for the lifecycle commands. The server flushes
//! one JSON object per line; we render progress as it arrives (or pass lines
//! through verbatim under `--json`).

use futures_util::StreamExt;
use reqwest::Response;

use crate::error::CliError;

/// Read a response body as newline-delimited text, calling `on_line` for each
/// non-empty line as soon as it arrives. The server flushes per line; a
/// buffered response that arrives all at once is a server bug, but the client
/// still renders correctly either way.
pub async fn consume_ndjson(
    res: Response,
    mut on_line: impl FnMut(&str) -> Result<(), CliError>,
) -> Result<(), CliError> {
    let mut stream = res.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| CliError::usage(format!("failed reading stream: {e}")))?;
        for &b in &chunk {
            if b == b'\n' {
                dispatch_line(std::mem::take(&mut buf), &mut on_line)?;
            } else {
                buf.push(b);
            }
        }
    }
    if !buf.is_empty() {
        dispatch_line(buf, &mut on_line)?;
    }
    Ok(())
}

fn dispatch_line(raw: Vec<u8>, on_line: &mut impl FnMut(&str) -> Result<(), CliError>) -> Result<(), CliError> {
    let line = String::from_utf8_lossy(&raw);
    let trimmed = line.trim();
    if !trimmed.is_empty() {
        on_line(trimmed)?;
    }
    Ok(())
}