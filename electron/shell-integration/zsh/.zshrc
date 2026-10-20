if [[ -f "$TERMAC_USER_ZDOTDIR/.zshrc" ]]; then
  TERMAC_ZDOTDIR="$ZDOTDIR"; ZDOTDIR="$TERMAC_USER_ZDOTDIR"
  . "$ZDOTDIR/.zshrc"
  ZDOTDIR="$TERMAC_ZDOTDIR"
fi

# OSC 633 marks: A = prompt, E = command line, C = command started, D = finished, P = cwd.
__termac_running=
__termac_precmd() {
  local ret=$?
  if [[ -n "$__termac_running" ]]; then
    builtin printf '\e]633;D;%s\a' "$ret"
    __termac_running=
  fi
  builtin printf '\e]633;P;Cwd=%s\a' "$PWD"
  builtin printf '\e]633;A\a'
}
__termac_preexec() {
  __termac_running=1
  builtin printf '\e]633;E;%s\a' "${1//[[:cntrl:]]/ }"
  builtin printf '\e]633;C\a'
}
precmd_functions=(__termac_precmd ${precmd_functions[@]})
preexec_functions+=(__termac_preexec)

if [[ -n "$TERMAC_STARTUP" ]]; then eval "$TERMAC_STARTUP"; fi
unset TERMAC_STARTUP

if [[ ! -o login ]]; then
  ZDOTDIR="$TERMAC_USER_ZDOTDIR"; unset TERMAC_ZDOTDIR TERMAC_USER_ZDOTDIR
fi
