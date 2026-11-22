import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

export function ownedEvidence(path, message, describeSizeChange = false) {
  const evidence = realpathSync(path);
  const directory = lstatSync(evidence);
  assert(directory.isDirectory() && directory.uid === process.geteuid() && (directory.mode & 0o077) === 0, message);

  function read(name, limit = 1_048_576) {
    const file = join(evidence, name);
    const info = lstatSync(file);
    assert(info.isFile() && info.uid === directory.uid && (info.mode & 0o077) === 0 && info.size > 0 && info.size <= limit,
      'Invalid owned evidence file: ' + name);
    const bytes = readFileSync(file);
    assert.equal(bytes.length, info.size, describeSizeChange ? 'Evidence size changed: ' + name : undefined);
    return bytes;
  }
  return { evidence, directory, read };
}

export function checkNightlyListener(owner, origin, checkSocket) {
  for (const key of ['owner_pid', 'postgres_pid', 'server_pid']) {
    const pid = Number(owner.get(key));
    assert(Number.isSafeInteger(pid) && pid > 1, 'Missing owned process: ' + key);
    process.kill(pid, 0);
  }
  checkSocket?.();
  execFileSync('lsof', ['-n', '-P', '-a', '-p', owner.get('server_pid'),
    '-iTCP@127.0.0.1:' + origin.port, '-sTCP:LISTEN'], { timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] });
}
