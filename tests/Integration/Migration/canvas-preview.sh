#!/usr/bin/env bash
set -euo pipefail
umask 077

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
cd "$repo"
pg=${PG_TOOLS_DIR:-/opt/homebrew/opt/postgresql@18/bin}
migrate=${FSUSBLOG_TEST_MIGRATE_DLL:-$repo/src/Migrate/bin/Release/net10.0/FsusBlogV2.Migrate.dll}
scratch=$(mktemp -d /tmp/fsus-canvas-upgrade.XXXXXX)
evidence=${FSUSBLOG_TEST_EVIDENCE:-$scratch}
mkdir -p "$evidence" "$scratch/socket"
trap 'if "$pg/pg_ctl" -D "$scratch/data" status >/dev/null 2>&1; then "$pg/pg_ctl" -D "$scratch/data" -m fast -w stop >/dev/null; fi; rm -rf -- "$scratch"' EXIT
"$pg/initdb" -D "$scratch/data" -U fsusqa --auth-local=trust --auth-host=reject --locale=C -E UTF8 > "$evidence/initdb.log"
"$pg/pg_ctl" -D "$scratch/data" -l "$evidence/postgres.log" -o "-c listen_addresses='' -k $scratch/socket -p 54933" -w start
export FSUSBLOG_DB="Host=$scratch/socket;Port=54933;Username=fsusqa;Database=postgres;SSL Mode=Disable"
psql=("$pg/psql" -X -v ON_ERROR_STOP=1 -h "$scratch/socket" -p 54933 -U fsusqa -d postgres)
cli=(dotnet "$migrate")
"${cli[@]}" plan > "$evidence/current-plan.json"
"${cli[@]}" apply "$evidence/current-plan.json" > "$evidence/initial-apply.log"
"${cli[@]}" canvas-graph check > "$evidence/current.json"
"${cli[@]}" canvas-graph apply-empty > "$evidence/current-repeat.json"
cmp "$evidence/current.json" "$evidence/current-repeat.json"

# Installing the two history tables must not rewrite an already current graph.
"${psql[@]}" -c 'DROP TABLE public.canvas_history_transition, public.canvas_history_patch' >/dev/null
"${cli[@]}" canvas-graph check > "$evidence/history-ready.json"
grep -q '"status": "history-ready"' "$evidence/history-ready.json"
"${cli[@]}" canvas-graph apply-empty > "$evidence/history-added.json"
cmp "$evidence/current.json" "$evidence/history-added.json"

# Replay the physical pre-graph schema kept by the exact repository checkpoint.
git show 9cec6aa^:src/Migrate/canvas.sql > "$scratch/legacy.sql"
"${psql[@]}" -c 'DROP TABLE public.canvas_history_transition, public.canvas_history_patch, public.canvas_link_plan, public.canvas_document_event, public.canvas_edge, public.canvas_node, public.authoring_canvas' >/dev/null
"${psql[@]}" -f "$scratch/legacy.sql" >/dev/null
"${cli[@]}" canvas-graph check > "$evidence/empty-legacy.json"

# Ordinary PostgreSQL dependencies are a second boundary alongside the catalog.
"${psql[@]}" -c 'CREATE VIEW public.preview_canvas_dependency AS SELECT id FROM public.authoring_canvas' >/dev/null
if "${cli[@]}" canvas-graph apply-empty > "$evidence/dependency.log" 2>&1; then
  printf 'Canvas upgrade unexpectedly deleted a dependent view.\n' >&2
  exit 1
fi
"${cli[@]}" canvas-graph check > "$evidence/after-dependency.json"
cmp "$evidence/empty-legacy.json" "$evidence/after-dependency.json"
"${psql[@]}" -c 'DROP VIEW public.preview_canvas_dependency' >/dev/null

