#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$repo"

export PATH="/opt/homebrew/opt/postgresql@18/bin:/usr/local/opt/postgresql@18/bin:$PATH"
export LC_ALL=C

usage() {
  cat <<'EOF'
Usage: ./tools/dev.sh [options]

Starts an isolated local development stack with hot reload:
  - Persistent PostgreSQL 18 cluster in .dev-data/pgdata (port 55432 by default)
  - FsusBlog.V2.Server via dotnet watch (http://127.0.0.1:5080 by default)
  - Vite HMR dev server consuming @ozwasyd/element-plus (unified single-origin http://localhost:5173)

Options:
  --reset          Wipe .dev-data/ and initialize a fresh database before starting
  --seed           Idempotently seed demo articles, taxonomy, comments, read counts, traffic stats, and an inbox thread
  --admin-session  Provision a local dev Passkey fixture + 24h admin cookie in .dev-data/
  --db-only        Start only PostgreSQL + initialized schema/data dir (for IDE F5 debugging)
  --no-watch       Use dotnet run instead of dotnet watch for the backend
  -h, --help       Show this help message

Environment overrides:
  FSUS_DEV_PG_PORT     PostgreSQL port (default: 55432)
  FSUS_DEV_API_PORT    Backend Kestrel port (default: 5080)
  FSUS_DEV_WEB_PORT    Vite dev server port (default: 5173)
  DOTNET_BIN           .NET SDK command (default: dotnet)
EOF
}

reset_db=0
seed_demo=0
dev_admin_session=0
db_only=0
use_watch=1

while (($# > 0)); do
  case "$1" in
    --reset) reset_db=1 ;;
    --seed) seed_demo=1 ;;
    --admin-session) dev_admin_session=1 ;;
    --db-only) db_only=1 ;;
    --no-watch) use_watch=0 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

dotnet_bin="${DOTNET_BIN:-dotnet}"
pg_port="${FSUS_DEV_PG_PORT:-55432}"
api_port="${FSUS_DEV_API_PORT:-5080}"
web_port="${FSUS_DEV_WEB_PORT:-5173}"
dev_root="$repo/.dev-data"
pg_data="$dev_root/pgdata"
pg_sock="$dev_root/pgsock"
site_data="$dev_root/site-data"
secrets_file="$dev_root/secrets.env"
db_name="fsusblog_dev"

required_tools=("$dotnet_bin" initdb pg_ctl createdb psql openssl)
(( db_only )) || required_tools+=(pnpm)
for cmd in "${required_tools[@]}"; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    printf 'Missing required tool: %s\n' "$cmd" >&2
    exit 1
  fi
done

started_pg=0
server_pid=""
web_pid=""

stop_pg() {
  pg_ctl -D "$pg_data" -m fast stop >/dev/null 2>&1 || true
}

write_secret() {
  umask 077
  cat > "$1"
  chmod 600 "$1"
}

cleanup() {
  local code=$? pid
  trap - EXIT INT TERM
  for pid in "$web_pid" "$server_pid"; do
    if [[ -n "$pid" ]]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  if (( started_pg )); then stop_pg; fi
  exit "$code"
}
trap cleanup EXIT INT TERM

if (( reset_db )); then
  if [[ -f "$pg_data/postmaster.pid" ]]; then stop_pg; fi
  chmod -R u+w -- "$dev_root" 2>/dev/null || true
  rm -rf -- "$dev_root"
fi

mkdir -p "$dev_root" "$pg_sock" "$site_data"
chmod 700 "$dev_root" "$site_data"

# Ensure baseline static site-pages exist so /about, /privacy, /guidelines, /copyright and the editor work out-of-the-box.
site_pages_dir="$site_data/site-pages"
if [[ ! -d "$site_pages_dir" ]]; then
  mkdir -p "$site_pages_dir"
  while IFS='|' read -r slug heading body; do
    printf '# %s\n\n%s\n' "$heading" "$body" > "$site_pages_dir/$slug.md"
  done <<'EOF'
about|About|Local FsusBlog v2 development instance.
privacy|Privacy|Local development privacy placeholder.
guidelines|Guidelines|Local development community guidelines placeholder.
copyright|Copyright|Local development copyright notice placeholder.
EOF
fi

# Seed a real ECDSA P-256 signed local dev appearance registry when --seed is enabled so /admin/site appearance switching works out-of-the-box.
appearance_dir="$site_data/appearance"
if (( seed_demo )) && [[ ! -f "$appearance_dir/appearance.json" ]] && command -v python3 >/dev/null 2>&1; then
  printf '[dev] Provisioning signed demo appearance packages in %s...\n' "$appearance_dir"
  python3 -B - "$appearance_dir" <<'PY'
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
import sys

