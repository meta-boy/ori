//! NDJSON stream consumption for the lifecycle commands. The server flushes
//! one JSON object per line; we render progress as it arrives (or pass lines
//! through verbatim under `--json`).

use std::io;

use futures_util::io::{AsyncBufReadExt, BufReader, StreamReader};
use futures_util::StreamExt;
use reqwest::Response;

use crate::error::CliError;

pub async fn consume_ndjson(
    res: Response,
    mut on_line: impl FnMut(&str) -> Result<(), CliError>,
) -> Result<(), CliError> {
    let stream = res.bytes_stream().map(|r| r.map_err(io::Error::other));
    let mut lines = BufReader::new(StreamReader::new(stream)).lines();
    while let Some(line) = lines.next().await {
        let line =
            line.map_err(|e| CliError::usage(format!("failed reading response stream: {e}")))?;
        if line.trim().is_empty() {
            continue;
        }
        on_line(line.trim())?;
    }
    Ok(())
}