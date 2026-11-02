#!/usr/bin/env bash
# Retakes the README and feature-tour screenshots (docs/screenshots/*.png) in a demo world:
# made-up Spaces, sessions and projects (scripts/screenshots/demo.py), so nothing of yours
# shows. It starts a second, separate Termorc and drives it with keystrokes and the pointer.
#
#   scripts/screenshots.sh                   every shot
#   scripts/screenshots.sh library peek      only these (names as in docs/screenshots)
#
# Before running:
# - The app you run this from (Terminal, iTerm, VS Code…) needs Accessibility and Screen
#   Recording in System Settings › Privacy & Security.
# - Run it on the built-in Retina display, on a normal desktop (not a full-screen app), with
#   Stage Manager off: the demo window has to stay visible to be captured.
# - Leave the keyboard and mouse alone for the ~3 minutes it takes. It stops if the demo
#   window ever loses the front, rather than typing into another app.
# Your own Termorc can stay open. Sidebar positions used for clicks (Peek, the Space editor)
# are points from the window's corner; if the sidebar layout changes, adjust them below.
set -euo pipefail
cd "$(dirname "$0")/.."

work=.build/screenshots
tools=$work/tools
raw=$work/raw
demo=$work/demo
out=docs/screenshots
want=("$@")
mkdir -p "$tools" "$raw"

for t in winid mouse overlay; do
  [[ "$tools/$t" -nt "scripts/screenshots/$t.swift" ]] || swiftc -O -o "$tools/$t" "scripts/screenshots/$t.swift"
done
"$tools/mouse" 0 0 move >/dev/null 2>&1 || { echo "Grant Accessibility to the app running this script first." >&2; exit 1; }
app=$(scripts/build-app.sh release | tail -1)

# The demo window's frame, in points.
X=120 Y=60 W=1240 H=775

# ---- Driving the demo app ------------------------------------------------------------------
pid() { pgrep -f "release-app/Termorc.app/Contents/MacOS/Termorc" | head -1 || true; } # empty when none runs
quit_demo() { local p; p=$(pid); if [[ -n "$p" ]]; then kill "$p"; sleep 1.5; fi; }
proc() { echo "tell application \"System Events\" to tell (first process whose unix id is $(pid))"; }

launch() { # launch dark|light: a fresh demo world, and Termorc started in it
  quit_demo
  python3 scripts/screenshots/demo.py "$demo" >/dev/null
  open -n "$app" --env TERMORC_DATA_DIR="$PWD/$demo/data" --env TERMORC_HOME="$PWD/$demo/home" \
    --env HOME="$PWD/$demo/home" --env TERMORC_APPEARANCE="$1"
  sleep 5
  front
  osascript -e "$(proc) to set size of window 1 to {$W, $H}" -e "$(proc) to set position of window 1 to {$X, $Y}" >/dev/null
  sleep 1
}

front() { # brings the demo forward; fails unless it really is frontmost
  local p i; p=$(pid)
  for i in 1 2 3 4 5; do
    osascript -e "tell application \"System Events\" to set frontmost of (first process whose unix id is $p) to true" >/dev/null
    sleep 0.5
    [[ "$(osascript -e 'tell application "System Events" to get unix id of first process whose frontmost is true')" == "$p" ]] && return 0
  done
  echo "The demo window isn't in front (Stage Manager, another desktop?): stopping." >&2
  exit 1
}

key() { # key <char> [modifiers, e.g. "command down, shift down"] [seconds to wait after]
  front
  if [[ -n "${2:-}" ]]; then osascript -e "tell application \"System Events\" to keystroke \"$1\" using {$2}"
  else osascript -e "tell application \"System Events\" to keystroke \"$1\""; fi
  sleep "${3:-0.8}"
}
code() { # code <key code> [modifiers] [seconds]: 36 Return, 53 Esc, 123–126 ← → ↓ ↑
  front
  if [[ -n "${2:-}" ]]; then osascript -e "tell application \"System Events\" to key code $1 using {$2}"
  else osascript -e "tell application \"System Events\" to key code $1"; fi
  sleep "${3:-0.8}"
}
type_() { front; osascript -e "tell application \"System Events\" to keystroke \"$1\""; sleep 0.4; }
run() { type_ "$1"; code 36 "" "${2:-1}"; } # type a command and press Return
at() { "$tools/mouse" $((X + $1)) $((Y + $2)) "${3:-move}"; sleep "${4:-0.8}"; } # at <x> <y> [move|click|double]: from the window's corner

press() { # press <title>: clicks the first control with that title (SwiftUI buttons have no shortcut)
  front
  osascript >/dev/null <<EOF
$(proc)
  repeat with e in (entire contents of window 1)
    try
      if (name of e as text) is "$1" or (description of e as text) is "$1" then
        click e
        return
      end if
    end try
  end repeat
end tell
EOF
  sleep 1
}

win() { "$tools/winid" "$(pid)" | awk -v w=$W '$4 == w {print $1; exit}'; }
raise_() { osascript -e "$(proc) to perform action \"AXRaise\" of window 1" >/dev/null 2>&1 || true; sleep 0.6; }

