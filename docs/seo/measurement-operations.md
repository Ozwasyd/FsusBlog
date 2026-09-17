# SEO measurement operations

Issue #1094 introduces a measurement layer that joins release identity, live public-page behavior, verified Googlebot traffic and delayed Google Search Console observations. It does not treat CTR, average position, dwell time or completion rate as a direct ranking factor. Every report separates technical correctness, crawl/index movement, impressions/clicks and business conversion, and only states observed association.

## Evidence and trust boundaries

| Artifact | Producer | Trust rule |
| --- | --- | --- |
| `search-console-daily.json` | `collect-search-console.mjs` | Must say `source=google-search-console-api`; credentials/access tokens are never serialized; missing access produces `status=blocked`, never an empty success |
| `url-inventory-input.json` | `collect-url-inventory.mjs` | Reads the live same-origin sitemap and public HTML; records final status, redirect source, declared canonical, internal links and `X-Fsus-Public-Aot-*` response source/state |
| `verified-crawler-daily.json` | `import-crawler-log.mjs` | Google UA is necessary but insufficient; PTR hostname must end in `.googlebot.com` or `.google.com`, then forward DNS must contain the original IP |
| `url-inventory-report.json` | `build-measurement-report.mjs` | Collapses redirect/sitemap entries to one same-origin canonical identity and displays Search Console cutoff/coverage |
| `release-gate.json` | `check-release-evidence.mjs` | Fails closed on absent/blocked external evidence, missing cutoff, invalid experiment binding, raw IP or credential fields |

Search Console access uses the read-only `webmasters.readonly` scope. Put a dedicated service-account JSON outside the repository in a regular non-symlink `0400` or `0600` file and grant that identity only the required Search Console property access. Set its path through `FSUSBLOG_SEARCH_CONSOLE_CREDENTIALS_FILE`; never copy it into `.tmp`, release evidence, a test fixture, an issue comment or a frontend bundle. The collector obtains an ephemeral OAuth token in memory.

Crawler input is production access-log NDJSON with `timestamp`, `url`, `status`, `method`, `responseSource`, `latencyMs`, `bytes`, `release`, `commit`, `userAgent` and `ip`; optional `canonicalUrl` and `redirectSource` improve redirect diagnostics. The importer retains URL path/status/latency/bytes/release, hashes every observed query value while preserving parameter names, reduces canonical identity to the public route plus an optional normalized `page` parameter, and replaces IP with HMAC-SHA256 using `FSUSBLOG_CRAWLER_IP_HASH_KEY_FILE`. That key is also an external `0400`/`0600` file of at least 32 bytes. Rejected UA/DNS events are retained only as reason counts. No query-user identity or account/session identifier belongs in either input or output.

All generated JSON is created or tightened to mode `0600`. Raw access logs and DNS-verification material stay under the existing operational log retention and cleanup policy; the SEO lane must not extend that source retention. Long-lived daily snapshots contain only privacy-safe observed URLs, keyed IP/hostname digests, bounded crawler fields and aggregated Search Console data. Key rotation deliberately prevents cross-key IP linkage.

## Daily audit

Use a Search Console property URL matching the public origin. URL Inspection is quota-sampled from a JSON array and is intentionally not a site-wide high-frequency scan.

```bash
export FSUSBLOG_SEARCH_CONSOLE_SITE=https://fsus.blog/
export FSUSBLOG_SEARCH_CONSOLE_CREDENTIALS_FILE=/run/secrets/fsusblog-search-console-reader.json
export FSUSBLOG_CRAWLER_IP_HASH_KEY_FILE=/run/secrets/fsusblog-crawler-ip-hash.key

node tools/seo/collect-search-console.mjs \
  --start 2026-07-01 --end 2026-07-14 \
  --inspection-urls .tmp/seo/inspection-sample.json \
  --inspection-limit 25 \
  --output .tmp/seo/search-console-daily.json

node tools/seo/collect-url-inventory.mjs \
  --site https://fsus.blog/ \
  --output .tmp/seo/url-inventory-input.json

node tools/seo/import-crawler-log.mjs \
  --site https://fsus.blog/ \
  --input /var/log/fsusblog/googlebot.ndjson \
  --output .tmp/seo/verified-crawler-daily.json

node tools/seo/build-measurement-report.mjs \
  --inventory .tmp/seo/url-inventory-input.json \
  --search-console .tmp/seo/search-console-daily.json \
  --crawler .tmp/seo/verified-crawler-daily.json \
  --experiments tools/seo/experiments.registry.json \
  --output .tmp/seo/url-inventory-report.json
```

