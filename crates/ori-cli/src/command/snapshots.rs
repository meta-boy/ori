//! Snapshot commands: `snapshots`, `snapshot <id> <name>`, `snapshot latest`,
//! `snapshot tree`, `snapshot pull`, `snapshot delete`, `snapshot rm`.
//!
//! The one field that predicts fork cost is `takenWhileStopped`: a snapshot
//! taken while the container was running is permanently ~20x more expensive to
//! clone from (docs/BENCHMARKS.md §Root cause). It is rendered on every row and
//! in every detail view, and called out when `no`.

use std::io::{self, Write};

use futures_util::StreamExt;
use ori_proto::{
    SaveSnapshotRequest, SaveSnapshotResponse, Snapshot, SnapshotList, SnapshotTree,
    SnapshotTreeFile,
};
use tokio::io::AsyncWriteExt;

use crate::cli::{SnapshotCommand, SnapshotsArgs};
use crate::context::Ctx;
use crate::error::CliError;

// The names this module already used for the shared shapes.
type SnapshotListResponse = SnapshotList;
type SnapshotTreeResponse = SnapshotTree;
type TreeFile = SnapshotTreeFile;
use crate::render::{print_json, table_string};

// ---------------------------------------------------------------------------
// Wire DTOs (mirror `routes/snapshots.rs`; kept local so this card owns them)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// `ori snapshots [id]`
// ---------------------------------------------------------------------------

