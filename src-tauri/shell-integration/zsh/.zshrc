# /etc/zshrc derives HISTFILE from ZDOTDIR, which points here; keep history in the user's file.
if [[ -z "$HISTFILE" || "$HISTFILE" == "$ZDOTDIR/.zsh_history" ]]; then
  HISTFILE="$TERMAC_USER_ZDOTDIR/.zsh_history"
fi
[[ -n "$TERMORC_PROMPT" ]] && typeset -g POWERLEVEL9K_INSTANT_PROMPT=off
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
  (( __termac_zle_mark )) || builtin printf '\e]633;A\a'
}
# The prompt mark goes out when the line editor starts reading (zle-line-init), not in
# precmd: other precmd hooks can take a while, and input sent before the editor is ready
# would be echoed twice. Older zsh without hook widgets marks the prompt in precmd.
__termac_line_init() { builtin printf '\e]633;A\a' }
__termac_zle_mark=0
if autoload -Uz add-zle-hook-widget 2>/dev/null && add-zle-hook-widget line-init __termac_line_init 2>/dev/null; then
  __termac_zle_mark=1
fi
__termac_preexec() {
  __termac_running=1
  builtin printf '\e]633;E;%s\a' "${1//[[:cntrl:]]/ }"
  builtin printf '\e]633;C\a'
}
precmd_functions=(__termac_precmd ${precmd_functions[@]})
preexec_functions+=(__termac_preexec)

# Termorc draws its own prompt and input bar (TERMORC_PROMPT), so the shell's prompt would
# only repeat it. Blank it after every other precmd hook (themes like p10k set it there).
if [[ -n "$TERMORC_PROMPT" ]]; then
  PROMPT_EOL_MARK=''
  __termac_bare_prompt() {
    PROMPT='' RPROMPT='' PS2=''
    precmd_functions=(${precmd_functions:#__termac_bare_prompt} __termac_bare_prompt)
  }
  precmd_functions+=(__termac_bare_prompt)
fi

if [[ -n "$TERMAC_STARTUP" ]]; then eval "$TERMAC_STARTUP"; fi
unset TERMAC_STARTUP

if [[ ! -o login ]]; then
  ZDOTDIR="$TERMAC_USER_ZDOTDIR"; unset TERMAC_ZDOTDIR TERMAC_USER_ZDOTDIR
fi
