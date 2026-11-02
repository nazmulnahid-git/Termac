#!/usr/bin/env python3
"""Builds the demo world the README screenshots are taken in: a fake home folder (git
projects, shell history, SSH hosts, stand-in npm/docker/kubectl that print believable
output) and Termorc's data (Spaces, sessions, Favorites, a split, Library entries).

    scripts/screenshots/demo.py <dir>   → <dir>/home and <dir>/data

Termorc is then started with TERMORC_DATA_DIR=<dir>/data and TERMORC_HOME=<dir>/home, so
nothing of yours (sessions, history, SSH hosts) shows in the images.
"""
import json, os, shutil, stat, subprocess, sys, time

root = os.path.abspath(sys.argv[1])
H, data = f"{root}/home", f"{root}/data"
shutil.rmtree(root, ignore_errors=True)
os.makedirs(f"{H}/bin"); os.makedirs(f"{H}/.ssh"); os.makedirs(f"{data}/library")
now = int(time.time() * 1000)


def write(path, text, exe=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)
    if exe:
        os.chmod(path, os.stat(path).st_mode | stat.S_IEXEC)


# ---- Home folder ---------------------------------------------------------------------
write(f"{H}/.zshrc", 'export PATH="$HOME/bin:$PATH"\nexport HISTFILE="$HOME/.zsh_history"\n')
write(f"{H}/.zsh_history", "\n".join([
    "git status", "git switch -c feat/rate-limits", "npm run dev", "npm test", "docker compose up -d",
    "kubectl get pods -n api", "ssh prod-api", "make build", "terraform plan",
    "git log --oneline --graph --decorate -7", "pnpm test", "npm run db:migrate",
    "git push -u origin feat/checkout-v2"]) + "\n")
write(f"{H}/.ssh/config", "Host prod-api\n  HostName 10.0.4.12\n  User deploy\nHost staging\n  HostName staging.example.com\n  User deploy\nHost db-replica\n  HostName 10.0.4.30\n")


def repo(name, commits, branch=None, more=(), dirty=()):
    path = f"{H}/Developer/{name}"
    os.makedirs(path)
    git = lambda *a: subprocess.run(["git", "-C", path, *a], check=True, capture_output=True)
    git("init", "-b", "main")
    git("config", "user.name", "Ada Lovelace"); git("config", "user.email", "ada@acme.dev")
    git("config", "core.pager", "cat")  # git log prints instead of opening a pager
    for m in commits:
        with open(f"{path}/CHANGELOG", "a") as f: f.write(m + "\n")
        git("add", "-A"); git("commit", "-m", m)
    if branch:
        git("switch", "-c", branch)
        for m in more:
            with open(f"{path}/CHANGELOG", "a") as f: f.write(m + "\n")
            git("add", "-A"); git("commit", "-m", m)
    for d in dirty:
        write(f"{path}/{d}", "changed\n")
    return path


web = repo("acme-web", ["chore: bump next to 15.2", "feat(cart): persist cart in local storage",
                        "fix(pricing): round tax per line item", "feat(checkout): new address step"],
           branch="feat/checkout-v2", more=["feat(checkout): address autocomplete", "test(checkout): cover the address step"],
           dirty=["src/app/checkout/form.tsx", "src/app/checkout/address.ts"])
api = repo("acme-api", ["feat(api): rate limits per key"])
infra = repo("infra", ["chore: pin provider versions"])
blog = repo("blog", ["post: notes on terminals"])

