//! Linux `/proc/net/tcp[6]` parsing — how the agent tells a `127.0.0.1`-bound
//! service from a `0.0.0.0`-bound one, which is the difference between an
//! `ori host` URL that works and one that 404s.
//!
//! The pure parsing/classification functions are platform-independent so they
//! are unit-testable on any host; only the filesystem reader is gated to Linux.

use crate::error::AgentError;

/// How a listener is bound.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BindKind {
    /// `0.0.0.0` / `::` — reachable through the public URL.
    Wildcard,
    /// `127.0.0.1` / `::1` — NOT reachable through the public URL.
    Loopback,
    /// A specific non-loopback interface.
    Specific,
}

/// A listening TCP socket observed in `/proc/net/tcp`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListenEntry {
    pub kind: BindKind,
    pub port: u16,
}

const TCP_LISTEN_STATE: &str = "0A";

/// Classify a little-endian hex local address from `/proc/net/tcp[6]`.
pub fn classify_hex(hex: &str) -> BindKind {
    match hex {
        // 0.0.0.0 and ::
        "00000000" | "00000000000000000000000000000000" => BindKind::Wildcard,
        // 127.0.0.1 and ::1 (little-endian byte order in procfs)
        "0100007F" | "00000000000000000000000001000000" => BindKind::Loopback,
        _ => BindKind::Specific,
    }
}

/// Parse one `/proc/net/tcp[6]` line. Returns `None` for non-LISTEN lines.
///
/// Format: `sl  local_address rem_address st tx...` where `local_address` is
/// `HEXIP:HEXPORT` (little-endian) and `st` is the hex socket state
/// (`0A` = LISTEN).
pub fn parse_tcp_line(line: &str) -> Option<ListenEntry> {
    let mut fields = line.split_whitespace();
    // field 0: sl; field 1: local_address; field 2: rem_address; field 3: st
    fields.next()?;
    let local = fields.next()?;
    let _rem = fields.next()?;
    let state = fields.next()?;

    if state != TCP_LISTEN_STATE {
        return None;
    }

    let (ip_hex, port_hex) = local.split_once(':')?;
    let port = u16::from_str_radix(port_hex, 16).ok()?;
    Some(ListenEntry {
        kind: classify_hex(ip_hex),
        port,
    })
}

/// Read all LISTEN sockets on `port` from `/proc/net/tcp` and `/proc/net/tcp6`.
#[cfg(target_os = "linux")]
pub fn listening_on_port(port: u16) -> Result<Vec<ListenEntry>, AgentError> {
    let mut out = Vec::new();
    for path in ["/proc/net/tcp", "/proc/net/tcp6"] {
        let raw = std::fs::read_to_string(path).map_err(|e| {
            AgentError::Other(format!("cannot read {path}: {e}"))
        })?;
        for line in raw.lines().skip(1) {
            if let Some(entry) = parse_tcp_line(line) {
                if entry.port == port {
                    out.push(entry);
                }
            }
        }
    }
    Ok(out)
}

/// Non-Linux stub so the crate still compiles and `host::probe` degrades to the
/// loopback-connect fallback.
#[cfg(not(target_os = "linux"))]
pub fn listening_on_port(_port: u16) -> Result<Vec<ListenEntry>, AgentError> {
    Err(AgentError::Other(
        "procfs is not available on this platform".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const TCP4: &str = "0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 597156 1 0000000000000000 100 0 0 10 0";
    const TCP4_WILDCARD: &str = "1: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 597157 1 0000000000000000 100 0 0 10 0";
    const TCP4_NONLISTEN: &str = "2: 0100007F:1F90 0100007F:C350 01 00000000:00000000 02:00000000 00000000     0        0 597158 1 0000000000000000 20 4 1 10 -1";
    const TCP6_LOOPBACK: &str = "0: 00000000000000000000000001000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 597159 1 0000000000000000 100 0 0 10 0";
    const TCP6_WILDCARD: &str = "1: 00000000000000000000000000000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 597160 1 0000000000000000 100 0 0 10 0";

    #[test]
    fn classifies_bind_addresses() {
        assert_eq!(classify_hex("00000000"), BindKind::Wildcard);
        assert_eq!(classify_hex("0100007F"), BindKind::Loopback);
        assert_eq!(classify_hex("0A000001"), BindKind::Specific); // 10.0.0.1
        assert_eq!(
            classify_hex("00000000000000000000000001000000"),
            BindKind::Loopback
        );
        assert_eq!(
            classify_hex("00000000000000000000000000000000"),
            BindKind::Wildcard
        );
    }

    #[test]
    fn parses_listen_lines_and_ports() {
        let e = parse_tcp_line(TCP4).unwrap();
        assert_eq!(e.kind, BindKind::Loopback);
        assert_eq!(e.port, 8080);

        let e = parse_tcp_line(TCP4_WILDCARD).unwrap();
        assert_eq!(e.kind, BindKind::Wildcard);
        assert_eq!(e.port, 8080);

        let e = parse_tcp_line(TCP6_LOOPBACK).unwrap();
        assert_eq!(e.kind, BindKind::Loopback);
        assert_eq!(e.port, 8080);

        let e = parse_tcp_line(TCP6_WILDCARD).unwrap();
        assert_eq!(e.kind, BindKind::Wildcard);
        assert_eq!(e.port, 8080);
    }

    #[test]
    fn ignores_non_listen_lines_and_header() {
        assert!(parse_tcp_line(TCP4_NONLISTEN).is_none());
        assert!(parse_tcp_line("  sl  local_address rem_address   st").is_none());
        assert!(parse_tcp_line("").is_none());
        // Different port is ignored by the port filter.
        let entries = parse_tcp_line(TCP4_WILDCARD).unwrap();
        assert_ne!(entries.port, 3000);
    }
}