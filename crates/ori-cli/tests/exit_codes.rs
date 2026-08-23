//! Process-level exit-code contract (SPEC-CLI.md): 0 success, 1 local/usage
//! error, 2 API error, and the remote code for `exec`. clap's default usage
//! exit code is 2, so this guards the override in main.rs.

use std::process::Command;

fn exit_code(args: &[&str]) -> i32 {
    let out = Command::new(env!("CARGO_BIN_EXE_ori"))
        .args(args)
        .output()
        .unwrap();
    out.status.code().unwrap()
}

#[test]
fn success_is_zero() {
    assert_eq!(exit_code(&["_debug", "json-mode"]), 0);
}

#[test]
fn help_is_zero() {
    assert_eq!(exit_code(&["--help"]), 0);
    assert_eq!(exit_code(&["new", "--help"]), 0);
}

#[test]
fn usage_error_is_one() {
    assert_eq!(exit_code(&[]), 1, "missing subcommand is a usage error");
    assert_eq!(
        exit_code(&["list", "--nope"]),
        1,
        "unknown flag is a usage error"
    );
    assert_eq!(
        exit_code(&["exec", "ori_x", "--timeout", "0", "true"]),
        1,
        "out-of-range value"
    );
}

#[test]
fn local_failure_is_one() {
    // Earlier versions of this test named specific stubbed commands and went
    // stale twice - first when `host` was implemented, then `desktop` - failing
    // each time for the good reason that the feature now worked. A test that
    // breaks on progress is testing the wrong thing, so the
    // Unimplemented -> 1 mapping is asserted as a unit test in
    // `error.rs` instead, and this covers a real process-level local failure.
    assert_eq!(
        exit_code(&["serve", "--db-path", "/nonexistent/dir/x.db"]),
        1,
        "an unusable local path is a usage-class failure, not an API error"
    );
}

#[test]
fn exec_remote_code_is_propagated() {
    // `_debug` has no API dependency; remote-code propagation is covered by the
    // exec handler unit path and the mock-server smoke test, so assert the
    // mapping function here instead.
    assert_eq!(
        ori_cli::error::exit_code(&ori_cli::error::CliError::RemoteExit(42)),
        42
    );
}