The daily review starts with `dataCutoff`, `freshness.realtime=false`, per-source coverage and errors. `partial` means some real API pages/sitemaps/inspection samples were retained but quota or access interrupted another portion; it is not complete coverage. `blocked` means no report may be used for release or benefit claims. Search Console has reporting delay, privacy aggregation and row omission; URL Inspection coverage is only the declared sample.

Review URL states independently:

- `not-crawled`: no verified log event or sampled inspection crawl;
- `not-indexed`: sampled inspection explicitly reports exclusion/neutral/failure;
- `canonical-conflict`: Google-selected canonical differs from the declared canonical;
- `no-impressions`: indexed sample has no impressions in the measured window;
- `no-clicks`: impressions exist but clicks are zero.

Diagnostics additionally identify sitemap-without-crawl, 200 soft-404, redirect/canonical inconsistency, internal links targeting redirects, crawler traffic to paths outside the inventory, noncanonical/parameter paths, crawler exposure to AOT cold fallback/503, `lastmod` newer than the latest crawl and indexed pages without impressions. Each canonical row exposes sitemap sources, first-response status, AOT source/state, index state, impressions, clicks, CTR and impression-weighted average position. Check the crawler status/source breakdown keyed by `release@commit` before attributing a change to content demand.

## Experiment registry and release gate

`tools/seo/experiments.registry.json` is intentionally empty: it is a schema-bearing registry, not fabricated evidence. Add an entry only when an SEO change is actually scheduled. Each entry requires:

- stable `id`, explicit `hypothesis`, `design` (`url-cohort`, `time-series` or `matched-control`);
- `cohort.urls` and, where applicable, matched controls;
- full 40-character `commit`, release identity and start date;
- primary metric, guardrails, positive minimum observation days and rollback condition;
- recorded confounders such as algorithm updates, seasonality, content volume and site outages.

First-party dwell/completion metrics may be guardrails for user outcomes; they must not be named as ranking weights. Before the minimum window, the only allowed conclusion is `insufficient-observation-window`. Afterward, the tool reports only `eligible-for-reviewed-association`; a human review must still separate the four benefit layers and confounders.

For an SEO-changing release run:

```bash
node tools/seo/check-release-evidence.mjs \
  --search-console .tmp/seo/search-console-daily.json \
  --crawler .tmp/seo/verified-crawler-daily.json \
  --report .tmp/seo/url-inventory-report.json \
  --experiments tools/seo/experiments.registry.json \
  --release v1.2.3 \
  --commit 0123456789abcdef0123456789abcdef01234567 \
  --seo-change true \
  --output .tmp/seo/release-gate.json
```

Use `--seo-change false` only when the release contains no SEO change. `true` requires an experiment whose release and commit both match. The gate exits nonzero for blocked Search Console evidence, missing cutoff/lag metadata, invalid crawler evidence, a blocked inventory report, invalid/missing experiment binding, or PII/secret fields.

## Incident handling and retrospective

1. If Search Console credentials are deleted, rotated, denied or quota-limited, preserve the collector's blocked/partial artifact and rotate/fix access outside the app. Public blog reads do not depend on this tooling.
2. If crawler DNS verification fails, keep those events rejected. Do not downgrade to User-Agent-only trust; confirm DNS/network resolution and re-import the retained short-lived raw log within its operational retention window.
3. For sitemap/canonical/redirect drift, identify the affected cohort, stop expanding the change, and use existing cache/AOT invalidation paths. Do not edit evidence to force convergence.
4. For AOT cold/503 exposure, correlate release/version and timestamps with deployment evidence before claiming indexing impact.
5. At the minimum observation date, record technical, crawl/index, search-performance and business outcomes separately, along with algorithm/seasonality/content/outage confounders and the rollback decision.

The no-restart degradation path is to stop the scheduled collectors/importers and mark the SEO evidence unavailable. This removes only the measurement lane; it does not alter public routing, crawler responses, sitemap generation, AOT serving or authentication. Existing evidence remains immutable for audit, and a resumed collector creates a new timestamped snapshot rather than overwriting an earlier conclusion.

## Local verification

`tests/tools/fixtures/seo/measurement-input.json` is synthetic, contains no credential or raw IP, and drives canonical aggregation, crawler diagnostics and lag-aware reporting without network access. Run the focused suite with:

```bash
node --test tests/tools/seo-measurement.test.mjs
```

The suite mocks OAuth, Search Analytics pagination, sitemap status, URL Inspection quota/permission behavior, live sitemap/HTML fetches and reverse/forward DNS. It never contacts Search Console, DNS or the production site.