sys.path.insert(0, "tools")
from fixture_signing import AppearancePackages

root = Path(sys.argv[1])
root.mkdir(mode=0o700, exist_ok=True)
root.chmod(0o700)

def write_readonly(name: str, data: bytes) -> None:
    target = root / name
    target.write_bytes(data)
    target.chmod(0o400)

now = datetime.now(timezone.utc)
with TemporaryDirectory() as tmp:
    temp = Path(tmp)
    key = temp / "dev-publisher.pem"
    packages = AppearancePackages(key, "dev.local", "dev-1", "signature/dev", "trust/dev", write_readonly, allow_tail=True)
    themes = [
        ("editorial-moss", "dev.editorial-moss", "1.0.0", dict(LightAccent="#225533", LightHover="#1b4429", DarkAccent="#8ce0a8", DarkHover="#b3edd0")),
        ("warm-terracotta", "dev.warm-terracotta", "1.0.0", dict(LightAccent="#7c2d12", LightHover="#66240e", DarkAccent="#f5b895", DarkHover="#fad0b6")),
    ]
    for slug, pkg_id, version, palette in themes:
        manifest = dict(
            Format=1, Kind="theme", Id=pkg_id, Version=version, Publisher="dev.local",
            SignatureReference="signature/dev", TrustPolicyReference="trust/dev", Theme=palette
        )
        packages.add(slug, manifest, {})
    packages.finish(now - timedelta(hours=1), now + timedelta(days=30), None, None, None, indent=2)
PY
fi

# Seed an RFC 5737 / RFC 3849 documentation-only offline traffic region map when --seed is enabled
# so /admin/site renders the seeded region ranking on local loopback dev without matching public IPs.
traffic_regions_file="$site_data/traffic-regions.json"
if (( seed_demo )) && [[ ! -f "$traffic_regions_file" ]]; then
  printf '[dev] Provisioning demo offline traffic region map in %s...\n' "$traffic_regions_file"
  cat > "$traffic_regions_file" <<'JSON'
[
  { "cidr": "192.0.2.0/24", "region": "CN-SH" },
  { "cidr": "198.51.100.0/24", "region": "CN-BJ" },
  { "cidr": "203.0.113.0/24", "region": "US" },
  { "cidr": "2001:db8::/32", "region": "JP" }
]
JSON
  chmod 600 "$traffic_regions_file"
fi

# Build CLI & Server incrementally (Debug for fast inner loop and IDE symbol alignment).
if [[ ! -f "$repo/src/Cli/obj/project.assets.json" ]] || [[ ! -f "$repo/src/Server/obj/project.assets.json" ]]; then
  printf '[dev] Restoring .NET solution (locked mode)...\n'
  "$dotnet_bin" restore FsusBlog.V2.slnx --configfile NuGet.Config --locked-mode >/dev/null
fi
printf '[dev] Building FsusBlog.V2.Cli and FsusBlog.V2.Server (Debug)...\n'
for proj in Cli Server; do
  "$dotnet_bin" build "src/$proj/FsusBlog.V2.$proj.csproj" -c Debug --no-restore -v quiet >/dev/null
done
cli=("$dotnet_bin" "$repo/src/Cli/bin/Debug/net10.0/FsusBlog.V2.Cli.dll")

# Persist local development secrets across restarts.
if [[ ! -f "$secrets_file" ]]; then
  "${cli[@]}" init-secrets | write_secret "$secrets_file"
fi
# shellcheck disable=SC1090
source "$secrets_file"

# Start or reuse persistent local PG 18 cluster.
if [[ ! -d "$pg_data/base" ]]; then
  printf '[dev] Initializing PostgreSQL 18 cluster in %s...\n' "$pg_data"
  initdb -D "$pg_data" -U postgres --auth=trust --encoding=UTF8 --locale=C >/dev/null
fi

if ! pg_ctl -D "$pg_data" status >/dev/null 2>&1; then
  printf '[dev] Starting PostgreSQL 18 on 127.0.0.1:%s...\n' "$pg_port"
  pg_ctl -D "$pg_data" -l "$dev_root/postgres.log" \
    -o "-p $pg_port -k $pg_sock -h 127.0.0.1" start >/dev/null
  started_pg=1
