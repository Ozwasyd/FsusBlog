#!/usr/bin/env bash
# Compare real Chromium cold/warm browser search sessions for server vs local modes
# against a disposable PostgreSQL 18 database seeded with tests/Performance/SearchEval/corpus.v1.json.
set -euo pipefail
umask 077
export LC_ALL=C

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo"

out_dir=${1:?Usage: search-eval-browser.sh OUTPUT_DIR}
mkdir -p "$out_dir"
out_dir=$(cd -- "$out_dir" && pwd)

pg=${PG_TOOLS_DIR:-/opt/homebrew/bin}
if [[ ! -x "$pg/postgres" ]] && [[ -x /opt/homebrew/opt/postgresql@18/bin/postgres ]]; then
  pg=/opt/homebrew/opt/postgresql@18/bin
fi
for tool in initdb pg_ctl psql postgres; do
  [[ -x "$pg/$tool" ]] || { echo "Missing PostgreSQL tool: $pg/$tool" >&2; exit 2; }
done

scratch=$(mktemp -d /tmp/fsus-search-browser.XXXXXX)
server_pid=
pg_started=0
cleanup() {
  local code=$?
  trap - EXIT
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" || true
    wait "$server_pid" 2>/dev/null || true
  fi
  if (( pg_started )); then
    "$pg/pg_ctl" -D "$scratch/data" -m fast -w stop >/dev/null 2>&1 || true
  fi
  rm -rf -- "$scratch" || true
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$scratch/socket"
"$pg/initdb" -D "$scratch/data" -U fsusqa --auth-local=trust --auth-host=reject --locale=C -E UTF8 > "$scratch/initdb.log"
pg_started=1
"$pg/pg_ctl" -D "$scratch/data" -l "$scratch/postgres.log" \
  -o "-c listen_addresses='' -k $scratch/socket -p 55439 -c unix_socket_permissions=0700" -w start

export FSUSBLOG_DB="Host=$scratch/socket;Port=55439;Username=fsusqa;Database=postgres;SSL Mode=Disable"
cli="$repo/src/Cli/bin/Release/net10.0/FsusBlog.V2.Cli.dll"
srv="$repo/src/Server/bin/Release/net10.0/FsusBlog.V2.Server.dll"
[[ -s "$cli" && -s "$srv" ]] || { echo "Build Release solution first." >&2; exit 2; }
[[ -s "$repo/src/Web/dist/index.html" ]] || { echo "Build src/Web first." >&2; exit 2; }

dotnet "$cli" plan > "$scratch/plan.json"
dotnet "$cli" apply "$scratch/plan.json" > "$scratch/apply.log"
dotnet "$cli" verify > "$scratch/verify.log"

python3 - "$repo/tests/Performance/SearchEval/corpus.v1.json" "$scratch/seed.sql" <<'PY'
import json, sys
corpus = json.load(open(sys.argv[1], encoding="utf-8"))
def esc(s): return "'" + s.replace("'", "''") + "'"
lines = [
    "BEGIN;",
    "INSERT INTO public.admin_principal (id,handle,user_handle,enabled,generation) "
    "VALUES ('5e3986ac-4d8e-5c55-91f6-202611140044','eval-author',decode(repeat('22',32),'hex'),true,1);",
]
cats = {}
tags = {}
for a in corpus["articles"]:
    if a.get("category"): cats[a["category"]["id"]] = a["category"]["name"]
    for t in a.get("tags") or []: tags[t["id"]] = t["name"]
for cid, name in sorted(cats.items()):
    lines.append(f"INSERT INTO public.category (id,name) OVERRIDING SYSTEM VALUE VALUES ({cid},{esc(name)});")
for tid, name in sorted(tags.items()):
    lines.append(f"INSERT INTO public.tag (id,name) OVERRIDING SYSTEM VALUE VALUES ({tid},{esc(name)});")
    lines.append(f"INSERT INTO public.tag_url_name (name_key,tag_id) VALUES ({esc(name)},{tid});")
for a in corpus["articles"]:
    aid = a["id"]
    lines.append(
        "INSERT INTO public.article (id,owner_id,revision,title,body,published_revision,publication_count,deleted,created_at,updated_at) "
        f"OVERRIDING SYSTEM VALUE VALUES ({aid},'5e3986ac-4d8e-5c55-91f6-202611140044',1,{esc(a['title'])},{esc(a['body'])},1,1,false,{esc(a['createdAt'])},{esc(a['updatedAt'])});"
    )
    lines.append(
        "INSERT INTO public.article_revision (article_id,revision,title,body,author_summary,happened_at) "
        f"VALUES ({aid},1,{esc(a['title'])},{esc(a['body'])},{esc(a.get('summary') or '')},{esc(a['updatedAt'])});"
    )
    if a.get("category"):
        lines.append(f"INSERT INTO public.article_revision_category (article_id,revision,category_id) VALUES ({aid},1,{a['category']['id']});")
    for t in a.get("tags") or []:
        lines.append(f"INSERT INTO public.article_revision_tag (article_id,revision,tag_id) VALUES ({aid},1,{t['id']});")
    lines.append(
        f"INSERT INTO public.article_publication (article_id,publication_id,revision,publication_no,published_at) "
        f"OVERRIDING SYSTEM VALUE VALUES ({aid},{a['publication']},1,1,{esc(a['publishedAt'])});"
    )
lines.append("COMMIT;")
open(sys.argv[2], "w", encoding="utf-8").write("\n".join(lines) + "\n")
PY

"$pg/psql" -X -v ON_ERROR_STOP=1 -h "$scratch/socket" -p 55439 -U fsusqa -d postgres \
  -f "$scratch/seed.sql" -f "$repo/tests/Fixtures/publication-rights.sql" > "$scratch/seed.log"

run_mode() {
  local mode=$1 port=$2
  local origin="http://127.0.0.1:$port"
  FSUSBLOG_WEB_DIST="$repo/src/Web/dist" \
  FSUSBLOG_PUBLIC_SEARCH_MODE="$mode" \
  ASPNETCORE_URLS="$origin" \
    dotnet "$srv" > "$scratch/server-$mode.log" 2>&1 &
  server_pid=$!
  for ((i=0; i<100; i++)); do
    if curl -sf "$origin/search" >/dev/null 2>&1; then break; fi
    sleep 0.1
  done
  curl -sf "$origin/search" >/dev/null
  node "$repo/tests/Performance/search-eval-browser.mjs" --origin "$origin" --mode "$mode" --out "$out_dir/browser-$mode.json"
  kill "$server_pid" || true
  wait "$server_pid" 2>/dev/null || true
  server_pid=
}

run_mode server 55481
run_mode local 55482
python3 - "$out_dir/browser-server.json" "$out_dir/browser-local.json" <<'PY'
import json, sys
for path in sys.argv[1:]:
    d = json.load(open(path, encoding="utf-8"))
    print(f"browser mode={d['mode']}: coldFirstMs={d['coldFirstSearchMedianMs']:.2f} "
          f"warmFollowupMs={d['warmFollowupMedianMs']:.2f} coldBytes={d['coldFirstSearchBytesMedian']} "
          f"workers={d['workersStartedPerSession']} corpusReqs={d['corpusRequestsPerSession']} idb={d['idbDatabases']}")
PY
