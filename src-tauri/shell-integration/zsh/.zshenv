# Termorc shell integration: load the user's own startup files, then add prompt hooks.
if [[ -f "$TERMAC_USER_ZDOTDIR/.zshenv" ]]; then
  TERMAC_ZDOTDIR="$ZDOTDIR"; ZDOTDIR="$TERMAC_USER_ZDOTDIR"
  . "$ZDOTDIR/.zshenv"
  TERMAC_USER_ZDOTDIR="$ZDOTDIR"; ZDOTDIR="$TERMAC_ZDOTDIR"
fi