else
  printf '[dev] Reusing running PostgreSQL cluster in %s.\n' "$pg_data"
fi

export FSUSBLOG_DB="Host=127.0.0.1;Port=$pg_port;Username=postgres;Database=$db_name"
psql_base=(psql -X -q --no-password -h 127.0.0.1 -p "$pg_port" -U postgres -v ON_ERROR_STOP=1)
psql_db=("${psql_base[@]}" -d "$db_name")

db_exists=$("${psql_base[@]}" -At -d postgres -c "SELECT 1 FROM pg_database WHERE datname = '$db_name'")
if [[ "$db_exists" != "1" ]]; then
  createdb -h 127.0.0.1 -p "$pg_port" -U postgres -T template0 "$db_name"
  printf '[dev] Applying FsusBlog V2 schema via FsusBlog.V2.Cli...\n'
  "${cli[@]}" plan > "$dev_root/plan.json"
  "${cli[@]}" apply "$dev_root/plan.json"
fi

"${cli[@]}" verify >/dev/null

admin_bootstrap_key=""
reader_login_ticket=""
dev_admin_cookie=""

db_empty() {
  [[ "$("${psql_db[@]}" -Atc "SELECT count(*) FROM $1")" == "0" ]]
}

ensure_dev_admin() {
  if db_empty "public.admin_principal WHERE handle = 'dev-admin'"; then
    admin_bootstrap_key=$("${cli[@]}" admin-identity bootstrap dev-admin)
  fi
}

apply_seed_sql() {
  "${psql_db[@]}" >/dev/null
  "${cli[@]}" verify >/dev/null
}