# Stand-ins for the tools the sessions run.
write(f"{H}/bin/npm", r'''#!/bin/zsh
g=$'\e[32m'; d=$'\e[2m'; c=$'\e[36m'; b=$'\e[1m'; r=$'\e[0m'
name=${PWD:t}
case "$*" in
  test|"run test")
    print "\n> ${name}@2.3.0 test\n> vitest run\n"; sleep 0.3
    print " ${c}${b}RUN${r} ${c}v3.0.7${r} ${d}${PWD/#$HOME/~}${r}\n"
    for f in "src/lib/cart.test.ts (14 tests) 38ms" "src/lib/pricing.test.ts (22 tests) 51ms" "src/app/checkout/form.test.tsx (9 tests) 212ms" "src/lib/currency.test.ts (6 tests) 9ms" "src/app/api/session.test.ts (11 tests) 97ms"; do sleep 0.2; print " ${g}✓${r} $f"; done
    sleep 1.6  # over 3 s in all, so the row shows ✓
    print "\n ${d}Test Files${r}  ${g}${b}5 passed${r} (5)\n ${d}     Tests${r}  ${g}${b}62 passed${r} (62)\n ${d}  Start at${r}  10:42:07\n ${d}  Duration${r}  1.84s\n" ;;
  "run dev")
    print "\n> ${name}@2.3.0 dev\n> next dev --turbo\n"
    print "   ${b}▲ Next.js 15.2.0${r} (Turbopack)\n   - Local:        http://localhost:3000\n   - Network:      http://192.168.1.24:3000\n\n ${g}✓${r} Starting...\n ${g}✓${r} Ready in 1.2s"
    sleep 1; for p in / /checkout /api/cart /api/session /checkout/address /api/pricing; do sleep 0.7; print " ${d}GET${r} $p ${g}200${r} in $((RANDOM % 80 + 12))ms"; done; sleep 100000 ;;
  "run worker")
    print "\n> ${name}@2.3.0 worker\n> tsx src/worker.ts\n"
    i=0; while true; do i=$((i+1)); print "${d}[jobs]${r} ${c}email.send${r} #$((4200+i)) ${g}done${r} in $((RANDOM % 300 + 40))ms"; sleep 1.5; done ;;
  "run db:migrate")
    print "\n> ${name}@2.3.0 db:migrate\n> prisma migrate deploy\n"; sleep 0.4
    print "3 migrations found in prisma/migrations\n"
    for m in 20261028_add_carts 20261030_tax_lines 20261101_address_book; do sleep 0.3; print "Applying migration \`$m\`"; done
    sleep 2; print "\n${g}All migrations have been successfully applied.${r}" ;;
  *) print "npm $*" ;;
esac
''', exe=True)
shutil.copy(f"{H}/bin/npm", f"{H}/bin/pnpm")
write(f"{H}/bin/docker", r'''#!/bin/zsh
d=$'\e[2m'; c=$'\e[36m'; m=$'\e[35m'; y=$'\e[33m'; r=$'\e[0m'
print "${c}postgres-1${r}  | database system is ready to accept connections"
print "${m}redis-1   ${r}  | Ready to accept connections tcp"
while true; do sleep 1.2; print "${c}postgres-1${r}  | ${d}LOG:${r}  checkpoint complete: wrote $((RANDOM % 90 + 3)) buffers"; sleep 1.1; print "${y}api-1     ${r}  | POST /v1/orders 201 $((RANDOM % 60 + 9))ms"; done
''', exe=True)
write(f"{H}/bin/redis-cli", r'''#!/bin/zsh
d=$'\e[2m'; r=$'\e[0m'
print "OK"
while true; do sleep 0.9; print "${d}$(date +%s).$((RANDOM % 900000 + 100000)) [0 172.18.0.5:51234]${r} \"GET\" \"cart:u_$((RANDOM % 900 + 100))\""; done
''', exe=True)
write(f"{H}/bin/kubectl", r'''#!/bin/zsh
g=$'\e[32m'; r=$'\e[0m'
print "NAME                          READY   STATUS    RESTARTS   AGE"
for p in "api-7c9f6d8b5-2xk4p   1/1     ${g}Running${r}   0          3d" "api-7c9f6d8b5-9qwzt   1/1     ${g}Running${r}   0          3d" "worker-5d4b9c7f6-lm2rs 1/1     ${g}Running${r}   1          2d" "web-6f8d7c9b4-h7v3n   1/1     ${g}Running${r}   0          18h"; do print "$p"; done
''', exe=True)
write(f"{H}/bin/htop-lite", '#!/bin/zsh\nwhile true; do print "cpu $((RANDOM % 40 + 5))%  mem 6.$((RANDOM % 9)) GB  load $((RANDOM % 3)).$((RANDOM % 99))"; sleep 2; done\n', exe=True)

# ---- Termorc's data ----------------------------------------------------------------------
tabs, sessions = {}, {}


def tab(tid, cwd=None, name=None, icon=None, color=None, danger=False, panes=None):
    def session(sid, where):
        sessions[sid] = {"id": sid, "cwd": where, "profileId": "default", "command": "", "createdAt": now}
    if panes:  # four panes: (a over d) beside (b over c)
        a, b, c, d = (f"{tid}_{i}" for i in range(4))
        for sid, where in zip((a, b, c, d), panes): session(sid, where)
        layout = {"dir": "row", "ratio": 0.5, "a": {"dir": "col", "ratio": 0.5, "a": {"sid": a}, "b": {"sid": d}},
                  "b": {"dir": "col", "ratio": 0.5, "a": {"sid": b}, "b": {"sid": c}}}
        active = a
    else:
        active = f"{tid}_0"; session(active, cwd); layout = {"sid": active}
    t = {"id": tid, "layout": layout, "activeSid": active, "effects": {"danger": True} if danger else {}, "createdAt": now}
    t.update({k: v for k, v in (("name", name), ("icon", icon), ("color", color)) if v})
    tabs[tid] = t
    return tid


