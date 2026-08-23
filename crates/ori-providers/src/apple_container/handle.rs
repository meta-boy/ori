//! Apple container handles are container ids (the `--name` value); both are
//! opaque to the server, so the provider defines the encoding.
//!
//! The `container` CLI's id rule (from its `ManagedContainer.nameValid`):
//! `^[a-zA-Z0-9][a-zA-Z0-9_.-]+$`, max 63 chars — a leading alphanumeric and at
//! least two characters. Caller-allocated instance ids are not guaranteed to
//! match, so the id is sanitized deterministically and the handle id
//! round-trips through the server.

use crate::reconcile::{InstanceHandle, SnapshotRef};

use super::error::AppleError;

/// Fixed prefix on every ori container id, matching docker's `ori-`.
pub const CONTAINER_PREFIX: &str = "ori-";

/// Max container id length (the CLI enforces 63; stay under it).
const ID_MAX: usize = 63;

/// Sanitize a caller-allocated instance id into a valid `container` id.
pub fn container_id_for(id: &str) -> String {
    let mut out = String::with_capacity(id.len().min(ID_MAX));
    for c in id.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.') {
            out.push(c);
        } else {
            out.push('-');
        }
        if out.len() == ID_MAX {
            break;
        }
    }
    if out.is_empty() {
        out.push('c');
    }
    if !out.as_bytes()[0].is_ascii_alphanumeric() {
        out.insert(0, 'c');
    }
    // The CLI needs at least two characters; the prefix guarantees it, but
    // keep the guarantee explicit for a truncated id.
    if out.len() < 2 {
        out.push('x');
    }
    if out.len() > ID_MAX {
        out.truncate(ID_MAX);
    }
    format!("{CONTAINER_PREFIX}{out}")
}

pub fn handle_for(id: &str) -> InstanceHandle {
    InstanceHandle {
        provider: "apple-container".to_string(),
        id: container_id_for(id),
    }
}

/// Parse an `InstanceHandle` created by this provider into the container id.
pub fn parse_handle(h: &InstanceHandle) -> Result<String, AppleError> {
    if h.provider != "apple-container" {
        return Err(AppleError::WrongProvider(h.provider.clone()));
    }
    if h.id.is_empty() {
        return Err(AppleError::MalformedHandle(h.id.clone()));
    }
    Ok(h.id.clone())
}

/// Parse a `SnapshotRef` created by this provider. No snapshot primitive
/// exists, so this only exists to fail loudly and honestly.
pub fn parse_snapshot_ref(s: &SnapshotRef) -> Result<(), AppleError> {
    if s.provider != "apple-container" {
        return Err(AppleError::WrongProvider(s.provider.clone()));
    }
    Err(AppleError::Other(format!(
        "apple-container has no snapshot primitive; snapshot ref {:?} cannot exist",
        s.id
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn container_id_sanitizes() {
        assert_eq!(container_id_for("sandbox_1"), "ori-sandbox_1");
        assert_eq!(container_id_for("mock:1"), "ori-mock-1");
        assert_eq!(container_id_for("a/b c"), "ori-a-b-c");
    }

    #[test]
    fn container_id_prefixes_non_alphanumeric_leading_char() {
        assert_eq!(container_id_for(":leading"), "ori-c-leading");
        // Empty input still yields a valid (≥2 char) id.
        assert_eq!(container_id_for(""), "ori-cx");
    }

    #[test]
    fn container_id_is_stable_under_63_chars() {
        let id = "x".repeat(200);
        let out = container_id_for(&id);
        assert!(out.len() <= ID_MAX + CONTAINER_PREFIX.len());
        assert!(out.starts_with(CONTAINER_PREFIX));
        // Must satisfy the CLI's `^[a-zA-Z0-9][a-zA-Z0-9_.-]+$` rule.
        assert!(out.chars().next().unwrap().is_ascii_alphanumeric());
        assert!(out.len() >= 2);
        assert!(out
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')));
    }

    #[test]
    fn handle_round_trips() {
        let h = handle_for("sandbox_1");
        assert_eq!(parse_handle(&h).unwrap(), "ori-sandbox_1");
        assert!(matches!(
            parse_handle(&InstanceHandle {
                provider: "proxmox".to_string(),
                id: "ori-x".to_string(),
            }),
            Err(AppleError::WrongProvider(_))
        ));
        assert!(matches!(
            parse_handle(&InstanceHandle {
                provider: "apple-container".to_string(),
                id: String::new(),
            }),
            Err(AppleError::MalformedHandle(_))
        ));
    }

    #[test]
    fn snapshot_ref_parse_fails_loudly() {
        let s = SnapshotRef {
            provider: "apple-container".to_string(),
            id: "x".to_string(),
            name: "x".to_string(),
        };
        assert!(matches!(parse_snapshot_ref(&s), Err(AppleError::Other(_))));
        let wrong = SnapshotRef {
            provider: "docker".to_string(),
            ..s
        };
        assert!(matches!(
            parse_snapshot_ref(&wrong),
            Err(AppleError::WrongProvider(_))
        ));
    }
}
