import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const task = '/home/lyuaoss/projects/FsusBlog/.tmp/batch-3664-local-validation-v2-20261004.1LnfcW';
const guest = '/home/debian/fsusblog-preparation-v6.QNwrrm';
const run = 'guest-original-preparation-v6-20261004T153800Z';
const physicalRun = run.toLowerCase();
const base = '/home/lyuaoss/projects/FsusBlog/.tmp/c86-isolated-qa.nEpdgY';
const ssh = ['-F', '/dev/null', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
  '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no',
  '-o', 'HostKeyAlias=[127.0.0.1]:38097', '-o', `UserKnownHostsFile=${base}/evidence/bootstrap-host-ed25519.keyscan`,
  '-o', 'GlobalKnownHostsFile=/dev/null', '-i', `${base}/qa_ed25519`, '-p', '34897', 'debian@127.0.0.1'];
if (process.argv.length !== 3 || process.argv[2] !== '--export-readonly') throw Error('explicit read-only mode');
const root = fs.mkdtempSync(`${task}/failed-v11-readonly-export-`);
fs.chmodSync(root, 0o700);
const observations = [];
function capture(name, command, limit = 1024 * 1024) {
  const r = spawnSync('/usr/bin/ssh', [...ssh, command], { timeout: 60000, maxBuffer: limit,
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } });
  for (const [stream, bytes] of [['stdout', r.stdout], ['stderr', r.stderr]]) {
    if (bytes) fs.writeFileSync(`${root}/${name}.${stream}`, bytes, { flag: 'wx', mode: 0o600 });
  }
  observations.push({ name, command, status: r.status, signal: r.signal,
    error: r.error?.message ?? null, stdoutBytes: r.stdout?.length ?? 0,
    stdoutSha256: r.stdout ? crypto.createHash('sha256').update(r.stdout).digest('hex') : null });
  fs.writeFileSync(`${root}/observations.json`, JSON.stringify(observations, null, 2) + '\n', { mode: 0o600 });
  if (r.error || r.signal || r.status !== 0) throw Error(`read-only export failed: ${name}`);
}
console.log(JSON.stringify({ root, SDK: false, CI: false, qualificationEligible: false }));
capture('identity', `id; cat /proc/sys/kernel/random/boot_id; env GIT_OPTIONAL_LOCKS=0 git -C ${guest}/source rev-parse HEAD 'HEAD^{tree}'; env GIT_OPTIONAL_LOCKS=0 git -C ${guest}/source status --porcelain; journalctl --list-boots --no-pager`);
capture('original-raw.tar', `tar --format=posix --numeric-owner -C ${guest} -cf - original-cli-${run}`, 2 * 1024 * 1024);
capture('physical-records.tar', `tar --format=posix --numeric-owner -C ${guest}/source/.tmp/physical-executions -cf - ${physicalRun}`, 2 * 1024 * 1024);
capture('old-boot-uid1000-journal', 'journalctl --no-pager -o json -b f6042883560147bf97e5175f8f85ca69 _UID=1000');
capture('owned-tool-cache-roster', `find ${guest}/source/.tmp/test-execution-envelope/run-owned/${run} -maxdepth 7 -type f -printf '%s %p\\n'`);
capture('original-descriptor-and-raw-status', `for p in ${guest}/source/.tmp/behavior-doc-nuget-preparation/${run}.json ${guest}/original-cli-${run}/exit-code.txt ${guest}/original-cli-${run}/source-after.txt; do if test -f "$p"; then stat -c '%s %n' "$p"; else printf 'MISSING %s\\n' "$p"; fi; done`);
fs.writeFileSync(`${root}/summary.json`, JSON.stringify({ observations, oldOriginalCliTerminal: 'UNKNOWN',
  oldContainedZero: 'UNKNOWN', oldCleanup: 'UNKNOWN', partialPackagesQualified: false, qualificationEligible: false,
  failedRunResumed: false, SDK: false, CI: false }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ root, exportsComplete: true, qualificationEligible: false }));
