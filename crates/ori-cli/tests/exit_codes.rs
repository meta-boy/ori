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
fn unimplemented_is_one() {
    assert_eq!(exit_code(&["serve"]), 1);
    // Commands still stubbed in this build. `host` was moved off this list when
    // it was implemented; keep it pointing at genuinely unimplemented ones so
    // the test tracks reality rather than asserting a stub that no longer is.
    assert_eq!(exit_code(&["desktop", "ori_x"]), 1);
    assert_eq!(exit_code(&["webhook", "list"]), 1);
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
