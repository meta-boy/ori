//! `--json` auto-enables when stdout is not a TTY. `Command::output()` runs the
//! binary with piped stdout (no TTY), so `_debug json-mode` must print `true`.

use std::process::Command;

fn run(args: &[&str]) -> String {
    let out = Command::new(env!("CARGO_BIN_EXE_ori")).args(args).output().unwrap();
    assert!(out.status.success(), "exit {:?}: {}", out.status.code(), String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).unwrap()
}

#[test]
fn json_auto_enables_when_stdout_is_piped() {
    assert_eq!(run(&["_debug", "json-mode"]).trim(), "true");
}

#[test]
fn explicit_json_flag_wins_even_on_a_tty() {
    assert_eq!(run(&["_debug", "json-mode", "--json"]).trim(), "true");
}