# The order matters to scripts/screenshots.sh: ⌘1 is the Favorite, ⌘2–⌘9 the Acme rows top down.
fav = tab("tfav", H, name="stats", icon="activity", color="#22a06b")
checkout = tab("tcheckout", web, name="checkout", icon="code")
prod = tab("tprod", infra, name="infra · prod", icon="cloud", danger=True)
services = [tab("tweb", web, name="web", icon="globe", color="#3b82f6"),
            tab("tapi", api, name="api", icon="server", color="#f08a3c"),
            tab("tworker", api, name="worker", icon="zap", color="#d4a017"),
            tab("tsplit", color="#0ea5a4", panes=[api, web, api, api])]
today = [tab("ttest", web), tab("tmigrate", api)]
look = {"dim": 0.6, "blur": 0}
spaces = [
    {"id": "sacme", "name": "Acme", "glyph": "◆", "color": "#8b5cf6", "startDir": "~/Developer/acme-web", "term": look,
     "pinned": [checkout, prod], "folders": [{"id": "fsvc", "name": "Services", "open": True, "tabs": services}],
     "today": today, "activeTabId": checkout},
    {"id": "spers", "name": "Personal", "glyph": "●", "color": "#f08a3c", "startDir": "~", "term": look,
     "pinned": [tab("tblog", blog, name="blog", icon="book"), tab("tdots", H, name="dotfiles", icon="wrench")],
     "folders": [], "today": [], "activeTabId": "tblog"},
    {"id": "sops", "name": "Ops", "glyph": "▲", "color": "#22a06b", "startDir": "~/Developer/infra", "term": look,
     "pinned": [tab("tk8s", infra, name="cluster", icon="layers"), tab("tdb", infra, name="db replica", icon="database")],
     "folders": [], "today": [], "activeTabId": "tk8s"},
]
state = {"version": 2, "spaces": spaces, "tabs": tabs, "sessions": sessions, "favorites": [fav], "activeSpaceId": "sacme",
         "onboarded": True, "recentDirs": [{"path": p, "visits": 5, "last": now} for p in (web, api, infra)],
         "settings": {"terminalWelcome": False}}
write(f"{data}/state.json", json.dumps(state))

# Library: archived sessions with their saved output.
G, R, Dm, Rd = "\x1b[32m", "\x1b[0m", "\x1b[2m", "\x1b[31m"
entries = [
    ("lib1", "npm run build", "sacme", "Acme", web, ["npm run build"], "ok", 3,
     f"> acme-web@2.3.0 build\r\n> next build\r\n\r\n   ▲ Next.js 15.2.0\r\n\r\n {G}✓{R} Compiled successfully in 8.4s\r\n {G}✓{R} Collecting page data\r\n {G}✓{R} Generating static pages (24/24)\r\n\r\nRoute (app)                 Size     First Load JS\r\n┌ ○ /                       5.2 kB   112 kB\r\n├ ○ /checkout               9.8 kB   121 kB\r\n└ ƒ /api/cart               0 B      0 B\r\n"),
    ("lib2", "terraform plan", "sops", "Ops", infra, ["terraform init", "terraform plan"], "ok", 9,
     f"Terraform will perform the following actions:\r\n\r\n  {G}+{R} aws_s3_bucket.assets\r\n  ~ aws_ecs_service.api (desired_count 2 → 3)\r\n\r\nPlan: {G}1 to add{R}, 1 to change, 0 to destroy.\r\n"),
    ("lib3", "ssh staging", "sops", "Ops", H, ["ssh staging", "tail -f /var/log/app.log"], "idle", 26,
     f"{Dm}Last login: Sat Nov  1 09:14:02 2026{R}\r\ndeploy@staging:~$ tail -f /var/log/app.log\r\n[info] GET /health 200 2ms\r\n[info] POST /v1/orders 201 31ms\r\n"),
    ("lib4", "pnpm lint", "spers", "Personal", blog, ["pnpm lint"], "fail", 50,
     f"{Rd}✖ 2 problems (2 errors, 0 warnings){R}\r\n  src/post.ts:14  'date' is assigned a value but never used\r\n"),
]
index = []
for i, name, sid, sname, cwd, cmds, status, ago, body in entries:
    at = now - ago * 3600000
    index.append({"id": i, "name": name, "spaceId": sid, "spaceName": sname, "cwd": cwd, "host": "local", "status": status,
                  "exitCode": {"ok": 0, "fail": 1}.get(status), "startedAt": at - 3600000, "endedAt": at, "idleSince": at,
                  "reason": "idle", "commands": [{"cmd": c, "exit": 0, "at": at} for c in cmds], "lines": 0, "bytes": len(body)})
    write(f"{data}/library/{i}.ans", body)
write(f"{data}/library/index.json", json.dumps(index))
print(root)
