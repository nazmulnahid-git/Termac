# Termac shell integration for fish (loaded with --init-command).
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
if set -q TERMAC_STARTUP
    eval $TERMAC_STARTUP
    set -e TERMAC_STARTUP
end