if (( seed_demo )); then
  printf '[dev] Ensuring demo seed data...\n'
  ensure_dev_admin

  if db_empty "public.blog_user WHERE name = 'dev-reader'"; then
    reader_login_ticket=$("${cli[@]}" operator dev-reader)
    reader_id=$("${psql_db[@]}" -Atc "SELECT id FROM public.blog_user WHERE name = 'dev-reader'")
    "${cli[@]}" comment handle "$reader_id" "Dev Reader" >/dev/null
  else
    reader_login_ticket=$("${cli[@]}" ticket dev-reader)
  fi

  if db_empty "public.article"; then
    # Feed publications and the unpublished draft to the same transaction in their original identity order.
    write_demo_article() {
      local ordinal=$1 age=$2 summary=${3:-} category=${4:-} tags=${5:-}
      local article="a$ordinal" revision="r$ordinal" command="c$ordinal" publication="p$ordinal"
      local pub_rev="NULL" pub_count="0" is_pub="false" summary_sql="NULL"
      if [[ -n "$summary" ]]; then
        pub_rev="1" pub_count="1" is_pub="true" summary_sql="'$summary'"
      fi
      cat <<SQL
WITH owner AS (
  SELECT id FROM public.admin_principal WHERE handle = 'dev-admin'
),
$article AS (
  INSERT INTO public.article (owner_id, revision, title, body, published_revision, publication_count, deleted, created_at, updated_at)
  SELECT id, 1,
SQL
      cat
      cat <<SQL
         $pub_rev, $pub_count, false, now() - interval '$age', now() - interval '$age'
  FROM owner RETURNING id, owner_id, title, body, created_at
),
$revision AS (
  INSERT INTO public.article_revision (article_id, revision, title, body, happened_at, author_summary)
  SELECT id, 1, title, body, created_at, $summary_sql FROM $article
  RETURNING article_id, revision, happened_at
),
$command AS (
  INSERT INTO public.article_command (actor_id, command_id, fingerprint, article_id, revision, title, body, published)
  SELECT $article.owner_id, gen_random_uuid(), pg_catalog.sha256(convert_to('seed-$article-r1', 'UTF8')), $article.id, 1, $article.title, $article.body, $is_pub FROM $article
  RETURNING actor_id, command_id, article_id, revision
)
SQL
      if [[ -n "$summary" ]]; then
        cat <<SQL
,
$publication AS (
  INSERT INTO public.article_publication (article_id, revision, publication_no, published_at)
  SELECT article_id, revision, 1, happened_at FROM $revision
  RETURNING article_id, publication_id, revision, publication_no, published_at
),
h$ordinal AS (
  INSERT INTO public.article_publication_history (article_id, event_no, revision, publication_no, publication_id, kind, reason, happened_at, actor_id, command_id)
  SELECT $publication.article_id, 1, $publication.revision, $publication.publication_no, $publication.publication_id, 'publish', 'author-published', $publication.published_at, $command.actor_id, $command.command_id
  FROM $publication JOIN $command ON $command.article_id = $publication.article_id
),
o$ordinal AS (
  INSERT INTO public.blog_outbox (article_id, revision, kind, created_at, processed_at)
  SELECT article_id, revision, 'publish', published_at, published_at FROM $publication
),
rr$ordinal AS (
  INSERT INTO public.article_revision_rights (article_id, revision, enabled, license_type, copyright_holder, copyright_year, rights_statement, attribution_template, copy_policy, max_excerpt_chars, allow_code_copy, show_public_badge, proof_binding_enabled)
  SELECT article_id, revision, true, 'CC-BY-4.0', 'FsusBlog Dev', 2026, 'Licensed under CC-BY-4.0.', '{title}', 'append-attribution', 300, true, true, false FROM $revision
),
pr$ordinal AS (
  INSERT INTO public.article_publication_rights (article_id, publication_id, revision)
  SELECT article_id, publication_id, revision FROM $publication
),
cat$ordinal AS (
  INSERT INTO public.article_revision_category (article_id, revision, category_id)
  SELECT $revision.article_id, $revision.revision, cat.id FROM $revision, public.category cat WHERE cat.name = '$category'
),
tag$ordinal AS (
  INSERT INTO public.article_revision_tag (article_id, revision, tag_id)
  SELECT $revision.article_id, $revision.revision, t.id FROM $revision, public.tag t WHERE t.name IN ($tags)
),
cw$ordinal AS (
  INSERT INTO public.comment_public_write (article_id) SELECT id FROM $article
)
SQL
      fi
      printf 'SELECT 1;\n\n'
    }

    {
      cat <<'SQL'
BEGIN;

INSERT INTO public.category (name, description) VALUES
  ('Engineering', 'Architecture, binary protocols, and systems engineering.'),
  ('Essays', 'Notes on writing, minimalism, and web craftsmanship.');

INSERT INTO public.tag (name, description) VALUES
  ('dotnet', '.NET 10 and C# 14 backend runtime'),
  ('postgresql', 'PostgreSQL 18 schema and storage'),
  ('vue', 'Vue 3 and FsusUI workspace'),
  ('aeds', 'AEDS v2 binary framing');

INSERT INTO public.tag_url_name (name_key, tag_id)
SELECT lower(name), id FROM public.tag;

SQL
      write_demo_article 1 '3 days' \
        '介绍 FsusBlog v2 本地开发架构、Vite HMR 联动 FsusUI 与 AEDS 帧调试方式。' \
        Engineering "'dotnet', 'postgresql', 'aeds'" <<'ARTICLE'
         'FsusBlog v2 本地开发与 AEDS 二进制协议导览',
         E'## 欢迎使用 FsusBlog v2\n\n这是一篇用于本地热重载与调试的示例文章。\n\n- 后端运行在 `.NET 10` + `PostgreSQL 18`\n- 前端通过 Vite HMR 消费 `@ozwasyd/element-plus` 组件与原生 Markdown Wasm\n- 全部运行时业务接口均采用 `AEDS v2` 二进制帧\n\n```ts\n// 在浏览器控制台开启 AEDS 二进制帧调试日志\nwindow.__fsusDebug?.aeds(true)\n```\n',
ARTICLE
      write_demo_article 2 '1 day' \
        'Notes on reading typography, FsusUI token discipline, and live local iteration.' \
        Essays "'vue'" <<'ARTICLE'
         'Designing for Quiet Restraint in Reading Interfaces',
         E'## Intellectual Minimalism\n\nGood editorial software stays out of the reader''s way. Clear hierarchy, crisp spacing, and deterministic interactions matter more than ornamental chrome.\n\n### Local Live Editing\n\nEdit any file under `src/Web/src/` and watch Vite HMR update the page instantaneously.\n',
ARTICLE
      # Seed one unpublished draft visible inside /admin/articles.
      write_demo_article 3 '2 hours' <<'ARTICLE'
         '未发布草稿：编辑器与 Canvas 调试沙箱',
         E'这是一篇尚未发布的草稿，可在管理后台 `/admin/articles` 中直接编辑或发布。\n',
ARTICLE
      cat <<'SQL'

-- Seed one approved public comment and one pending comment for /admin/interaction moderation queue.
WITH first_article AS (
  SELECT id FROM public.article WHERE published_revision IS NOT NULL ORDER BY id ASC LIMIT 1
),
reader AS (
  SELECT id FROM public.blog_user WHERE name = 'dev-reader'
),
seed_comments(id, status, body, age, mod_ver, tag) AS (
  VALUES
    (1::bigint, 1, '本地开发环境跑起来非常丝滑，AEDS 帧调试也清楚多了。', interval '6 hours', 2, 'seed-c1'),
    (2::bigint, 0, '这是一条待审核测试评论，可在后台 Interaction -> Moderation queue 中体验审核流程。', interval '30 minutes', 1, 'seed-c2')
),
inserted AS (
  INSERT INTO public.comment (article_id, id, parent_id, root_id, parent_depth, reply_to_id, depth, moderation_status, deleted, body, author_mode, display_name, display_language, created_at, moderation_version)
  SELECT first_article.id, s.id, NULL, s.id, NULL, NULL, 0, s.status, false, s.body, 3, 'Dev Reader', 'zh-CN', now() - s.age, s.mod_ver
  FROM first_article CROSS JOIN seed_comments s
  RETURNING article_id, id
),
cmds AS (
  INSERT INTO public.comment_submit_command (user_id, command_id, fingerprint, article_id, comment_id)
  SELECT reader.id, gen_random_uuid(), pg_catalog.sha256(convert_to(s.tag, 'UTF8')), i.article_id, i.id
  FROM reader CROSS JOIN inserted i JOIN seed_comments s ON s.id = i.id
)
INSERT INTO public.comment_account_owner (article_id, comment_id, user_id)
SELECT i.article_id, i.id, reader.id FROM inserted i CROSS JOIN reader;

SELECT setval(pg_get_serial_sequence('public.comment', 'id'), (SELECT COALESCE(max(id), 1) FROM public.comment));

-- Seed one reader support inbox thread visible in /user/messagebox and /admin/interaction.
WITH reader AS (
  SELECT id FROM public.blog_user WHERE name = 'dev-reader'
),
conv AS (
  INSERT INTO public.inbox_conversation (account_id, subject, status, is_system, last_message_at)
  SELECT id, '本地联调测试工单', 0, false, now() - interval '20 minutes' FROM reader
  RETURNING id, account_id, last_message_at
),
msg AS (
  INSERT INTO public.inbox_message (conversation_id, sender, is_internal, body, sent_at)
  SELECT id, 0, false, '你好，这是一条用于验证站内信与后台支持收件箱实时联调的示例消息。', last_message_at FROM conv
  RETURNING conversation_id, id, sent_at
),
deliv AS (
  INSERT INTO public.inbox_delivery (account_id, last_sequence)
  SELECT account_id, 1 FROM conv
  ON CONFLICT (account_id) DO UPDATE SET last_sequence = public.inbox_delivery.last_sequence + 1
  RETURNING account_id, last_sequence
)
INSERT INTO public.inbox_event (account_id, sequence, kind, conversation_id, message_id, occurred_at)
SELECT deliv.account_id, deliv.last_sequence, 12, msg.conversation_id, msg.id, msg.sent_at
FROM deliv, msg;

UPDATE public.inbox_conversation c
SET last_message_id = (SELECT max(m.id) FROM public.inbox_message m WHERE m.conversation_id = c.id)
WHERE c.last_message_id IS NULL;

COMMIT;
SQL
    } | apply_seed_sql
  fi

  if db_empty "public.article_read_total"; then
    apply_seed_sql <<'SQL'
