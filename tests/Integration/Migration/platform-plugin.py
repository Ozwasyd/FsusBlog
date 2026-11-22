#!/usr/bin/env python3
from datetime import datetime, timedelta, timezone
from fcntl import flock, LOCK_EX, LOCK_NB
from io import BytesIO
from pathlib import Path
import json
import os
import platform
import signal
import subprocess
import sys
import time
from tempfile import TemporaryDirectory
from zipfile import ZipFile


sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'tools'))
from fixture_signing import digest as sha, fixture_signature as p1363, generate_key


PLUGIN = 'fixture.site.render'
HOOK = 'article.beforeRenderMarkdown'


def write(path, data, mode):
    with path.open('xb') as stream:
        stream.write(data)
    path.chmod(mode)


def fixture(root, private_key, public_key, script, *, enabled=True, bad_signature=False, network=False, revoked=False):
    root.mkdir(mode=0o700)
    manifest = dict(id=PLUGIN, name='Markdown fixture', version='1.0.0', fsusblog='>=1.3.0 <2.0.0',
                    author='test.publisher', description='Test Markdown transform.',
                    runtime=dict(type='javascript', entry='index.js'),
                    hooks=[dict(name=HOOK, priority=0, timeoutMs=250, failPolicy='fail-closed',
                                executionMode='async', scope='local', idempotent=True)],
                    capabilities=['article.render'], permissions=dict(network=network, filesystem=False, database='none'),
                    configSchema='config.schema.json')
    entries = {'manifest.json': json.dumps(manifest).encode(), 'index.js': script.encode(),
               'config.schema.json': b'{"type":"object","properties":{},"additionalProperties":false}'}
    checksums = json.dumps({name: sha(content) for name, content in entries.items()}).encode()
    signature = p1363(subprocess.check_output(['openssl', 'dgst', '-sha256', '-sign', str(private_key)], input=checksums))
    if bad_signature:
        signature = signature[:-1] + bytes([signature[-1] ^ 1])
    package = BytesIO()
    with ZipFile(package, 'w') as archive:
        for name, contents in entries.items():
            archive.writestr(name, contents)
        archive.writestr('signature/checksums.json', checksums)
        archive.writestr('signature/signature.sig', signature)
    contents = package.getvalue()
    digest = sha(contents)
    write(root / (digest + '.fspkg'), contents, 0o400)
    write(root / 'runner.lock', b'', 0o600)
    now = datetime.now(timezone.utc)
    policy = dict(PluginId=PLUGIN, Enabled=enabled, Permissions=['article.render'],
                  Key=dict(Publisher='test.publisher', KeyId='first', SubjectPublicKeyInfo=list(public_key),
                           ValidFrom=(now-timedelta(hours=1)).isoformat(), ValidUntil=(now+timedelta(hours=1)).isoformat()),
                  Source=dict(Reference='approved-source/one', Provenance='provenance/one', Publisher='test.publisher', KeyId='first',
                              ArchiveSha256=digest, SignatureReference='signature/one', TrustPolicyReference='trust/one'))
    if revoked:
        policy['Key']['RevokedAt'] = (now-timedelta(seconds=1)).isoformat()
    write(root / 'platform-plugin.json', json.dumps(policy).encode(), 0o400)