# The serving process guard blocks a second schema authority without touching Canvas.
"${psql[@]}" -c "SELECT pg_advisory_lock(716729109726707501); SELECT pg_sleep(4);" > "$scratch/lease.log" &
lease=$!
for attempt in {1..40}; do
  if [[ $("${psql[@]}" -Atc 'SELECT count(*) FROM pg_locks WHERE locktype = '\''advisory'\'' AND granted') -gt 0 ]]; then break; fi
  sleep .05
done
if "${cli[@]}" canvas-graph apply-empty > "$evidence/active-lease.log" 2>&1; then
  printf 'Canvas upgrade unexpectedly proceeded under a serving lease.\n' >&2
  exit 1
fi
wait "$lease"
grep -q 'Stop the serving process' "$evidence/active-lease.log"

"${cli[@]}" canvas-graph apply-empty > "$evidence/upgraded.json"
cmp "$evidence/current.json" "$evidence/upgraded.json"
"${cli[@]}" verify > "$evidence/verified-current.log"

# A populated exact preview retains article/revision/plan coordinates and all digests.
"${psql[@]}" -c 'DROP TABLE public.canvas_history_transition, public.canvas_history_patch, public.canvas_link_plan, public.canvas_document_event, public.canvas_edge, public.canvas_node, public.authoring_canvas' >/dev/null
"${psql[@]}" -f "$scratch/legacy.sql" >/dev/null
"${psql[@]}" <<'SQL' >/dev/null
begin;
insert into public.blog_user(id,name,can_author,enabled,generation)
values('11111111-1111-1111-1111-111111111111','Preview owner',true,true,1);
insert into public.article(id,owner_id,revision,title,body,deleted)
overriding system value values
 (101,'11111111-1111-1111-1111-111111111111',2,'Private source','Private source body',false),
 (102,'11111111-1111-1111-1111-111111111111',1,'Private reference','Private reference body',false);
insert into public.article_revision(article_id,revision,title,body,happened_at)
values (101,1,'Original source','Private source body',now()), (101,2,'Private source','Private source body',now()),
 (102,1,'Private reference','Private reference body',now());
insert into public.authoring_canvas(id,owner_id,revision)
values('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111',2);
insert into public.canvas_edge(canvas_id,id,article_id,target_article_id,explicit_reference)
values('22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333',101,102,true);
insert into public.canvas_link_plan(id,canvas_id,edge_id,canvas_revision,host_revision,target_revision,source_offset,
 insert_digest,session_digest,session_generation,expires_at,applied_article_id,applied_revision,applied_canvas_revision)
values('44444444-4444-4444-4444-444444444444','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333',
 1,1,1,0,decode(repeat('12',32),'hex'),decode(repeat('34',32),'hex'),1,now(),101,2,2);
commit;
SQL
before=$("${psql[@]}" -Atc 'SELECT md5(row_to_json(p)::text) FROM public.canvas_link_plan p')
"${cli[@]}" canvas-graph check > "$evidence/populated.json"
if "${cli[@]}" canvas-graph apply-empty > "$evidence/preserved.json" 2> "$evidence/preserved.log"; then
  printf 'Canvas upgrade unexpectedly accepted private legacy rows.\n' >&2
  exit 1
fi
after=$("${psql[@]}" -Atc 'SELECT md5(row_to_json(p)::text) FROM public.canvas_link_plan p')
[[ "$before" == "$after" ]]
cmp "$evidence/populated.json" "$evidence/preserved.json"
python3 - "$evidence" <<'PY'
import json, sys
from pathlib import Path
evidence = Path(sys.argv[1])
report = json.loads((evidence / "populated.json").read_text())
assert report["status"] == "preserve-legacy-rows"
assert report["legacy"] == dict(documents=1, authors=1, earliestRevision=2, latestRevision=2,
                             edges=1, explicitEdges=1, plans=1, appliedPlans=1, incompletePlanReceipts=0)
assert "Session" not in str(report)
assert "11111111" not in str(report) and "Private source" not in str(report)
assert json.loads((evidence / "empty-legacy.json").read_text())["status"] == "empty-legacy-ready"
PY

"${psql[@]}" -c 'ALTER TABLE public.canvas_edge ADD COLUMN arbitrary_payload text' >/dev/null
if "${cli[@]}" canvas-graph check > "$evidence/unknown.log" 2>&1; then
  printf 'Canvas upgrade unexpectedly admitted an unknown catalog.\n' >&2
  exit 1
fi
grep -q 'shape mismatch' "$evidence/unknown.log"
printf 'Verified exact old/current Canvas schemas, rollback, live lease gating, private preservation and unknown-shape rejection.\n'
