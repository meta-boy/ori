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
        "new", "list", "info", "stop", "resume", "fork", "extend", "delete", "operation",
        "ssh", "exec", "scp", "forward", "host", "desktop", "snapshots", "snapshot", "env",
        "login", "logout", "status", "limits", "api-key", "webhook", "team",
        "data-retention", "dashboard", "self-update", "completions", "prompt", "interrupt",
        "events", "serve", "agent",
    ] {
        let ok = h.lines().any(|l| l.trim_start().starts_with(s) && l.trim_start().len() > s.len());
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
        (&["new"], &["--type", "--ttl", "--no-auto-stop", "--env", "--no-env", "--setup-file", "--environment", "--from", "--team", "--personal"]),
        (&["list"], &["--filter", "--all"]),
        (&["stop"], &["--force"]),
        (&["resume"], &["--type", "--ttl", "--no-auto-stop", "--env", "--no-env", "--environment"]),
        (&["fork"], &["--type", "--ttl", "--no-auto-stop", "--env", "--no-env", "--environment"]),
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
        "list", "info", "new", "rename", "default", "rm", "set", "set-var", "rm-var",
        "set-file", "rm-file", "add-repo", "rm-repo", "upgrade",
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
        let ok = h.lines().any(|l| l.trim_start().starts_with(s) && l.trim_start().len() > s.len());
        assert!(ok, "top-level help is missing `{s}`\n---\n{h}");
    }
}

#[test]
fn unimplemented_commands_fail_cleanly() {
    for args in [
        vec!["extend", "ori_x", "--hours", "1"],
        vec!["operation", "oriop_ab"],
        vec!["ssh", "ori_x"],
        vec!["snapshots"],
        vec!["snapshot", "tree", "snap1"],
        vec!["env", "list"],
        vec!["limits"],
        vec!["api-key", "create"],
        vec!["prompt"],
        vec!["serve"],
    ] {
        let out = Command::new(env!("CARGO_BIN_EXE_ori")).args(&args).output().unwrap();
        assert_eq!(out.status.code(), Some(1), "expected exit 1 for {args:?}");
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(
            stderr.contains("not implemented"),
            "stub must say 'not implemented', got: {stderr}"
        );
    }
}