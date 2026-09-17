import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const binding = {
    invocationId: 'current-invocation',
    runId: 'current-run',
    scenarioId: 'release-load-expected-peak',
    identityContentDigest: `sha256:${'a'.repeat(64)}`,
    sourceState: { commit: 'b'.repeat(40), worktreeFingerprint: `sha256:${'c'.repeat(64)}` },
    buildContentDigest: `sha256:${'d'.repeat(64)}`
};

function makeFixture(context)
{
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-lane-projection-'));
    context.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    return fixture;
}

function writeExecutable(file, contents)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
    fs.chmodSync(file, 0o755);
}

function run(file, environment)
{
    const env = { ...process.env, ...environment };
    delete env.FSUSBLOG_POSTGRES_CONTAINER_NAME;
    delete env.FSUSBLOG_PG_CONTAINER;
    delete env.FSUSBLOG_REDIS_CONTAINER_NAME;
    return spawnSync('bash', [file], {
        encoding: 'utf8',
        cwd: path.resolve(path.dirname(file), '../../..'),
        env
    });
}

function setupLoadFixture(context)
{
    const fixture = makeFixture(context);
    const lane = path.join(fixture, 'tools/test/lanes/load-profile.sh');
    fs.mkdirSync(path.dirname(lane), { recursive: true });
    fs.copyFileSync(path.join(root, 'tools/test/lanes/load-profile.sh'), lane);
    writeExecutable(path.join(fixture, 'tools/test/performance-admission.mjs'), `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
const separator = process.argv.indexOf('--');
const result = spawnSync(process.argv[separator + 1], process.argv.slice(separator + 2), {
  stdio: 'inherit',
  env: process.env
});
process.exit(result.status ?? 1);
`);
    writeExecutable(path.join(fixture, 'tools/test/measurement-product-conclusion.mjs'), `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const options = Object.fromEntries(process.argv.slice(2).reduce((entries, value, index, values) => {
  if (value.startsWith('--')) entries.push([value.slice(2), values[index + 1]]);
  return entries;
}, []));
if (!options.product || !fs.existsSync(options.product)) process.exit(1);
const product = JSON.parse(fs.readFileSync(options.product, 'utf8'));
const output = { status: product.status, profile: options.profile, summary: options.product };
if (product.releaseReliability !== undefined) output.releaseReliability = product.releaseReliability;
fs.mkdirSync(path.dirname(options.output), { recursive: true });
fs.writeFileSync(options.output, JSON.stringify(output));
process.exit(0);
`);
    writeExecutable(path.join(fixture, 'tools/test/lanes/runtime-evidence-probe.mjs'), `
import fs from 'node:fs';
import path from 'node:path';
const output = process.argv[4];
if (process.env.FAKE_PROBE_MODE === 'current') {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ status: 'failed', sentinel: 'current', releaseReliability: JSON.parse(process.env.FAKE_BINDING) }));
}
if (process.env.FAKE_PROBE_MODE === 'ordinary') {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ status: 'ok', sentinel: 'ordinary' }));
}
process.exit(process.env.FAKE_PROBE_MODE === 'current' ? 7 : process.env.FAKE_PROBE_MODE === 'ordinary' ? 0 : 17);
`);
    return fixture;
}

function setupScaleFixture(context)
{
    const fixture = makeFixture(context);
    const lane = path.join(fixture, 'tools/test/lanes/data-scale.sh');
    fs.mkdirSync(path.dirname(lane), { recursive: true });
    fs.copyFileSync(path.join(root, 'tools/test/lanes/data-scale.sh'), lane);
    writeExecutable(path.join(fixture, 'tools/data-scale/seed.sh'), `#!/usr/bin/env bash
printf 'data-scale lane must not own seed\n' >&2
exit 91
`);
    writeExecutable(path.join(fixture, 'tools/data-scale/probe.sh'), `#!/usr/bin/env bash
set -euo pipefail
out="$PWD/.tmp/scale/$1/summary.json"
mkdir -p "$(dirname "$out")"
if [[ "\${FAKE_PROBE_MODE:-}" == "current" ]]; then
  printf '%s' "\${FAKE_SUMMARY}" > "$out"
  exit 7
fi
if [[ "\${FAKE_PROBE_MODE:-}" == "ordinary" ]]; then
  printf '{"schema":"fsusblog.data-scale-semantic-proof.v2","status":"ok","sentinel":"current"}' > "$out"
  exit 0
fi
exit 7
`);
    writeExecutable(path.join(fixture, 'tools/data-scale/cleanup.sh'), `#!/usr/bin/env bash
printf 'data-scale lane must not own teardown\n' >&2
exit 92
`);
    return fixture;
}

