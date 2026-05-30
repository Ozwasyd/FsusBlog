#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const outputPath = process.env.FSUSBLOG_SLO_ALERT_OUTPUT
  ? path.resolve(process.env.FSUSBLOG_SLO_ALERT_OUTPUT)
  : path.join(rootDir, '.tmp', 'operations', 'slo-alert-fixture.json');

const defaultFixture = {
  generatedAt: '2026-05-18T00:00:00Z',
  thresholds: {
    postgresLatencyMs: 200,
    redisLatencyMs: 50,
    sseSlowDisconnectsLast5m: 10
  },
  readiness: {
    status: 'not_ready',
    checks: {
      postgres: { status: 'ok', latencyMs: 250 },
      redis: { status: 'ok', latencyMs: 75 },
      runtime: {
        status: 'ok',
        startup: {
          tasks: {
            aotDiskCache: { status: 'failed', detail: 'synthetic_backfill_error' },
            searchIndex: { status: 'failed', detail: 'synthetic_rebuild_error' }
          }
        },
        scheduledPublish: {
          status: 'degraded',
          lastFailedCount: 1,
          dueBacklog: 1,
          lastError: 'synthetic_scheduled_publish_failure'
        }
      }
    }
  },
  sse: {
    slowDisconnectsLast5m: 24
  },
  security: {
    status: 'blocked',
    blockers: [
      {
        source: 'dast',
        message: 'synthetic DAST blocker'
      }
    ]
  },
  expectedAlerts: [
    'ready_degraded',
    'db_latency_high',
    'redis_latency_high',
    'aot_backfill_failed',
    'search_rebuild_failed',
    'sse_disconnect_spike',
    'security_blocker'
  ]
};

const alertCatalog = {
  ready_degraded: {
    severity: 'critical',
    impact: 'Traffic switch and release closeout are blocked because one or more readiness dependencies are not healthy.',
    investigate: '/health/ready JSON, container logs, ProductionStartupValidator runtime task details, DB and Redis connectivity.',
    rollbackOrDegrade: 'Keep or remove gateway traffic from the candidate image; if this followed a rollout, switch back to the previous image tag.'
  },
  db_latency_high: {
    severity: 'warning',
    impact: 'Cache misses, authoring writes, article reads and migrations can stall behind PostgreSQL pressure.',
    investigate: '/health/ready checks.postgres.latencyMs, DB concurrency gate snapshot, slow SQL logs, PostgreSQL connection usage.',
    rollbackOrDegrade: 'Reduce public traffic, pause non-essential admin writes and background jobs, then restore the prior image if latency started with the deploy.'
  },
  redis_latency_high: {
    severity: 'warning',
    impact: 'L2 cache, SSE backlog replay and cache-control fanout can become slow or stale.',
    investigate: '/health/ready checks.redis.latencyMs, Redis memory/eviction policy, network path and Redis command latency.',
    rollbackOrDegrade: 'Keep the app out of new traffic until latency recovers; allow public JSON fallback only when readiness is restored.'
  },
  aot_backfill_failed: {
    severity: 'warning',
    impact: 'Public pages may fall back from server AOT shells to SPA rendering and lose expected first-load performance.',
    investigate: 'runtime.startup.tasks.aotDiskCache, PublicAOT worker logs, aotBackfill.failuresLastHour and wwwroot/aot-cache permissions.',
    rollbackOrDegrade: 'Disable one-shot AOT cache cleanup, keep SPA fallback enabled, and rerun backfill after fixing cache permissions or renderer failures.'
  },
  search_rebuild_failed: {
    severity: 'critical',
    impact: 'Search results and distribution version coherence can be stale after article mutations or deployment.',
    investigate: 'runtime.startup.tasks.searchIndex, search.rebuildFailuresLastHour, search artifact directory and SearchIndexService logs.',
    rollbackOrDegrade: 'Restore previous search artifacts or previous image, keep public reads online, and rebuild the index before release closeout.'
  },
  sse_disconnect_spike: {
    severity: 'warning',
    impact: 'Notification streams can miss live updates and increase replay pressure for authenticated/admin clients.',
    investigate: 'SSE slow disconnect metric, /health/ready runtime.sseConnections, gateway websocket buffering and slow consumer logs.',
    rollbackOrDegrade: 'Lower gateway traffic or reconnect pressure, preserve polling/fetch fallback paths, and revert gateway changes that introduced buffering.'
  },
  security_blocker: {
    severity: 'critical',
    impact: 'Production release is blocked by DAST, attack matrix, permission matrix or external exposure evidence failures.',
    investigate: '.tmp/security/zap, attack/permission matrix outputs, .tmp/security/production-exposure-status.json blockers.',
    rollbackOrDegrade: 'Do not promote the release; keep the previous image and gateway config until every security blocker has passing evidence.'
  }
};

