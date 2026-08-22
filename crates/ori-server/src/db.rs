//! SQLite (WAL) connection and migrations.

use std::path::Path;
use std::str::FromStr;
use std::time::Duration;

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::SqlitePool;

/// Open (creating if needed) the on-disk database and apply migrations.
pub async fn open(path: &Path) -> Result<SqlitePool, sqlx::Error> {
    let opts = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5));
    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(opts)
        .await?;
    migrate(&pool)
        .await
        .map_err(|e| sqlx::Error::Migrate(Box::new(e)))?;
    Ok(pool)
}

/// Single-connection in-memory database for tests. `max_connections(1)` so
/// every query hits the same underlying `:memory:` database.
pub async fn open_in_memory() -> Result<SqlitePool, sqlx::Error> {
    let opts = SqliteConnectOptions::from_str("sqlite::memory:")?
        .journal_mode(SqliteJournalMode::Wal)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5));
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await?;
    migrate(&pool)
        .await
        .map_err(|e| sqlx::Error::Migrate(Box::new(e)))?;
    Ok(pool)
}

/// Embed the migration SQL. Path is relative to this crate's manifest dir;
/// the migration files live at the workspace root.
pub async fn migrate(pool: &SqlitePool) -> Result<(), sqlx::migrate::MigrateError> {
    sqlx::migrate!("../../migrations").run(pool).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn migrates_in_memory() {
        let pool = open_in_memory().await.unwrap();
        // every required table exists
        for table in [
            "sandboxes",
            "api_keys",
            "deletion_operations",
            "snapshots",
            "named_snapshots",
            "environments",
            "environment_versions",
            "environment_vars",
            "environment_files",
            "webhooks",
            "pool_slots",
            "vmid_allocations",
            "processes",
            "device_codes",
        ] {
            let row: (i64,) =
                sqlx::query_as("SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?")
                    .bind(table)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(row.0, 1, "missing table {table}");
        }
    }
}
