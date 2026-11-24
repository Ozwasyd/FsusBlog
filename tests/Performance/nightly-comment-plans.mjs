import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { assertOwnedFile, sha256, writePrivate } from './nightly-owned-evidence.mjs';

const maxWindowBytes = 8 * 1024 * 1024;
const sql = {
  roots: '27c166eba4b866a0d6bec7c79f52c294f05a9593c3ef8732075c6d7094422199',
  previews: '65c33e4a0140b498a79e5b02eff0f1fa4deeceae0611c6276563bb9bd762dd3c',
  parent: 'f002da45a91df45a7b6db44f3a3164e0e75efadf06757893d896c218537a3820',
  children: '4c812cbdf5244cf37019be61b78c6b5ee28f1b9ee6c573e1b00ac0a54c574521',
};
const command = (name, types, values) => ({ name, fingerprint: sql[name], types, values });
const expected = event => event.caseId === 'comment-nested-root-expansion'
  ? [command('parent', ['int4', 'int8'], ['1', event.parent]),
    command('children', ['int4', 'int8', 'int8', 'int4'], ['1', event.parent, '0', '6'])]
  : [command('roots', ['int4', 'int8', 'int4'], ['1', event.incoming ?? '0', '6']),
    command('previews', ['int4', 'int8[]', 'int4'], ['1', '{' + event.ids.join(',') + '}', '3'])];

const explainPrefix = /^duration: (\d+[.]\d+) ms  plan:\n/;
function explain(record) {
  const match = explainPrefix.exec(record.message);
  if (!match) return null;
  const report = JSON.parse(record.message.slice(match[0].length));
  assert(typeof report['Query Text'] === 'string' && report.Plan, 'Incomplete auto_explain report.');
  return { raw: record, report, sql: report['Query Text'].replaceAll('\r\n', '\n'), executionMs: Number(match[1]) };
}

function values(report, length) {
  const logged = report['Query Parameters'];
  assert(typeof logged === 'string' && logged.length <= 512, 'Missing bounded PostgreSQL parameters.');
  const parts = Array.from(logged.matchAll(/(?:^|, )\$(\d+) = '([0-9]+|\{(?:[0-9]+(?:,[0-9]+)*)?\})'/g));
  assert(parts.length === length && parts.map(match => match[0]).join('') === logged &&
    parts.every((match, index) => match[1] === String(index + 1)), 'Invalid or truncated PostgreSQL parameter list.');
  return parts.map(match => match[2]);
}

function planMetrics(plan) {
  const selected = ['Actual Rows', 'Actual Loops', 'Shared Hit Blocks', 'Shared Read Blocks', 'Temp Read Blocks', 'Temp Written Blocks'];
  const result = Object.fromEntries(selected.map(name => [name, plan[name]]));
  assert(Object.values(result).every(value => Number.isFinite(value) && value >= 0), 'Missing PostgreSQL ANALYZE or buffer counters.');
  const scans = [];
  (function visit(node) {
    assert(typeof node['Node Type'] === 'string');
    if (node['Node Type'].includes('Scan') && node['Actual Loops'] > 0) {
      scans.push({ node: node['Node Type'], relation: node['Relation Name'] ?? null, index: node['Index Name'] ?? null,
        rowsPerLoop: node['Actual Rows'], loops: node['Actual Loops'], removedByFilterPerLoop: node['Rows Removed by Filter'] ?? 0,
        removedByRecheckPerLoop: node['Rows Removed by Index Recheck'] ?? 0 });
    }
    for (const child of node.Plans ?? []) visit(child);
  })(plan);
  return { ...result, scans };
}