BEGIN;

-- Seed consistent verified read counts for the first two published articles so the homepage
-- "Popular articles" section displays realistic demo counts on local HTTP dev.
WITH ranked AS (
  SELECT id, row_number() OVER (ORDER BY id ASC) AS seq
  FROM public.article
  WHERE published_revision IS NOT NULL AND NOT deleted
),
seeded_totals AS (
  INSERT INTO public.article_read_total (article_id, views)
  SELECT id, CASE seq WHEN 1 THEN 128 WHEN 2 THEN 74 END
  FROM ranked
  WHERE seq <= 2
  ON CONFLICT (article_id) DO NOTHING
  RETURNING article_id
),
seeded_hours AS (
  INSERT INTO public.article_read_hour (article_id, hour_utc, count)
  SELECT r.id, date_trunc('hour', now(), 'UTC') - make_interval(hours => v.hours_ago), v.cnt
  FROM ranked r
  JOIN (VALUES
    (1, 26, 21::bigint), (1, 18, 34::bigint), (1,  8, 45::bigint), (1,  2, 28::bigint),
    (2, 20, 19::bigint), (2, 10, 24::bigint), (2,  3, 31::bigint)
  ) AS v(seq, hours_ago, cnt) ON v.seq = r.seq
  WHERE EXISTS (SELECT 1 FROM seeded_totals st WHERE st.article_id = r.id)
  ON CONFLICT (article_id, hour_utc) DO NOTHING
),
seeded_dwell AS (
  INSERT INTO public.article_read_dwell (article_id, day_utc, bucket, count)
  SELECT r.id, ((now() AT TIME ZONE 'UTC')::date - v.days_ago), v.bucket, v.cnt
  FROM ranked r
  JOIN (VALUES
    (1, 1, 0,  9::bigint), (1, 1, 1, 18::bigint), (1, 1, 2, 19::bigint), (1, 1, 3,  9::bigint),
    (1, 0, 0, 11::bigint), (1, 0, 1, 22::bigint), (1, 0, 2, 26::bigint), (1, 0, 3, 14::bigint),
    (2, 1, 0,  4::bigint), (2, 1, 1,  7::bigint), (2, 1, 2,  5::bigint), (2, 1, 3,  3::bigint),
    (2, 0, 0,  9::bigint), (2, 0, 1, 18::bigint), (2, 0, 2, 17::bigint), (2, 0, 3, 11::bigint)
  ) AS v(seq, days_ago, bucket, cnt) ON v.seq = r.seq
  WHERE EXISTS (SELECT 1 FROM seeded_totals st WHERE st.article_id = r.id)
  ON CONFLICT (article_id, day_utc, bucket) DO NOTHING
)
UPDATE public.article_read_epoch
SET last_epoch = GREATEST(COALESCE(last_epoch, 0), floor(extract(epoch FROM (now() - interval '1 hour')) / 900)::bigint)
WHERE singleton AND EXISTS (SELECT 1 FROM seeded_totals);