wanted() { [[ ${#want[@]} -eq 0 ]] && return 0; local n; for n in "${want[@]}"; do [[ "$n" == "$1" ]] && return 0; done; return 1; }

shot() { # shot <name>: the main window with its shadow
  front; raise_
  screencapture -x -l "$(win)" "$raw/$1.png"
  echo "  $1"
}
shot_panels() { # shot_panels <name>: the window with the panel floating over it
  front; sleep 0.4
  screencapture -x -l "$(win)" "$raw/.base.png"
  screencapture -x -R "$X,$Y,$W,$H" "$raw/.region.png"
  "$tools/overlay" "$raw/.base.png" "$raw/.region.png" "$raw/$1.png"
  rm -f "$raw/.base.png" "$raw/.region.png"
  echo "  $1"
}

# Starts every Acme session and runs what each one shows. ⌘1 is the Favorite, ⌘2–⌘9 the Acme
# rows top down (scripts/screenshots/demo.py sets that order).
populate() {
  key 3 "command down" 1.5; run "kubectl get pods" 1.5
  key 1 "command down" 1.5; run "htop-lite"
  key 4 "command down" 1.5; run "npm run dev"
  key 5 "command down" 1.5; run "npm run dev"
  key 6 "command down" 1.5; run "npm run worker"
  key 7 "command down" 2.5                                       # the split: four panes
  run "docker compose logs -f"
  code 124 "option down, command down"; run "npm run dev"        # → top right
  code 125 "option down, command down"; run "redis-cli monitor"  # ↓ bottom right
  code 123 "option down, command down"; run "npm run worker"     # ← bottom left
  key 8 "command down" 1.5; run "pnpm test" 4.5
  key 9 "command down" 1.5; run "npm run db:migrate" 4.5
  key 2 "command down" 1.5
  run "git log --oneline --graph --decorate -7" 1.5
  run "npm test" 4.5
  type_ "git pu"                                                 # the input bar suggests the rest
  sleep 1
}

settings_json() { # settings_json <key path> <value>: edits the demo's settings.json (applied live)
  python3 - "$demo/data/settings/settings.json" "$1" "$2" <<'EOF'
import json, sys
path, keys, value = sys.argv[1], sys.argv[2].split("."), sys.argv[3]
s = json.load(open(path))
node = s
for k in keys[:-1]: node = node.setdefault(k, {})
node[keys[-1]] = value
json.dump(s, open(path, "w"), indent=2)
EOF
  sleep 1.5
}

# ---- Dark ---------------------------------------------------------------------------------
echo "Dark…"
launch dark
populate
wanted main-dark && shot main-dark
if wanted splits; then key 7 "command down" 1.5; shot splits; fi
if wanted danger; then
  key 3 "command down" 1.5; run "sudo rm -rf /var/www/releases/2026-10" 1.5
  shot danger; code 53
fi
key 2 "command down" 1
if wanted command-bar || wanted command-bar-search; then
  key t "command down" 1.2
  wanted command-bar && shot_panels command-bar
  type_ "api"; sleep 1
  wanted command-bar-search && shot_panels command-bar-search
  code 53
fi
if wanted overview; then code 126 "control down, option down" 1.5; shot_panels overview; code 53; fi
if wanted library; then key y "command down" 1.5; code 125 "" 1; shot library; key y "command down"; fi
if wanted space-editor; then at 72 147 double 1.5; shot space-editor; code 53; fi   # the "Acme" header
if wanted peek; then at 90 427 move 2.5; shot_panels peek; at 700 400; fi            # the "pnpm test" row
if wanted settings; then key , "command down" 1.5; press "Appearance"; shot settings; code 53; fi
if wanted compact; then
  settings_json appearance.sidebar.mode compact; shot compact
  settings_json appearance.sidebar.mode expanded
fi
if wanted quick-terminal; then
  key t "command down" 1.2; type_ "Quick Terminal"; code 36 "" 1.5
  run "cd ~/Developer/acme-web && git log --oneline --graph --decorate -8" 1.5
  panel=$("$tools/winid" "$(pid)" | awk -v w=$W '$4 != w && $4 > 400 && $5 > 200 {print $1; exit}')
  screencapture -x -l "$panel" "$raw/quick-terminal.png"; echo "  quick-terminal"
fi

# ---- Light --------------------------------------------------------------------------------
if wanted main-light || wanted splits-light; then
  echo "Light…"
  launch light
  populate
  wanted main-light && shot main-light
  if wanted splits-light; then key 7 "command down" 1.5; shot splits-light; fi
fi
quit_demo

# ---- Into the docs, at the README's size ------------------------------------------------------
for f in "$raw"/*.png; do
  sips --resampleWidth 1600 "$f" --out "$out/$(basename "$f")" >/dev/null
done
echo "Updated $(ls "$raw"/*.png | wc -l | tr -d ' ') screenshots in $out"