function readFixture() {
  const fixturePath = process.argv[2] ?? process.env.FSUSBLOG_SLO_ALERT_FIXTURE;
  if (!fixturePath) {
    return { fixture: defaultFixture, source: 'embedded-default' };
  }

  const absolutePath = path.resolve(fixturePath);
  const fixture = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  return { fixture, source: absolutePath };
}

function statusOf(value) {
  return String(value?.status ?? '').toLowerCase();
}

function isUnhealthy(value) {
  const status = statusOf(value);
  return status === 'failed' || status === 'degraded' || status === 'not_ready' || status === 'blocked';
}

function numberAt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function startupTask(fixture, name) {
  return fixture?.readiness?.checks?.runtime?.startup?.tasks?.[name]
    ?? fixture?.readiness?.checks?.startup?.tasks?.[name]
    ?? null;
}

function addAlert(alerts, id, observed, sources = []) {
  const catalog = alertCatalog[id];
  alerts.push({
    id,
    status: 'firing',
    severity: catalog.severity,
    observed,
    sources,
    impact: catalog.impact,
    investigate: catalog.investigate,
    rollbackOrDegrade: catalog.rollbackOrDegrade
  });
}

function evaluateAlerts(fixture) {
  const alerts = [];
  const thresholds = {
    postgresLatencyMs: numberAt(fixture?.thresholds?.postgresLatencyMs, 200),
    redisLatencyMs: numberAt(fixture?.thresholds?.redisLatencyMs, 50),
    sseSlowDisconnectsLast5m: numberAt(fixture?.thresholds?.sseSlowDisconnectsLast5m, 10)
  };
  const readiness = fixture?.readiness ?? {};
  const readinessChecks = readiness.checks ?? {};
  const runtime = readinessChecks.runtime ?? {};
  const scheduledPublish = runtime.scheduledPublish ?? readinessChecks.scheduledPublish;
  const postgres = readinessChecks.postgres ?? fixture?.postgres ?? {};
  const redis = readinessChecks.redis ?? fixture?.redis ?? {};
  const aotTask = startupTask(fixture, 'aotDiskCache');
  const searchTask = startupTask(fixture, 'searchIndex');
  const aotFailures = numberAt(fixture?.aotBackfill?.failuresLastHour, 0);
  const searchFailures = numberAt(fixture?.search?.rebuildFailuresLastHour, 0);
  const sseSlowDisconnects = numberAt(
    fixture?.sse?.slowDisconnectsLast5m
      ?? runtime?.sseSlowDisconnectsLast5m
      ?? readinessChecks?.sse?.slowDisconnectsLast5m,
    0);
  const security = fixture?.security ?? {};
  const securityBlockerCount = Array.isArray(security.blockers) ? security.blockers.length : 0;

  if (statusOf(readiness) !== 'ready'
    || Object.values(readinessChecks).some(isUnhealthy)
    || isUnhealthy(scheduledPublish)) {
    addAlert(alerts, 'ready_degraded', {
      readinessStatus: readiness.status ?? null,
      degradedChecks: Object.entries(readinessChecks)
        .filter(([, value]) => isUnhealthy(value))
        .map(([key]) => key),
      scheduledPublishStatus: scheduledPublish?.status ?? null
    }, ['/health/ready']);
  }

  const postgresLatency = numberAt(postgres.latencyMs, -1);
  if (postgresLatency >= 0 && postgresLatency > thresholds.postgresLatencyMs) {
    addAlert(alerts, 'db_latency_high', {
      latencyMs: postgresLatency,
      thresholdMs: thresholds.postgresLatencyMs
    }, ['/health/ready checks.postgres.latencyMs']);
  }

  const redisLatency = numberAt(redis.latencyMs, -1);
  if (redisLatency >= 0 && redisLatency > thresholds.redisLatencyMs) {
    addAlert(alerts, 'redis_latency_high', {
      latencyMs: redisLatency,
      thresholdMs: thresholds.redisLatencyMs
    }, ['/health/ready checks.redis.latencyMs']);
  }

  if (isUnhealthy(aotTask) || aotFailures > 0) {
    addAlert(alerts, 'aot_backfill_failed', {
      startupTaskStatus: aotTask?.status ?? null,
      failuresLastHour: aotFailures
    }, ['/health/ready runtime.startup.tasks.aotDiskCache', 'aotBackfill.failuresLastHour']);
  }

  if (isUnhealthy(searchTask) || searchFailures > 0) {
    addAlert(alerts, 'search_rebuild_failed', {
      startupTaskStatus: searchTask?.status ?? null,
      failuresLastHour: searchFailures
    }, ['/health/ready runtime.startup.tasks.searchIndex', 'search.rebuildFailuresLastHour']);
  }

  if (sseSlowDisconnects > thresholds.sseSlowDisconnectsLast5m) {
    addAlert(alerts, 'sse_disconnect_spike', {
      slowDisconnectsLast5m: sseSlowDisconnects,
      threshold: thresholds.sseSlowDisconnectsLast5m
    }, ['fsus.sse.slow_disconnects']);
  }

  if (isUnhealthy(security) || securityBlockerCount > 0) {
    addAlert(alerts, 'security_blocker', {
      securityStatus: security.status ?? null,
      blockerCount: securityBlockerCount
    }, ['.tmp/security/production-exposure-status.json', '.tmp/security/zap']);
  }

  return alerts;
}