COMMIT;
SQL
  fi

  if db_empty "public.site_traffic_daily WHERE day >= (now() AT TIME ZONE 'UTC')::date - 29"; then
    apply_seed_sql <<'SQL'
BEGIN;

-- Seed 7 days of sample site traffic aggregates (visible in /admin/site under HTTPS public origin or local loopback admin).
INSERT INTO public.site_traffic_daily (day, region, views)
SELECT ((now() AT TIME ZONE 'UTC')::date - v.days_ago), v.region, v.views
FROM (VALUES
  (6, 'CN-SH', 24::bigint), (6, 'CN-BJ', 14::bigint), (6, 'US',  8::bigint), (6, 'unknown', 5::bigint),
  (5, 'CN-SH', 31::bigint), (5, 'CN-BJ', 19::bigint), (5, 'JP',  7::bigint), (5, 'unknown', 6::bigint),
  (4, 'CN-SH', 28::bigint), (4, 'US',    12::bigint), (4, 'JP',  9::bigint), (4, 'unknown', 4::bigint),
  (3, 'CN-SH', 36::bigint), (3, 'CN-BJ', 22::bigint), (3, 'US', 15::bigint), (3, 'unknown', 7::bigint),
  (2, 'CN-SH', 42::bigint), (2, 'CN-BJ', 26::bigint), (2, 'JP', 11::bigint), (2, 'unknown', 8::bigint),
  (1, 'CN-SH', 39::bigint), (1, 'CN-BJ', 24::bigint), (1, 'US', 16::bigint), (1, 'JP',      9::bigint),
  (0, 'CN-SH', 33::bigint), (0, 'CN-BJ', 18::bigint), (0, 'US', 13::bigint), (0, 'unknown', 6::bigint)
) AS v(days_ago, region, views)
ON CONFLICT (day, region) DO NOTHING;

COMMIT;
SQL
  fi

  if db_empty "public.site_page_content WHERE revision > 0"; then
    apply_seed_sql <<'SQL'
BEGIN;

