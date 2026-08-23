//! Drift test: run `ori <cmd> --help` and assert the spec surface from
//! `docs/SPEC-CLI.md` is present. Catches a renamed flag, a dropped subcommand,
//! or a moved positional.

use std::process::Command;

fn help(args: &[&str]) -> String {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_ori"));
    cmd.args(args).arg("--help");
    let out = cmd.output().unwrap();
    assert!(
        out.status.success(),
        "`ori {} --help` failed: {}",
        args.join(" "),
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap()
}

fn assert_present(h: &str, cmd: &str, needle: &str) {
    assert!(
        h.contains(needle),
        "`ori {cmd} --help` is missing `{needle}`\n---\n{h}"
    );
}

#[test]
fn top_level_lists_every_subcommand() {
    let h = help(&[]);
    for s in [
        "new",
        "list",
        "info",
        "stop",
        "resume",
        "fork",
        "extend",
        "delete",
        "operation",
        "ssh",
        "exec",
        "scp",
        "forward",
        "host",
        "desktop",
        "snapshots",
        "snapshot",
        "env",
        "login",
        "logout",
        "status",
        "api-key",
        "webhook",
        "team",
        "data-retention",
        "dashboard",
        "self-update",
        "completions",
        "prompt",
        "interrupt",
        "events",
        "serve",
        "agent",
    ] {
        let ok = h
            .lines()
            .any(|l| l.trim_start().starts_with(s) && l.trim_start().len() > s.len());
        assert!(ok, "top-level help is missing subcommand `{s}`\n---\n{h}");
    }
}

#[test]
fn global_flags_appear_on_subcommands() {
    let h = help(&["list"]);
    for g in ["--api-url", "--json", "--no-update"] {
        assert_present(&h, "list", g);
    }
}

#[test]
fn lifecycle_help_covers_spec() {
    let checks: &[(&[&str], &[&str])] = &[
        (
            &["new"],
            &[
                "--type",
                "--ttl",
                "--no-auto-stop",
                "--env",
                "--no-env",
                "--setup-file",
                "--environment",
                "--from",
                "--team",
                "--personal",
            ],
        ),
        (&["list"], &["--filter", "--all"]),
        (&["stop"], &["--force"]),
        (
            &["resume"],
            &[
                "--type",
                "--ttl",
                "--no-auto-stop",
                "--env",
                "--no-env",
                "--environment",
            ],
        ),
        (
            &["fork"],
            &[
                "--type",
                "--ttl",
                "--no-auto-stop",
                "--env",
                "--no-env",
                "--environment",
                "--no-stop",
            ],
        ),
        (&["extend"], &["--hours", "--ttl", "--no-auto-stop"]),
        (&["delete"], &["--yes"]),
    ];
    for (cmd, needles) in checks {
        let h = help(cmd);
        for n in *needles {
            assert_present(&h, &cmd.join(" "), n);
        }
    }
}

#[test]
fn access_help_covers_spec() {
    let checks: &[(&[&str], &[&str])] = &[
        (&["exec"], &["--cwd", "--timeout", "--detach", "--status"]),
        (&["scp"], &["--recursive"]),
        (&["forward"], &["--remote", "--local", "--bind"]),
        (&["host"], &["--private", "--public", "--title"]),
        (&["desktop"], &["--vnc", "--public"]),
    ];
    for (cmd, needles) in checks {
        let h = help(cmd);
        for n in *needles {
            assert_present(&h, &cmd.join(" "), n);
        }
    }
}

#[test]
fn snapshot_help_covers_spec() {
    let h = help(&["snapshot"]);
    for n in ["save", "latest", "tree", "pull", "delete", "rm"] {
        assert_present(&h, "snapshot", n);
    }
    let h = help(&["snapshots"]);
    for n in ["--limit", "--all"] {
        assert_present(&h, "snapshots", n);
    }
}

#[test]
fn env_help_covers_spec() {
    let h = help(&["env"]);
    for n in [
        "list", "info", "new", "rename", "default", "rm", "set", "set-var", "rm-var", "set-file",
        "rm-file", "add-repo", "rm-repo", "upgrade",
    ] {
        assert_present(&h, "env", n);
    }
}

#[test]
fn account_help_covers_spec() {
    let checks: Vec<(&[&str], &[&str])> = vec![
        (&["login"], &["--google", "--email"]),
        (&["api-key"], &["create", "list", "rotate", "revoke"]),
        (&["webhook"], &["create", "list", "rotate", "remove"]),
        (&["team"], &["list", "switch"]),
        (&["data-retention"], &["status", "enable"]),
        (&["completions"], &["bash", "zsh", "fish", "powershell"]),
    ];
    for (cmd, needles) in checks {
        let h = help(cmd);
        for n in needles {
            assert_present(&h, &cmd.join(" "), n);
        }
    }
}

#[test]
fn agent_and_roles_are_listed() {
    let h = help(&[]);
    for s in ["prompt", "interrupt", "events", "serve", "agent"] {
        let ok = h
            .lines()
            .any(|l| l.trim_start().starts_with(s) && l.trim_start().len() > s.len());
        assert!(ok, "top-level help is missing `{s}`\n---\n{h}");
    }
}

#[test]
fn no_command_reports_unimplemented() {
    // Inverted from the old stub-list test, which went stale four times as
    // features landed. Now that every command in the surface is implemented,
    // the useful invariant is the absence of stubs: if any command starts
    // answering "not implemented" again, that is a regression.
    let commands = [
        vec!["new"],
        vec!["list"],
        vec!["info", "ori_x"],
        vec!["stop", "ori_x"],
        vec!["resume", "ori_x"],
        vec!["fork", "ori_x"],
        vec!["extend", "ori_x", "--hours", "1"],
        vec!["delete", "ori_x", "--yes"],
        vec!["operation", "zz"],
        vec!["exec", "ori_x", "true"],
        // `ssh`, `scp` and `forward` are deliberately absent: they exec the
        // system ssh/scp or bind a listener and loop, so spawning them here
        // hangs the suite rather than testing anything. Their implementations
        // are covered by the real-host verification instead.
        vec!["host", "ori_x", "3000"],
        vec!["desktop", "ori_x"],
        vec!["snapshots"],
        vec!["env", "list"],
        vec!["api-key", "list"],
        vec!["webhook", "list"],
        vec!["team", "list"],
        vec!["data-retention", "status"],
        vec!["dashboard"],
        vec!["self-update"],
        vec!["prompt", "ori_x", "--provider", "claude", "hi"],
        vec!["interrupt", "ori_x"],
        // `events` without --follow returns after one poll, so it is safe.
        vec!["events", "ori_x"],
    ];
    for args in commands {
        let out = Command::new(env!("CARGO_BIN_EXE_ori"))
            // Point at a closed port: every command should fail on transport,
            // never on being unimplemented.
            .args(["--api-url", "http://127.0.0.1:9"])
            .args(&args)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(
            !stderr.contains("not implemented"),
            "{args:?} still reports unimplemented: {stderr}"
        );
    }
}

/// `serve` and `agent` are real roles now (one binary, three roles), so their
/// help surfaces come from the wired implementations, not a stub.
#[test]
fn serve_and_agent_help_are_wired() {
    for sub in ["serve", "agent"] {
        let out = Command::new(env!("CARGO_BIN_EXE_ori"))
            .args([sub, "--help"])
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(0), "`ori {sub} --help` failed");
        let help = String::from_utf8_lossy(&out.stdout);
        assert!(
            !help.contains("not implemented"),
            "`ori {sub} --help` must not be a stub: {help}"
        );
    }
}

/// On non-Linux hosts the agent role must refuse loudly rather than pretend.
#[cfg(not(target_os = "linux"))]
#[test]
fn agent_refuses_off_linux() {
    let out = Command::new(env!("CARGO_BIN_EXE_ori"))
        .args(["agent"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("Linux"), "agent must name Linux: {stderr}");
}