def main(assembly):
    assert platform.system() == 'Darwin', 'Run native on macOS for the seatbelt-backed worker'
    with TemporaryDirectory(prefix='fsus-platform-hook-') as raw:
        base = Path(raw).resolve(strict=True)
        key = base / 'signer.pem'
        public_key = generate_key(key)

        def run(name, source, expected, output=b'', options=None, payload='原稿 📝\r\nAbc\n'.encode()):
            root = base / name
            fixture(root, key, public_key, source, **(options or {}))
            env = dict(os.environ, FSUSBLOG_PLATFORM_PLUGIN_ROOT=str(root))
            env.pop('FSUSBLOG_DB', None)
            result = subprocess.run(['dotnet', str(assembly), 'platform-plugin', 'render', PLUGIN],
                                    input=payload, capture_output=True, timeout=8, env=env)
            assert result.stdout == output, (name, result.stdout[:128], result.stderr)
            assert result.stderr.strip() == expected and result.returncode == (1 if expected else 0), (name, result.returncode, result.stderr)
            print(name)

        def hook(statement):
            return 'export default { id: ' + json.dumps(PLUGIN) + ', hooks: { ' + json.dumps(HOOK) + ': async ctx => {' + statement + '}}};'

        run('signed-transform', hook('return ctx.next("# Signed heading\\n" + ctx.payload.replace("Abc", "Changed"));'),
            b'', '# Signed heading\n原稿 📝\r\nChanged\n'.encode())
        run('v1-registration', 'export default { id:"' + PLUGIN + '", async activate(ctx){ ctx.hooks.on("' + HOOK + '", e => e.next("First"));}};',
            b'', b'First')
        run('disabled', hook('return "unexpected";'), b'plugin-approval', options=dict(enabled=False))
        run('wrong-signature', hook('return "unexpected";'), b'archive-signature', options=dict(bad_signature=True))
        run('revoked-signer', hook('return "unexpected";'), b'publisher-key-not-current', options=dict(revoked=True))
        run('ungranted-network', hook('return "unexpected";'), b'plugin-manifest-subset', options=dict(network=True))
        run('no-host-handles', hook('return typeof process + typeof require + typeof fetch + typeof System + typeof ctx.network;'),
            b'', b'undefinedundefinedundefinedundefinedundefined')
        run('nondeterministic-api-rejected', hook('return String(Math.random());'), b'plugin-execution-rejected')
        run('wall-clock-apis-unavailable', hook('return typeof Temporal + ":" + typeof globalThis.Intl?.DateTimeFormat;'),
            b'', b'undefined:undefined')
        run('import-rejected', 'import x from "file:///etc/passwd";' + hook('return x;'), b'plugin-execution-rejected')
        run('dynamic-compilation-rejected', hook('return new Function("return 1")();'), b'plugin-execution-rejected')
        run('bounded-loop', hook('while (true) {}'), b'plugin-execution-rejected')
        run('bounded-output', hook('return "w".repeat(16385);'), b'plugin-execution-rejected')
        run('bounded-input', hook('return ctx.payload;'), b'plugin-io-limit', payload=b'x'*16385)

        direct_env = dict(os.environ, FSUSBLOG_PURE_PLUGIN_WORKER='1')
        direct = subprocess.run(['dotnet', str(assembly), 'platform-plugin', '__pure-platform-plugin-worker'],
                                input=json.dumps(dict(Id=PLUGIN, Source=hook('return "unexpected";'), Markdown='', TimeoutMs=250)).encode(),
                                capture_output=True, timeout=5, env=direct_env)
        assert direct.returncode == 3 and not direct.stdout and not direct.stderr, direct

        # Hold the same lock through a real concurrent process and prove denied invocation makes no progress.
        root = base / 'signed-transform'
        env = dict(os.environ, FSUSBLOG_PLATFORM_PLUGIN_ROOT=str(root))
        command = ['dotnet', str(assembly), 'platform-plugin', 'render', PLUGIN]
        with (root / 'runner.lock').open('rb') as lock:
            flock(lock, LOCK_EX | LOCK_NB)
            busy = subprocess.run(command, input=b'x', capture_output=True, timeout=5, env=env)
            assert busy.returncode == 1 and not busy.stdout and busy.stderr.strip() == b'plugin-runner-busy'
        disk_package, = root.glob('*.fspkg')
        modified = disk_package.with_suffix('.pending')
        write(modified, disk_package.read_bytes() + b'changed', 0o400)
        modified.replace(disk_package)
        tampered = subprocess.run(command, input=b'x', capture_output=True, timeout=5, env=env)
        assert tampered.returncode == 1 and not tampered.stdout and tampered.stderr.strip() == b'archive-digest'
        disk_package.unlink()
        os.mkfifo(disk_package, 0o400)
        fifo = subprocess.run(command, input=b'x', capture_output=True, timeout=5, env=env)
        assert fifo.returncode == 1 and not fifo.stdout and fifo.stderr.strip() == b'installed-file-size', fifo

        root = base / 'drift-proof'
        fixture(root, key, public_key, hook('return "should never be published";'))
        env['FSUSBLOG_PLATFORM_PLUGIN_ROOT'] = str(root)
        # Change only the authenticated operator approval after the child appears. The fixture permits
        # concurrent drift to test the result boundary, while real operators coordinate through runner.lock.
        with subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env) as parent:
            parent.stdin.write(b'original')
            parent.stdin.close()
            parent.stdin = None
            try:
                child = worker_pid(parent)
                assert child is not None
                os.kill(child, signal.SIGSTOP)
                try:
                    original_policy = root / 'platform-plugin.json'
                    changed_policy = json.loads(original_policy.read_bytes())
                    changed_policy['Enabled'] = False
                    replacement = original_policy.with_suffix('.pending')
                    write(replacement, json.dumps(changed_policy).encode(), 0o400)
                    replacement.replace(original_policy)
                finally:
                    os.kill(child, signal.SIGCONT)
                stdout, stderr = parent.communicate(timeout=7)
                assert parent.returncode == 1 and not stdout and stderr.strip() == b'plugin-approval-changed', stderr
            finally:
                if parent.poll() is None:
                    parent.terminate()
                    parent.wait(timeout=5)
        print('in-flight-approval-change-rejects-result')

        # Suspend the real sandboxed worker while its Promise is pending. The worker's own timers
        # cannot complete the interpreter from a stopped process. Restrict the match to our child.
        candidate = base / 'deadline-proof'
        fixture(candidate, key, public_key, hook('return await new Promise(() => {});'))
        env['FSUSBLOG_PLATFORM_PLUGIN_ROOT'] = str(candidate)
        with subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env) as parent:
            child = None
            try:
                parent.stdin.write(b'original')
                parent.stdin.close()
                parent.stdin = None
                child = worker_pid(parent)
                assert child is not None
                os.kill(child, signal.SIGSTOP)
                stdout, stderr = parent.communicate(timeout=7)
                assert parent.returncode == 1 and not stdout and stderr.strip() == b'plugin-worker-deadline', stderr
                try:
                    os.kill(child, 0)
                except ProcessLookupError:
                    child = None
                assert child is None, 'Parent left the suspended child alive'
            finally:
                if child is not None:
                    try:
                        os.kill(child, signal.SIGCONT)
                    except ProcessLookupError:
                        pass
                if parent.poll() is None:
                    parent.kill()
                    parent.wait(timeout=2)
        print('parent-deadline-reaps-suspended-worker')


def worker_pid(parent):
    until = time.monotonic() + 2
    while time.monotonic() < until and parent.poll() is None:
        processes = subprocess.check_output(['/bin/ps', '-axo', 'pid=,ppid=,command='], text=True)
        for line in processes.splitlines():
            parts = line.strip().split(maxsplit=2)
            if len(parts) != 3:
                continue
            pid, owner, arguments = parts
            if int(owner) == parent.pid and '__pure-platform-plugin-worker' in arguments:
                return int(pid)
    return None


if __name__ == '__main__':
    main(Path(sys.argv[1]).resolve(strict=True))