pub async fn cmd(args: SnapshotsArgs, ctx: &Ctx) -> Result<(), CliError> {
    let mut all = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let mut query = Vec::new();
        if let Some(id) = &args.id {
            query.push(format!("sandboxId={id}"));
        }
        if args.all {
            query.push("all=true".to_string());
        }
        if let Some(l) = args.limit {
            query.push(format!("limit={l}"));
        }
        if let Some(c) = &cursor {
            query.push(format!("cursor={c}"));
        }
        let qs = if query.is_empty() {
            String::new()
        } else {
            format!("?{}", query.join("&"))
        };
        let page: SnapshotListResponse = ctx.api.get_json(&format!("/snapshots{qs}")).await?;
        let has_more = page.page_info.has_more;
        all.extend(page.snapshots);
        cursor = page.page_info.next_cursor;
        if !has_more || cursor.is_none() {
            break;
        }
    }

    if ctx.json {
        print_json(&serde_json::json!({
            "snapshots": all,
            "pageInfo": { "hasMore": false, "limit": null, "nextCursor": null },
        }))?;
    } else {
        render_table(&all);
        if all.iter().any(|s| !s.taken_while_stopped) {
            eprintln!(
                "note: snapshots taken while the container was running (TAKEN `running`) are \
                 ~20x more expensive to fork from; stop the sandbox first for a fast one"
            );
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// `ori snapshot <id> <name>` — save under a name
// ---------------------------------------------------------------------------

pub async fn save(id: &str, name: &str, ctx: &Ctx) -> Result<(), CliError> {
    let res: SaveSnapshotResponse = ctx
        .api
        .post_json(
            "/snapshots",
            &SaveSnapshotRequest {
                sandbox_id: id.to_string(),
                name: name.to_string(),
            },
        )
        .await?;
    if ctx.json {
        print_json(&res)?;
    } else {
        if res.snapshot.taken_while_stopped {
            println!(
                "saved {} as `{}` (taken while stopped: yes)",
                res.snapshot.id, res.named.name
            );
        } else {
            println!(
                "saved {} as `{}` (taken while stopped: no)",
                res.snapshot.id, res.named.name
            );
            eprintln!(
                "note: a snapshot taken while running is ~20x more expensive to fork from; \
                 stop the sandbox first (`ori stop {id}`) for a fast one"
            );
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// `ori snapshot latest <id>`
// ---------------------------------------------------------------------------

pub async fn latest(id: &str, ctx: &Ctx) -> Result<(), CliError> {
    let page: SnapshotListResponse = ctx
        .api
        .get_json(&format!("/snapshots?sandboxId={id}&limit=1"))
        .await?;
    let snap = page.snapshots.into_iter().next().ok_or_else(|| {
        CliError::usage(format!(
            "no snapshots for sandbox {id}; stop it (`ori stop {id}`) or save one"
        ))
    })?;
    if ctx.json {
        print_json(&snap)?;
    } else {
        render_info(&snap);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// `ori snapshot tree <snap>`
// ---------------------------------------------------------------------------

pub async fn tree(snap_id: &str, ctx: &Ctx) -> Result<(), CliError> {
    let res: SnapshotTreeResponse = ctx
        .api
        .get_json(&format!("/snapshots/{snap_id}/tree"))
        .await?;
    if ctx.json {
        print_json(&res)?;
    } else {
        render_tree(&res.files);
        eprintln!(
            "note: the tree reflects the sandbox's live work dir (a snapshot is not a mounted \
             filesystem); a running sandbox may include writes made after the snapshot"
        );
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// `ori snapshot pull <snap> [-o <dir>]` — stream, never buffer
// ---------------------------------------------------------------------------

pub async fn pull(snap_id: &str, output: Option<&str>, ctx: &Ctx) -> Result<(), CliError> {
    let res = ctx.api.get(&format!("/snapshots/{snap_id}/pull")).await?;
    let out_dir = output.unwrap_or(".");
    std::fs::create_dir_all(out_dir)
        .map_err(|e| CliError::usage(format!("cannot create output directory {out_dir}: {e}")))?;

    // The agent tars the work dir (`tar -cf - -C <dir> .`); reassemble locally
    // by streaming the body straight into `tar -xf -`. Never buffered on the
    // client either.
    let mut child = tokio::process::Command::new("tar")
        .args(["-xf", "-", "-C"])
        .arg(out_dir)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| CliError::usage(format!("cannot run `tar` to extract: {e}")))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| CliError::usage("cannot open tar stdin"))?;
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|e| CliError::usage(format!("failed reading pull stream: {e}")))?;
        stdin.write_all(&chunk).await?;
    }
    // Closing stdin sends EOF to tar, which then finishes extraction.
    drop(stdin);
    let out = child
        .wait_with_output()
        .await
        .map_err(|e| CliError::usage(format!("tar extraction failed: {e}")))?;
    if !out.status.success() {
        return Err(CliError::usage(format!(
            "tar extraction failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    if ctx.json {
        print_json(&serde_json::json!({
            "snapshotId": snap_id,
            "output": out_dir,
        }))?;
    } else {
        println!("pulled {snap_id} into {out_dir}");
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// `ori snapshot delete <snap>` / `ori snapshot rm <name>`
// ---------------------------------------------------------------------------

pub async fn delete(snap_id: &str, yes: bool, ctx: &Ctx) -> Result<(), CliError> {
    if !yes {
        eprint!("Permanently delete snapshot {snap_id}? This cannot be undone. [y/N] ");
        io::stderr().flush().ok();
        let mut line = String::new();
        io::stdin().read_line(&mut line).map_err(CliError::from)?;
        match line.trim().to_lowercase().as_str() {
            "y" | "yes" => {}
            _ => {
                println!("aborted");
                return Err(CliError::usage("aborted"));
            }
        }
    }
    let res = ctx.api.delete(&format!("/snapshots/{snap_id}")).await?;
    let text = res.text().await.map_err(CliError::from)?;
    if ctx.json {
        println!("{text}");
    } else {
        println!("deleted snapshot {snap_id}");
    }
    Ok(())
}

pub async fn rm(name: &str, ctx: &Ctx) -> Result<(), CliError> {
    let res = ctx
        .api
        .delete(&format!("/named-snapshots/{}", name))
        .await?;
    let text = res.text().await.map_err(CliError::from)?;
    if ctx.json {
        println!("{text}");
    } else {
        println!("removed named snapshot `{name}`");
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

pub async fn snapshot(sub: &SnapshotCommand, ctx: &Ctx) -> Result<(), CliError> {
    match sub {
        SnapshotCommand::Save { id, name } => save(id, name, ctx).await,
        SnapshotCommand::Latest { id } => latest(id, ctx).await,
        SnapshotCommand::Tree { snap_id } => tree(snap_id, ctx).await,
        SnapshotCommand::Pull { snap_id, output } => pull(snap_id, output.as_deref(), ctx).await,
        SnapshotCommand::Delete { snap_id, yes } => delete(snap_id, *yes, ctx).await,
        SnapshotCommand::Rm { name } => rm(name, ctx).await,
    }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

fn render_table(snaps: &[Snapshot]) {
    let header = ["ID", "SANDBOX", "NAME", "STATE", "TAKEN", "CREATED"]
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>();
    let rows: Vec<Vec<String>> = snaps
        .iter()
        .map(|s| {
            vec![
                s.id.clone(),
                s.sandbox_id.clone(),
                s.name.clone().unwrap_or_default(),
                s.state.clone(),
                if s.taken_while_stopped {
                    "stopped".to_string()
                } else {
                    "running".to_string()
                },
                s.created_at.clone(),
            ]
        })
        .collect();
    print!("{}", table_string(&header, &rows));
}

fn render_info(s: &Snapshot) {
    let rows = [
        ("id", s.id.clone()),
        ("sandboxId", s.sandbox_id.clone()),
        ("name", s.name.clone().unwrap_or_else(|| "-".to_string())),
        ("state", s.state.clone()),
        ("providerSnapshot", s.provider_snapshot.clone()),
        (
            "takenWhileStopped",
            if s.taken_while_stopped {
                "yes".to_string()
            } else {
                "no".to_string()
            },
        ),
        (
            "isIncremental",
            if s.is_incremental { "yes" } else { "no" }.to_string(),
        ),
        (
            "parentId",
            s.parent_id.clone().unwrap_or_else(|| "-".to_string()),
        ),
        ("createdAt", s.created_at.clone()),
    ];
    let w = rows.iter().map(|(k, _)| k.len()).max().unwrap_or(0);
    for (k, v) in rows {
        println!("{:<w$}  {v}", k, w = w);
    }
}

fn render_tree(files: &[TreeFile]) {
    let header = ["PATH", "SIZE"]
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>();
    let rows: Vec<Vec<String>> = files
        .iter()
        .map(|f| vec![f.path.clone(), human_size(f.size)])
        .collect();
    print!("{}", table_string(&header, &rows));
}

fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut v = bytes as f64;
    let mut unit = 0;
    while v >= 1024.0 && unit < UNITS.len() - 1 {
        v /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{v:.1} {}", UNITS[unit])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn human_size_formats() {
        assert_eq!(human_size(0), "0 B");
        assert_eq!(human_size(512), "512 B");
        assert_eq!(human_size(1024), "1.0 KiB");
        assert_eq!(human_size(5 * 1024 * 1024), "5.0 MiB");
        assert_eq!(human_size(3 * 1024 * 1024 * 1024), "3.0 GiB");
    }
}
