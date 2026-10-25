# Termorc shell integration for fish (loaded with --init-command).
function __termac_preexec --on-event fish_preexec
    printf '\e]633;E;%s\a' (string replace -ra '[[:cntrl:]]' ' ' -- $argv[1])
    printf '\e]633;C\a'
end
function __termac_postexec --on-event fish_postexec
    printf '\e]633;D;%s\a' $status
end
function __termac_prompt --on-event fish_prompt
    printf '\e]633;P;Cwd=%s\a' $PWD
    printf '\e]633;A\a'
end
# Termorc draws its own prompt (TERMORC_PROMPT); the shell's would only repeat it.
if set -q TERMORC_PROMPT
    function fish_prompt; end
    function fish_right_prompt; end
    function fish_mode_prompt; end
    set -g fish_greeting
end
if set -q TERMAC_STARTUP
    eval $TERMAC_STARTUP
    set -e TERMAC_STARTUP
end