test('load lane removes stale authority when its real probe writes no current raw summary', (context) =>
{
    const fixture = setupLoadFixture(context);
    const raw = path.join(fixture, '.tmp/perf/load-baseline/summary.json');
    const projection = path.join(fixture, '.tmp/perf/release-summaries/load-baseline.json');
    fs.mkdirSync(path.dirname(raw), { recursive: true });
    fs.mkdirSync(path.dirname(projection), { recursive: true });
    fs.writeFileSync(raw, JSON.stringify({ status: 'ok', sentinel: 'stale' }));
    fs.writeFileSync(projection, JSON.stringify({ status: 'ok', sentinel: 'stale' }));

    const result = run(path.join(fixture, 'tools/test/lanes/load-profile.sh'), {
        FSUSBLOG_NODE: process.execPath
    });

    assert.equal(result.status, 17);
    assert.equal(fs.existsSync(raw), false);
    assert.equal(fs.existsSync(projection), false);
});

test('load lane copies only a current producer binding and leaves ordinary runs unbound', (context) =>
{
    const fixture = setupLoadFixture(context);
    const result = run(path.join(fixture, 'tools/test/lanes/load-profile.sh'), {
        FSUSBLOG_NODE: process.execPath,
        FAKE_PROBE_MODE: 'current',
        FAKE_BINDING: JSON.stringify(binding)
    });
    assert.equal(result.status, 7);
    const projection = JSON.parse(fs.readFileSync(
        path.join(fixture, '.tmp/perf/release-summaries/load-baseline.json'), 'utf8'
    ));
    assert.equal(projection.status, 'failed');
    assert.deepEqual(projection.releaseReliability, binding);

    const ordinary = run(path.join(fixture, 'tools/test/lanes/load-profile.sh'), {
        FSUSBLOG_NODE: process.execPath,
        FAKE_PROBE_MODE: 'ordinary'
    });
    assert.equal(ordinary.status, 0);
    const ordinaryProjection = JSON.parse(fs.readFileSync(
        path.join(fixture, '.tmp/perf/release-summaries/load-baseline.json'), 'utf8'
    ));
    assert.equal(ordinaryProjection.status, 'ok');
    assert.equal(Object.hasOwn(ordinaryProjection, 'releaseReliability'), false);
});

test('data-scale lane rejects stale observations and projects only the current raw binding', (context) =>
{
    const fixture = setupScaleFixture(context);
    const tier = 'scale-xs';
    const raw = path.join(fixture, `.tmp/scale/${tier}/summary.json`);
    const projection = path.join(fixture, `.tmp/scale/release-summaries/${tier}.json`);
    fs.mkdirSync(path.dirname(raw), { recursive: true });
    fs.mkdirSync(path.dirname(projection), { recursive: true });
    fs.writeFileSync(raw, JSON.stringify({ status: 'ok', sentinel: 'stale', releaseReliability: binding }));
    fs.writeFileSync(projection, JSON.stringify({ status: 'ok', sentinel: 'stale', releaseReliability: binding }));

    let result = run(path.join(fixture, 'tools/test/lanes/data-scale.sh'), {
        FSUSBLOG_SCALE_TIER: tier,
        FSUSBLOG_DATA_SCALE_PROVISION_MODE: 'plan-identity',
        FSUSBLOG_DATA_SCALE_PROVISIONER_SCRIPT: path.join(root, 'tools/data-scale/runtime-provisioner.mjs'),
        FSUSBLOG_NODE: process.execPath
    });
    assert.equal(result.status, 1);
    let output = JSON.parse(fs.readFileSync(projection, 'utf8'));
    assert.equal(output.status, 'failed');
    assert.equal(output.observed, null);
    assert.equal(Object.hasOwn(output, 'releaseReliability'), false);

    result = run(path.join(fixture, 'tools/test/lanes/data-scale.sh'), {
        FSUSBLOG_SCALE_TIER: tier,
        FSUSBLOG_DATA_SCALE_PROVISION_MODE: 'plan-identity',
        FSUSBLOG_DATA_SCALE_PROVISIONER_SCRIPT: path.join(root, 'tools/data-scale/runtime-provisioner.mjs'),
        FSUSBLOG_NODE: process.execPath,
        FAKE_PROBE_MODE: 'current',
        FAKE_SUMMARY: JSON.stringify({
            status: 'failed',
            sentinel: 'current',
            sampling: { requests: 12, concurrency: 2, routeCount: 3 },
            releaseReliability: binding
        })
    });
    assert.equal(result.status, 1);
    output = JSON.parse(fs.readFileSync(projection, 'utf8'));
    assert.equal(output.observed.sentinel, 'current');
    assert.deepEqual(output.sampling, { requests: 12, concurrency: 2, routeCount: 3 });
    assert.deepEqual(output.releaseReliability, binding);

    result = run(path.join(fixture, 'tools/test/lanes/data-scale.sh'), {
        FSUSBLOG_SCALE_TIER: tier,
        FSUSBLOG_DATA_SCALE_PROVISION_MODE: 'plan-identity',
        FSUSBLOG_DATA_SCALE_PROVISIONER_SCRIPT: path.join(root, 'tools/data-scale/runtime-provisioner.mjs'),
        FSUSBLOG_NODE: process.execPath,
        FAKE_PROBE_MODE: 'ordinary'
    });
    assert.equal(result.status, 0);
    output = JSON.parse(fs.readFileSync(projection, 'utf8'));
    assert.equal(output.status, 'ok');
    assert.equal(Object.hasOwn(output, 'releaseReliability'), false);
});
