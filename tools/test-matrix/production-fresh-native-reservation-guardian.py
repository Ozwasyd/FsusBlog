"""Native child custody for the canonical port reservation owner.

Control EOF always cancels. Only an explicit transfer permits the application
to outlive its reservation. This helper never binds or discovers a listener.
"""

import ctypes
import hashlib
import json
import os
import select
import signal
import subprocess
import sys
import time


def process_fields(pid):
    with open('/proc/%s/stat' % pid, encoding='utf-8') as source:
        return source.read().rsplit(')', 1)[1].split()


def emit(value):
    print(json.dumps(value, separators=(',', ':')), flush=True)


def main():
    if not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
        raise RuntimeError('native child custody requires Linux pidfd signaling')
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), 'native reservation subreaper unavailable')
    request = json.loads(sys.stdin.readline())
    specification = request['specification']
    descriptor = int(request['descriptor'])
    socket_identity = os.readlink('/proc/self/fd/%d' % descriptor)
    with open('/proc/sys/kernel/random/boot_id', encoding='utf-8') as source:
        boot_id = source.read().strip()
    control_directory = specification['logFile'] + '.guardian'
    os.mkdir(control_directory, 0o700)
    directory_stat = os.stat(control_directory, follow_symlinks=False)
    control = {
        'pid': os.getpid(), 'processStartIdentity': process_fields(os.getpid())[19],
        'bootId': boot_id, 'token': request['token'],
        'directory': control_directory, 'device': directory_stat.st_dev,
        'inode': directory_stat.st_ino,
    }
    log_descriptor = os.open(specification['logFile'], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    child = None
    transferred = False
    group_finished = False
    known_members = {}
    observed_members = {}
    signals = []
    identity = None

    def members():
        nonlocal group_finished
        if group_finished:
            return []
        try:
            if process_fields(child.pid)[19] != identity['processStartIdentity']:
                raise RuntimeError('native process group leader identity drift')
        except (FileNotFoundError, ProcessLookupError):
            pass
        snapshot = {}
        for entry in os.listdir('/proc'):
            if not entry.isdigit():
                continue
            try:
                fields = process_fields(entry)
                snapshot[entry] = fields
            except (FileNotFoundError, ProcessLookupError):
                pass
        descendants = {str(os.getpid())}
        changed = True
        while changed:
            changed = False
            for entry, fields in snapshot.items():
                if fields[1] in descendants and entry not in descendants:
                    descendants.add(entry)
                    changed = True
        active = []
        for entry in descendants - {str(os.getpid())}:
            if entry not in snapshot:
                continue
            fields = snapshot[entry]
            try:
                if int(fields[19]) < int(identity['processStartIdentity']):
                    raise RuntimeError('native process group identity drift')
                if entry in known_members and known_members[entry] != fields[19]:
                    raise RuntimeError('native process group member identity drift')
                known_members[entry] = fields[19]
                observed_members[entry] = {'pid': int(entry), 'processStartIdentity': fields[19]}
                if fields[0] != 'Z':
                    active.append(int(entry))
            except (FileNotFoundError, ProcessLookupError):
                pass
        child.poll()
        while True:
            try:
                reaped, _ = os.waitpid(-1, os.WNOHANG)
                if reaped == 0:
                    break
            except ChildProcessError:
                break
        child.poll()
        # A Linux thread-group leader can already appear as Z while its other
        # threads are still exiting and waitpid(WNOHANG) returns zero. Do not
        # exit the subreaper in that window and orphan an unreaped application.
        for entry, start in known_members.items():
            try:
                if process_fields(entry)[19] == start and int(entry) not in active:
                    active.append(int(entry))
            except (FileNotFoundError, ProcessLookupError):
                pass
        return active

    def stop():
        nonlocal group_finished
        if child is None or group_finished:
            return
        for cleanup_signal in (signal.SIGTERM, signal.SIGKILL):
            if not members():
                group_finished = True
                return
            for member in members():
                descriptor = None
                try:
                    descriptor = os.pidfd_open(member, 0)
                    if process_fields(member)[19] != known_members[str(member)]:
                        raise RuntimeError('native member identity drift before signal')
                    signal.pidfd_send_signal(descriptor, cleanup_signal)
                except (FileNotFoundError, ProcessLookupError):
                    pass
                finally:
                    if descriptor is not None:
                        os.close(descriptor)
            signals.append(cleanup_signal.name)
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                if not members():
                    group_finished = True
                    return
                time.sleep(0.01)
        raise RuntimeError('native process group cleanup incomplete')

    def write_terminal(verified, reason, failure=None):
        payload = {
            'schema': 'fsusblog.native-reservation-cleanup.v1',
            'guardian': control, 'application': identity, 'verified': verified,
            'reason': reason, 'failure': failure, 'transferred': transferred,
            'members': sorted(observed_members.values(), key=lambda member: member['pid']),
            'signals': signals,
        }
        canonical = json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
        payload['contentDigest'] = 'sha256:' + hashlib.sha256(canonical.encode()).hexdigest()
        terminal = os.open(os.path.join(control_directory, 'cleanup.json'), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(terminal, 'w', encoding='utf-8') as stream:
            stream.write(json.dumps(payload, separators=(',', ':'), ensure_ascii=False) + '\n')
            stream.flush()
            os.fsync(stream.fileno())

    reason = 'control-eof'
    failure = None
    cleanup_failure = None
    try:
        environment = dict(os.environ, **specification['env'])
        environment['FSUSBLOG_RUNTIME_LISTEN_FD'] = str(descriptor)
        environment['FSUSBLOG_RUNTIME_LISTEN_SOCKET'] = socket_identity
        child = subprocess.Popen(specification['argv'], cwd=specification['cwd'], env=environment,
                                 stdin=subprocess.DEVNULL, stdout=log_descriptor, stderr=log_descriptor,
                                 pass_fds=(descriptor,), start_new_session=True)
        identity = {'pid': child.pid, 'processStartIdentity': process_fields(child.pid)[19],
                    'socketIdentity': socket_identity, 'guardian': control}
        known_members[str(child.pid)] = identity['processStartIdentity']
        # The guardian must not extend the socket's lifetime itself.
        os.close(descriptor)
        os.close(log_descriptor)
        log_descriptor = None
        emit({'ok': True, 'result': identity})
        while True:
            if child.poll() is not None:
                reason = 'application-exited'
                break
            ready, _, _ = select.select([sys.stdin], [], [], 0.05)
            if not ready:
                continue
            line = sys.stdin.readline()
            if not line:
                break
            command = json.loads(line)['command']
            if command == 'cancel':
                reason = 'explicit-cancel'
                break
            if command == 'transfer':
                transferred = True
                emit({'ok': True, 'result': {'transferred': True}})
                # No control EOF may cancel an explicitly transferred runtime.
                child.wait()
                reason = 'transferred-application-exited'
                break
            if command == 'observe':
                emit({'ok': True, 'result': {'live': child.poll() is None}})
            else:
                raise ValueError('unsupported guardian command')
    except Exception as error:
        failure = str(error)
    finally:
        if log_descriptor is not None:
            os.close(log_descriptor)
        try:
            stop()
        except Exception as error:
            cleanup_failure = str(error)
            failure = str(error) if failure is None else failure + '; ' + str(error)
        write_terminal(cleanup_failure is None, reason, failure)
    if failure is not None:
        emit({'ok': False, 'error': failure})
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