function compareExpected(actualAlerts, expectedAlerts) {
  if (!Array.isArray(expectedAlerts)) {
    return { ok: true, missing: [], unexpected: [] };
  }

  const actual = new Set(actualAlerts.map((alert) => alert.id));
  const expected = new Set(expectedAlerts);
  const missing = [...expected].filter((id) => !actual.has(id));
  const unexpected = [...actual].filter((id) => !expected.has(id));
  return {
    ok: missing.length === 0 && unexpected.length === 0,
    missing,
    unexpected
  };
}

const { fixture, source } = readFixture();
const alerts = evaluateAlerts(fixture);
const expectation = compareExpected(alerts, fixture.expectedAlerts);
const report = {
  generatedAt: new Date().toISOString(),
  source,
  status: expectation.ok ? 'ok' : 'failed',
  alertCount: alerts.length,
  alerts,
  expectedAlerts: Array.isArray(fixture.expectedAlerts) ? fixture.expectedAlerts : null,
  missingExpectedAlerts: expectation.missing,
  unexpectedAlerts: expectation.unexpected
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);

if (!expectation.ok) {
  console.error(`[slo-alert-fixture] failed: wrote ${outputPath}`);
  if (expectation.missing.length > 0) {
    console.error(`missing expected alerts: ${expectation.missing.join(', ')}`);
  }
  if (expectation.unexpected.length > 0) {
    console.error(`unexpected alerts: ${expectation.unexpected.join(', ')}`);
  }
  process.exit(1);
}

console.log(`[slo-alert-fixture] ok: wrote ${outputPath}`);
