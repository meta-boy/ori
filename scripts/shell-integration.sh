#!/usr/bin/env bash
# Shell integration for the `ori` CLI: makes commands work with no ori id right after
# `ori new` or `ori fork`.
#
# How, and why this way: the CLI writes the new ori id into a temp file
# named by ORI_CURRENT_ID_FILE, and this wrapper exports it as ORI_CURRENT_ID. The SHELL owns
# "which ori am I working on", not the CLI — so two terminals never fight over a shared state
# file, and nothing is left behind when a shell exits.
#
# Install:
#   scripts/shell-integration.sh >> ~/.zshrc     # or ~/.bashrc
#   exec $SHELL
#
# It prints the snippet rather than editing your rc file: appending to someone's shell config
# unasked is not a thing a tool should do.

ORI_BIN="${ORI_BIN:-ori}"

cat <<SNIPPET
# ---- ori shell integration (start) ----
ori() {
  local _ori_current_file
  _ori_current_file="\$(mktemp)"
  local _ori_prev="\${ORI_CURRENT_ID_FILE-}"
  export ORI_CURRENT_ID_FILE="\$_ori_current_file"

  command ${ORI_BIN} "\$@"
  local _ori_status=\$?

  # Only new/fork/resume change which ori you are working on.
  case "\${1-}" in
    new|fork|resume)
      if [ \$_ori_status -eq 0 ] && [ -s "\$_ori_current_file" ]; then
        ORI_CURRENT_ID="\$(tr -d '[:space:]' < "\$_ori_current_file")"
        export ORI_CURRENT_ID
        [ -n "\$ORI_CURRENT_ID" ] && printf 'ori: current is %s\\n' "\$ORI_CURRENT_ID" >&2
      fi
      ;;
  esac

  if [ -n "\$_ori_prev" ]; then export ORI_CURRENT_ID_FILE="\$_ori_prev"; else unset ORI_CURRENT_ID_FILE; fi
  rm -f "\$_ori_current_file"
  return \$_ori_status
}
# ---- ori shell integration (end) ----
SNIPPET