WITH p AS (
  SELECT id FROM public.admin_principal WHERE handle = 'dev-admin' LIMIT 1
), seeded(slug, markdown) AS (
  VALUES
    ('about', E'这是一个运行在 **FsusBlog V2** 上的本地演示站点，面向长期写作、可验证发布与极简阅读体验。\n\n## 技术特点\n\n- **AEDS v2 二进制协议**：前后端全链路使用强类型二进制帧传输，无冗余 JSON 兼容层。\n- **Fail-Closed 安全设计**：Passkey Step-Up、Scoped PoW 与严格 CSP 默认启用。\n- **即时在线编辑**：站点配置与固定页面可在 `/admin/site` 经 Passkey 验证后热刷新生效。\n\n> 提示：你现在就可以在管理后台的「站点页面」里修改本页内容，并实时预览 Markdown 渲染效果。\n'),
    ('privacy', E'本站坚持最小化数据收集原则，不嵌入第三方广告或跨站追踪脚本。\n\n## 数据处理说明\n\n1. **公开阅读**：浏览公开文章与归档无需注册，也不写入个人身份 Cookie。\n2. **通行密钥与会话**：仅在主动登录时保存必要的安全会话凭据。\n3. **评论与站内信**：仅用于站点互动展示及必要的反滥用防护。\n')
), updated AS (
  UPDATE public.site_page_content AS target
  SET revision = 1, markdown = seeded.markdown
  FROM seeded
  WHERE target.slug = seeded.slug AND target.revision = 0
  RETURNING target.slug, target.revision, target.markdown
)
INSERT INTO public.site_page_publish_audit (slug, revision, principal_id, previous_digest, next_digest, happened_at)
SELECT updated.slug, updated.revision, p.id, pg_catalog.sha256(''::bytea), pg_catalog.sha256(convert_to(updated.markdown, 'UTF8')), clock_timestamp()
FROM updated CROSS JOIN p;

COMMIT;
SQL
  fi
fi

# Opt-in local dev admin session (purely database-level fixture for dev-admin; zero server auth bypass).
if (( dev_admin_session )); then
  ensure_dev_admin
  dev_admin_cookie=$(openssl rand -hex 32)
  "${psql_db[@]}" -c "
    WITH p AS (
      SELECT id, generation FROM public.admin_principal WHERE handle = 'dev-admin'
    ), cred AS (
      INSERT INTO public.admin_passkey_credential (credential_id, principal_id, public_key, sign_count, backup_eligible, backed_up)
      SELECT decode('64657661646d696e', 'hex'), id, decode('64657661646d696e', 'hex'), 0, false, false FROM p
      ON CONFLICT (principal_id) DO NOTHING
    ), ret AS (
      DELETE FROM public.admin_session WHERE principal_id IN (SELECT id FROM p)
    ), si AS (
      INSERT INTO public.admin_sign_in (principal_id, started_at, expires_at)
      SELECT id, clock_timestamp(), clock_timestamp() + interval '24 hours' FROM p
      RETURNING principal_id, id
    )
    INSERT INTO public.admin_session (digest, principal_id, generation, expires_at, sign_in_id)
    SELECT pg_catalog.sha256(decode('$dev_admin_cookie', 'hex')), p.id, p.generation, clock_timestamp() + interval '24 hours', si.id
    FROM p JOIN si ON si.principal_id = p.id;
  "
  printf '%s\n' "$dev_admin_cookie" | write_secret "$dev_root/dev-admin-session.txt"
fi

export FSUSBLOG_DATA_DIR="$site_data"
export FSUSBLOG_ADMIN_ORIGIN="${FSUSBLOG_ADMIN_ORIGIN:-http://localhost:$web_port}"
export FSUSBLOG_ADMIN_RP_ID="${FSUSBLOG_ADMIN_RP_ID:-localhost}"
export FSUSBLOG_PASSKEY_ORIGIN="${FSUSBLOG_PASSKEY_ORIGIN:-http://localhost:$web_port}"
export FSUSBLOG_PASSKEY_RP_ID="${FSUSBLOG_PASSKEY_RP_ID:-localhost}"

if (( db_only )); then
  printf '\n=== FsusBlog V2 Local Dev PostgreSQL Ready ===\n'
  for var in FSUSBLOG_DB FSUSBLOG_DATA_DIR FSUSBLOG_ADMIN_ORIGIN FSUSBLOG_ADMIN_RP_ID FSUSBLOG_PASSKEY_ORIGIN FSUSBLOG_PASSKEY_RP_ID; do
    printf '  %s=%s\n' "$var" "${!var}"
  done
  [[ -n "$admin_bootstrap_key" ]] && printf '  Admin bootstrap key (dev-admin): %s\n' "$admin_bootstrap_key"
  [[ -n "$reader_login_ticket" ]] && printf '  Reader login ticket (dev-reader): %s\n' "$reader_login_ticket"
  [[ -n "$dev_admin_cookie" ]] && printf '  Dev admin cookie (fsus-v2-admin-session on localhost:%s): %s\n' "$web_port" "$dev_admin_cookie"
  printf '\nPress Ctrl+C to stop PostgreSQL (data persists in .dev-data/).\n'
  if (( started_pg )); then
    while true; do sleep 60; done
  fi
  exit 0
