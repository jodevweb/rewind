# REWIND — bash hook.
#
# The zsh version of this file is the accurate one: zsh has `preexec`, which is handed the command
# line exactly once, before it runs. bash has no such hook, so this uses the `DEBUG` trap, which
# fires once per *simple command* — for `a | b` it fires twice. The first one wins here, so a
# pipeline is recorded under its first command. That is a known approximation, written down rather
# than hidden, and it is why `history` is not used instead: reading it costs a subprocess on every
# prompt, and this hook must not make your prompt slower.
#
# Install:
#
#   echo 'source /path/to/rewind.bash' >> ~/.bashrc
#
# Records the command, its exit code, its duration and the directory. Never its output. Writes
# nothing unless REWIND is running.

case $- in
  *i*) ;;
  *) return ;;   # Not interactive: there are no commands of yours to record.
esac

if [ -n "$REWIND_SPOOL" ]; then
  __REWIND_SPOOL="$REWIND_SPOOL"
elif [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then
  __REWIND_SPOOL="$HOME/Library/Application Support/REWIND/spool"
else
  __REWIND_SPOOL="${XDG_DATA_HOME:-$HOME/.local/share}/rewind/spool"
fi

__REWIND_CMD=""
__REWIND_AT=0

# Integer milliseconds. `EPOCHREALTIME` is a bash 5 builtin and costs nothing; the fallback for
# bash 3.2 — which is what macOS still ships — spawns `date`, and only there.
__rewind_now() {
  if [ -n "${EPOCHREALTIME:-}" ]; then
    local raw="${EPOCHREALTIME//[.,]/}"   # seconds and six digits of microseconds
    echo $(( 10#$raw / 1000 ))
  else
    echo $(( $(date +%s) * 1000 ))
  fi
}

__rewind_preexec() {
  # The trap fires for the hook's own commands too, and for completion.
  [ -n "$COMP_LINE" ] && return
  [ -n "$__REWIND_CMD" ] && return
  case "$BASH_COMMAND" in
    __rewind_*) return ;;
  esac
  __REWIND_CMD="$BASH_COMMAND"
  __REWIND_AT="$(__rewind_now)"
}

__rewind_precmd() {
  local code=$?
  [ -n "$__REWIND_CMD" ] || return
  local cmd="$__REWIND_CMD"
  __REWIND_CMD=""

  local now beat
  now="$(__rewind_now)"
  beat="$(<"$__REWIND_SPOOL/.alive")" 2>/dev/null || return
  case "$beat" in
    ''|*[!0-9]*) return ;;
  esac
  [ $(( now - beat )) -lt 120000 ] || return

  local file="$__REWIND_SPOOL/${now}-$$-${RANDOM}"
  {
    echo "v=1"
    echo "ts=${__REWIND_AT:-$now}"
    echo "exit=$code"
    echo "ms=$(( now - ${__REWIND_AT:-$now} ))"
    echo "shell=bash"
    echo "cwd=$PWD"
    # Last, and the rest of the file: nothing in the command needs escaping.
    echo "cmd=$cmd"
  } > "$file.tmp" 2>/dev/null && command mv -f "$file.tmp" "$file.cmd" 2>/dev/null
}

trap '__rewind_preexec' DEBUG
case "$PROMPT_COMMAND" in
  *__rewind_precmd*) ;;
  *) PROMPT_COMMAND="__rewind_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
esac
