//! Small shared helpers.

use chrono::{SecondsFormat, Utc};

/// Normalised RFC3339 timestamp with second precision and a `Z` suffix, so
/// stored timestamps compare lexicographically (used by the TTL reaper's
/// `stop_after <= ?` query).
pub fn now_ts() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// Timestamp `secs` seconds from now, same normalised format.
pub fn after_seconds(secs: i64) -> String {
    (Utc::now() + chrono::Duration::seconds(secs)).to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// Parse a normalised RFC3339 timestamp.
pub fn parse_ts(s: &str) -> Option<chrono::DateTime<Utc>> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

/// Default timestamped name for a sandbox.
pub fn default_name() -> String {
    Utc::now().format("sandbox-%Y%m%d-%H%M%S").to_string()
}
