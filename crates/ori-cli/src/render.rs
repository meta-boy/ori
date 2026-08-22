//! Human and `--json` rendering helpers.

use std::io::{self, IsTerminal};

use serde::Serialize;

use crate::error::CliError;

/// `--json` auto-enables when stdout is not a TTY — a piped decorated table
/// would break every script consuming it.
pub fn json_enabled(flag: bool) -> bool {
    json_enabled_with(flag, io::stdout().is_terminal())
}

pub fn json_enabled_with(flag: bool, stdout_is_tty: bool) -> bool {
    flag || !stdout_is_tty
}

pub fn print_json<T: Serialize>(value: &T) -> Result<(), CliError> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

/// Render a plain fixed-width table. Empty `rows` prints nothing (so `ori list`
/// of zero sandboxes is quiet rather than a bare header).
pub fn table_string(header: &[String], rows: &[Vec<String>]) -> String {
    if rows.is_empty() {
        return String::new();
    }
    let mut widths: Vec<usize> = header.iter().map(|h| h.len()).collect();
    for row in rows {
        for (i, cell) in row.iter().enumerate() {
            if i < widths.len() {
                widths[i] = widths[i].max(cell.len());
            }
        }
    }
    let mut out = String::new();
    let mut push_row = |out: &mut String, cells: &[String]| {
        for (i, w) in widths.iter().enumerate() {
            if i > 0 {
                out.push_str("  ");
            }
            let cell = cells.get(i).cloned().unwrap_or_default();
            if i + 1 == widths.len() {
                out.push_str(&cell);
            } else {
                out.push_str(&format!("{cell:<w$}", w = w));
            }
        }
        out.push('\n');
    };
    push_row(&mut out, header);
    out.push_str(&"-".repeat(widths.iter().sum::<usize>() + (widths.len().saturating_sub(1) * 2)));
    out.push('\n');
    for row in rows {
        push_row(&mut out, row);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_auto_enables_when_not_a_tty() {
        assert!(json_enabled_with(false, false), "piped stdout must enable json");
        assert!(!json_enabled_with(false, true), "tty stdout keeps human output");
        assert!(json_enabled_with(true, true), "explicit --json always wins");
    }

    #[test]
    fn empty_table_is_quiet() {
        assert_eq!(table_string(&["ID".into()], &[]), "");
    }

    #[test]
    fn table_aligns_columns() {
        let out = table_string(
            &["ID".into(), "STATE".into()],
            &[vec!["ori_a1b2c3d4".into(), "ready".into()]],
        );
        assert!(out.contains("ID            STATE"));
    }
}