fi

export ASPNETCORE_ENVIRONMENT="Development"
export ASPNETCORE_URLS="http://127.0.0.1:$api_port"
export FSUSBLOG_WEB_DIST="$repo/src/Web"
[[ -f "$repo/src/Web/dist/index.html" ]] && FSUSBLOG_WEB_DIST="$repo/src/Web/dist"
[[ -n "${FSUSBLOG_PUBLIC_ORIGIN:-}" ]] && export FSUSBLOG_SUBSCRIPTION_HMAC_KEY || unset FSUSBLOG_SUBSCRIPTION_HMAC_KEY
[[ -n "${FSUSBLOG_PASSKEY_ORIGIN:-}" ]] && export FSUSBLOG_TOTP_KEY_HEX FSUSBLOG_RECOVERY_KEY_PEPPER_HEX || unset FSUSBLOG_TOTP_KEY_HEX FSUSBLOG_RECOVERY_KEY_PEPPER_HEX

printf '[dev] Starting FsusBlog.V2.Server on http://127.0.0.1:%s (%s)...\n' \
  "$api_port" "$( (( use_watch )) && echo 'dotnet watch' || echo 'dotnet run' )"
if (( use_watch )); then
  "$dotnet_bin" watch --non-interactive --project "$repo/src/Server/FsusBlog.V2.Server.csproj" \
    run --no-launch-profile -- --urls "http://127.0.0.1:$api_port" &
else
  "$dotnet_bin" run --no-launch-profile --no-build --project "$repo/src/Server/FsusBlog.V2.Server.csproj" \
    -- --urls "http://127.0.0.1:$api_port" &
fi
server_pid=$!

wait_for_dev_http() {
  local count=$1 url=$2 child=$3 failure=$4
  for _ in $(seq 1 "$count"); do
    if curl -s -o /dev/null "$url"; then break; fi
    if ! kill -0 "$child" 2>/dev/null; then
      printf '%s\n' "$failure" >&2
      exit 1
    fi
    sleep 0.25
  done
}

wait_for_dev_http 80 "http://127.0.0.1:$api_port/health/ready" "$server_pid" '[dev] Server exited before becoming ready.'

printf '[dev] Starting Vite HMR dev server on port %s (proxying to http://127.0.0.1:%s)...\n' "$web_port" "$api_port"
(
  cd "$repo/src/Web"
  FSUS_SERVER_URL="http://127.0.0.1:$api_port" \
  FSUS_WEB_PORT="$web_port" \
  pnpm run dev
) &
web_pid=$!

wait_for_dev_http 40 "http://127.0.0.1:$web_port/" "$web_pid" '[dev] Vite dev server exited early.'

printf '\n========================================================================\n'
printf ' FsusBlog V2 Dev + HMR Ready\n'
printf '========================================================================\n'
printf ' Site (HMR)        : http://localhost:%s/\n' "$web_port"
printf ' Unified login     : http://localhost:%s/login\n' "$web_port"
printf ' Admin console     : http://localhost:%s/admin/site\n' "$web_port"
printf ' Backend API       : http://127.0.0.1:%s\n' "$api_port"
printf ' PostgreSQL 18     : %s\n' "$FSUSBLOG_DB"
printf ' AEDS console debug: __fsusDebug.aeds(true)  (in browser DevTools)\n'
if [[ -n "$admin_bootstrap_key" ]]; then
  printf '%s\n' '------------------------------------------------------------------------'
  printf ' Admin bootstrap key (dev-admin, 10m): %s\n' "$admin_bootstrap_key"
fi
if [[ -n "$reader_login_ticket" ]]; then
  printf ' Reader login ticket (dev-reader, 10m): %s\n' "$reader_login_ticket"
fi
if [[ -n "$dev_admin_cookie" ]]; then
  printf ' Dev admin session cookie (24h, set on http://localhost:%s):\n' "$web_port"
  printf '   Cookie name : fsus-v2-admin-session\n'
  printf '   Cookie value: %s\n' "$dev_admin_cookie"
  printf '   Saved in    : .dev-data/dev-admin-session.txt\n'
fi
printf '========================================================================\n'
printf 'Press Ctrl+C to stop Vite, Server, and PostgreSQL cleanly.\n\n'

wait "$server_pid" "$web_pid"
