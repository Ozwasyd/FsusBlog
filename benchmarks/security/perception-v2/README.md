# perception-sealed@v2 Red-Team Harness

Standalone synthetic red-team and regression benchmark harness for issue #521.
It does not use production databases or production request hot-path ML inference.

## Local Commands

```bash
node --test tests/security/perception-v2/perception-harness.test.mjs
tools/test/lanes/perception-v2-redteam.sh pr
tools/test/lanes/perception-v2-redteam.sh nightly
node benchmarks/security/perception-v2/run.mjs --profile pr --samples 96 --out .tmp/security/perception-v2/pr
node benchmarks/security/perception-v2/run.mjs --profile nightly --samples 960 --out .tmp/security/perception-v2/nightly
```

The runner writes:

- `perception-v2-report.json`
- `perception-v2-report.md`

Reports include human success, median solve time, bot single-try success,
bot three-attempt success, client render p95, server verify p99, payload p95,
and task kind / family / variant group rows.

## Thresholds

Thresholds are configurable by CLI flags or environment variables:

- `--min-human-success` / `FSUSBLOG_PERCEPTION_V2_MIN_HUMAN_SUCCESS`
- `--max-bot-single-try` / `FSUSBLOG_PERCEPTION_V2_MAX_BOT_SINGLE_TRY`
- `--max-bot-three-attempt` / `FSUSBLOG_PERCEPTION_V2_MAX_BOT_THREE_ATTEMPT`
- `--max-client-render-p95-ms` / `FSUSBLOG_PERCEPTION_V2_MAX_CLIENT_RENDER_P95_MS`
- `--max-server-verify-p99-ms` / `FSUSBLOG_PERCEPTION_V2_MAX_SERVER_VERIFY_P99_MS`
- `--max-payload-p95-bytes` / `FSUSBLOG_PERCEPTION_V2_MAX_PAYLOAD_P95_BYTES`
- `--max-median-solve-ms` / `FSUSBLOG_PERCEPTION_V2_MAX_MEDIAN_SOLVE_MS`

## CI Cadence

The PR quality gate runs the small regression profile through:

- `./tools/test.sh perception-v2-redteam-pr --no-deps`
- `.github/workflows/quality-gate.yml` / `security-static-fuzz`

The scheduled operations workflow runs the larger benchmark profile through:

- `tools/test/lanes/perception-v2-redteam.sh nightly`
- `.github/workflows/daily-operations-checks.yml` / `perception-v2-redteam-nightly`

Both lanes write JSON and Markdown reports under `.tmp/security/perception-v2`.
Neither lane reads application databases or invokes ML inference in production
request paths.

## Strategy Weight Linkage

Red-team reports are aggregate release inputs, not per-request decisions. When
bot single-try or three-attempt success rates rise for a task kind / family /
variant, operators should adjust the offline policy weights that select harder
families, lower the rollout percentage for weak variants, or require a stronger
secondary challenge. The online verifier still uses sealed challenge proofs and
runtime risk state only; it must not consult red-team sample answers or solver
training output while serving a request.
