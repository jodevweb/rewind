# REWIND — zsh hook.
#
# Records, for each command you run: the command line, its exit code, how long it took and the
# directory you ran it in. Never its output, and never anything about a command that did not run.
#
# Install:
#
#   echo 'source /path/to/rewind.zsh' >> ~/.zshrc
#
# It writes nothing unless REWIND is running: the daemon stamps a heartbeat file every two seconds,
# and a stale stamp means nobody is listening. Closing REWIND stops the collection here, at the
# source, rather than leaving command lines in a directory nothing reads.
#
# Nothing is ever read back from REWIND, and no network, socket or port is involved: this writes one
# small file per command into REWIND's own data directory, and REWIND deletes it as it reads it.

zmodload zsh/datetime 2>/dev/null || return

__rewind_dir() {
  if [[ -n "$REWIND_SPOOL" ]]; then
    print -r -- "$REWIND_SPOOL"
  elif [[ "$OSTYPE" == darwin* ]]; then
    print -r -- "$HOME/Library/Application Support/REWIND/spool"
  else
    print -r -- "${XDG_DATA_HOME:-$HOME/.local/share}/rewind/spool"
  fi
}

typeset -g __REWIND_SPOOL="$(__rewind_dir)"
typeset -g __REWIND_CMD=""
typeset -g __REWIND_AT=0

__rewind_now() {
  # Integer milliseconds, from a zsh builtin. No subprocess: this runs on every prompt.
  print -r -- $(( int(EPOCHREALTIME * 1000) ))
}

__rewind_preexec() {
  __REWIND_CMD="$1"
  __REWIND_AT="$(__rewind_now)"
}

__rewind_precmd() {
  local code=$?
  [[ -n "$__REWIND_CMD" ]] || return
  local cmd="$__REWIND_CMD"
  __REWIND_CMD=""

  # Is anybody listening? A heartbeat older than two minutes means REWIND is not running.
  local now beat
  now="$(__rewind_now)"
  beat="$(<"$__REWIND_SPOOL/.alive")" 2>/dev/null || return
  [[ "$beat" == <-> ]] || return
  (( now - beat < 120000 )) || return

  # Written under a temporary name and moved into place, so REWIND never reads half a command.
  local file="$__REWIND_SPOOL/${now}-$$-${RANDOM}"
  {
    print -r -- "v=1"
    print -r -- "ts=${__REWIND_AT:-$now}"
    print -r -- "exit=$code"
    print -r -- "ms=$(( now - ${__REWIND_AT:-$now} ))"
    print -r -- "shell=zsh"
    print -r -- "cwd=$PWD"
    # Last, and the rest of the file: a command containing quotes, newlines or '=' needs no escaping.
    print -r -- "cmd=$cmd"
  } >| "$file.tmp" 2>/dev/null && command mv -f "$file.tmp" "$file.cmd" 2>/dev/null
}

autoload -Uz add-zsh-hook
add-zsh-hook preexec __rewind_preexec
add-zsh-hook precmd __rewind_precmd