const commentQuery = query => /^(?:\s*)with recursive public_article as \(/i.test(query);
const isMarker = (record, app, marker) => record.application_name === app && explain(record)?.sql === marker;
const sameSession = (a, b) => a.pid === b.pid && a.session_id === b.session_id && a.vxid === b.vxid;
const findMarkers = (records, markerApp, text) =>
  records.reduce((found, record, index) => (isMarker(record, markerApp, text) && found.push(index), found), []);

function correlate(records, app, markerApp, begin, end, commands) {
  const starts = findMarkers(records, markerApp, begin);
  const finishes = findMarkers(records, markerApp, end);
  assert(starts.length === 1 && finishes.length === 1 && starts[0] < finishes[0], 'Expected one ordered native boundary pair.');
  const appRecords = records.slice(starts[0] + 1, finishes[0]).filter(record => record.application_name === app);
  const plans = appRecords.map(explain).filter(record => record && commentQuery(record.sql));
  assert.equal(plans.length, commands.length, 'Wrong number of actual comment plans in the HTTP window.');
  const session = plans[0].raw;
  assert(Number.isSafeInteger(session.pid) && session.session_id && session.vxid &&
    plans.every(({ raw }, index) => sameSession(raw, session) && Number.isSafeInteger(raw.line_num) &&
      (index === 0 || raw.line_num > plans[index - 1].raw.line_num)),
  'Comment SQL plans must form a single ordered backend transaction.');
  const executed = appRecords.filter(record => {
    const match = /^execute [^\n]*?: ([\s\S]+)$/.exec(record.message);
    return match && commentQuery(match[1]);
  });
  assert.equal(executed.length, commands.length, 'Wrong number of executed comment commands in the HTTP window.');
  const evidence = plans.map(({ sql: statement, report, executionMs, raw }, index) => {
    const { name, fingerprint, types, values: expectedValues } = commands[index];
    const execution = executed[index];
    assert(sameSession(execution, raw) && execution.line_num < raw.line_num &&
      (index === 0 || execution.line_num > plans[index - 1].raw.line_num),
    'A comment plan does not follow its exact SQL execution.');
    assert(sha256(statement) === fingerprint && sha256(execution.message.slice(execution.message.indexOf(': ') + 2).replaceAll('\r\n', '\n')) === fingerprint,
      'Observed SQL differs from the frozen fingerprint for ' + name + '.');
    assert.deepEqual(values(report, types.length), expectedValues, 'Observed bind values differ for ' + name + '.');
    return { ordinal: index + 1, name, fingerprint, parameterTypes: types, parameterTypeEvidence: 'source-contract',
      valueEvidence: 'postgres-bind-output', executionMs, metrics: planMetrics(report.Plan), nativeLine: raw.line_num };
  });
  return { pid: session.pid, sessionId: session.session_id, virtualTransaction: session.vxid, commands: evidence,
    beginLine: records[starts[0]].line_num, endLine: records[finishes[0]].line_num };
}

function readSlice(path, offset, length) {
  const fd = openSync(path, 'r');
  try {
    const bytes = Buffer.alloc(length);
    assert.equal(readSync(fd, bytes, 0, length, offset), length);
    return bytes;
  } finally {
    closeSync(fd);
  }
}

async function pollUntil(timeoutMs, check, message) {
  const deadline = performance.now() + timeoutMs;
  do {
    const result = check();
    if (result !== undefined) return result;
    await setTimeout(25);
  } while (performance.now() < deadline);
  throw new Error(message);
}

export function commentPlans({ directory, runId, database, socket, output }) {
  assert(/^[0-9a-f]{32}$/.test(runId) && database === 'fsusv2_nightly_' + runId);
  const socketMatch = /^(.*\/fsusv2-nightly\.[\w]+)\/socket\/\.s\.PGSQL\.([1-9][0-9]*)$/.exec(socket);
  assert(socketMatch, 'Expected the owned Unix socket.');
  const [, scratch, port] = socketMatch;
  const gate = join(scratch, 'data', 'c11-comments.conf');
  const log = join(directory, 'comment-postgres', 'comments.json');
  const app = 'fsus-c11-http-' + runId;
  const markerApp = 'fsus-c11-marker-' + runId;
  const uid = process.geteuid();
  const ownedSize = path => assertOwnedFile(path, uid, 'Invalid private PG witness file.').size;
  const query = statement => execFileSync('psql', ['-X', '-qAt', '--no-password', '-v', 'ON_ERROR_STOP=1',
    '-h', dirname(socket), '-p', port, '-U', 'fsusv2_nightly_qa', '-d', database, '-c', statement], {
    env: { PATH: process.env.PATH, LC_ALL: 'C', PGAPPNAME: markerApp, PGCONNECT_TIMEOUT: '3' },
    encoding: 'utf8', timeout: 4000,
  }).trim();

  async function setGate(on) {
    ownedSize(gate);
    writePrivate(gate + '.next', on ? "auto_explain.log_min_duration = 0\nlog_statement = 'all'\n" : "auto_explain.log_min_duration = -1\nlog_statement = 'none'\n");
    renameSync(gate + '.next', gate);
    assert.equal(query('SELECT pg_reload_conf()'), 't');
    const target = on ? '0|all' : '-1|none';
    await pollUntil(3000, () => query("SELECT current_setting('auto_explain.log_min_duration'), current_setting('log_statement')") === target ? true : undefined,
      'Owned PostgreSQL did not apply the plan gate.');
  }

  function windowOffset() {
    const size = ownedSize(log);
    if (size === 0) return 0;
    const offset = Math.max(0, size - 8192);
    const newline = readSlice(log, offset, size - offset).lastIndexOf(10);
    assert(newline >= 0 || offset === 0, 'Cannot find a complete owner log line before the window.');
    return offset + newline + 1;
  }

  function readWindow(offset) {
    const size = ownedSize(log) - offset;
    assert(size >= 0 && size <= maxWindowBytes, 'Owned PostgreSQL log window changed or exceeded its limit.');
    const bytes = readSlice(log, offset, size);
    const lastLine = bytes.lastIndexOf(10);
    if (lastLine < 0) return [];
    return bytes.subarray(0, lastLine).toString('utf8').split('\n').map(line => ({ line, record: JSON.parse(line) }))
      .filter(({ record }) => record.dbname === database);
  }

  async function marker(offset, text) {
    assert.equal(query(text), '1');
    return pollUntil(3000, () => {
      const window = readWindow(offset);
      return window.some(({ record }) => isMarker(record, markerApp, text)) ? window : undefined;
    }, 'Native auto_explain did not record the owned boundary control.');
  }

  function markerSql(number, label) {
    assert(Number.isSafeInteger(number) && number > 0 && /^(?:begin|end-[0-9a-f]{64}|end-no-trace)$/.test(label));
    return 'SELECT 1 /*c11-comment:' + runId + ':' + number + ':' + label + '*/';
  }

  return {
    async begin(event) {
      const offset = windowOffset();
      const before = markerSql(event.number, 'begin');
      try {
        await setGate(true);
        await marker(offset, before);
        return { offset, before };
      } catch (error) {
        await setGate(false);
        throw error;
      }
    },
    async finish({ offset, before }, event) {
      const after = markerSql(event.number, event.traceId ? 'end-' + sha256(event.traceId) : 'end-no-trace');
      try {
        const window = await marker(offset, after);
        const suffix = String(event.number).padStart(4, '0');
        const nativeFile = 'native-' + suffix + '.ndjson';
        const archive = window.map(({ line }) => line).join('\n') + '\n';
        writePrivate(join(output, nativeFile), archive);
        assert(event.traceId && !event.error, 'HTTP did not complete with a verified trace and body.');
        const summary = correlate(window.map(({ record }) => record), app, markerApp, before, after, expected(event));
        const filename = 'sql-' + suffix + '.json';
        writePrivate(join(output, filename), JSON.stringify({ caseId: event.caseId, traceId: event.traceId,
          begin: before, end: after, logByteOffset: offset, nativeFile, nativeSha256: sha256(archive), summary }, null, 2) + '\n');
        return { file: filename, observer: 'postgres-auto_explain', parameterTypeEvidence: 'source-contract',
          parameterOids: 'not-collected', literalExplainReplay: 'not-run', commands: summary.commands.length };
      } finally {
        await setGate(false);
      }
    },
  };
}

// Small parser and attribution smoke. It uses PG18-shaped records and no database or HTTP server.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assert.deepEqual(process.argv.slice(2), ['--self-test']);
  const app = 'app', markerApp = 'marker', before = 'SELECT 1 /*begin*/', after = 'SELECT 1 /*end*/';
  const statement = 'with recursive public_article as (select 1) select $1,$2';
  const record = (line_num, application_name, message) =>
    ({ pid: application_name === app ? 20 : 21, session_id: application_name, vxid: '2/3', line_num, application_name, message });
  const plan = (line, application, query, parameters) => record(line, application, 'duration: 1.250 ms  plan:\n' + JSON.stringify({
    'Query Text': query, 'Query Parameters': parameters, Plan: { 'Node Type': 'Seq Scan', 'Actual Rows': 1, 'Actual Loops': 1,
      'Shared Hit Blocks': 2, 'Shared Read Blocks': 0, 'Temp Read Blocks': 0, 'Temp Written Blocks': 0 },
  }));
  const observed = [plan(1, markerApp, before), record(11, app, 'execute <unnamed>: ' + statement),
    plan(12, app, statement, "$1 = '1', $2 = '{9007199254740993,9007199254740994}'"), plan(2, markerApp, after)];
  const commands = [{ name: 'fixture', fingerprint: sha256(statement), types: ['int4', 'int8[]'],
    values: ['1', '{9007199254740993,9007199254740994}'] }];
  assert.equal(correlate(observed, app, markerApp, before, after, commands).commands[0].metrics['Shared Hit Blocks'], 2);
  for (const [rows, cmds] of [
    [observed.slice(0, -1), commands],
    [[...observed.slice(0, 3), observed[2], observed[3]], commands],
    [observed, [{ ...commands[0], fingerprint: '0'.repeat(64) }]],
    [observed, [{ ...commands[0], values: ['1', '{9007199254740994}'] }]],
  ]) assert.throws(() => correlate(rows, app, markerApp, before, after, cmds));
  assert.throws(() => values({ 'Query Parameters': "$1 = '1', $2 = '{9007199254'..." }, 2));
  console.log('Native JSON log shape, high-i64 binds, and ambiguous/missing evidence checks passed (synthetic parser only).');
}
