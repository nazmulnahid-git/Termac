# Termorc shell integration for bash (loaded with --rcfile).
if [[ -n "$TERMAC_LOGIN" ]]; then
  [[ -f /etc/profile ]] && . /etc/profile
  for __f in ~/.bash_profile ~/.bash_login ~/.profile; do [[ -f "$__f" ]] && { . "$__f"; break; }; done
  unset __f TERMAC_LOGIN
else
  [[ -f ~/.bashrc ]] && . ~/.bashrc
fi

__termac_running=
__termac_in_prompt=
__termac_precmd() {
  local ret=$?
  if [[ -n "$__termac_running" ]]; then printf '\e]633;D;%s\a' "$ret"; __termac_running=; fi
  printf '\e]633;P;Cwd=%s\a' "$PWD"
  printf '\e]633;A\a'
}
__termac_ready() { __termac_in_prompt=1; }
__termac_preexec() {
  [[ -z "$__termac_in_prompt" ]] && return
  __termac_in_prompt=
  __termac_running=1
  local cmd; cmd=$(HISTTIMEFORMAT= builtin history 1 | sed 's/^ *[0-9]* *//')
  printf '\e]633;E;%s\a' "${cmd//[[:cntrl:]]/ }"
  printf '\e]633;C\a'
}
trap '__termac_preexec' DEBUG
PROMPT_COMMAND="__termac_precmd;${PROMPT_COMMAND:+$PROMPT_COMMAND;}__termac_ready"

if [[ -n "$TERMAC_STARTUP" ]]; then eval "$TERMAC_STARTUP"; fi
unset TERMAC_STARTUP
