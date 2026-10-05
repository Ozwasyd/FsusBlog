"""SOURCE-only task fixture probe: leases are not global-idle/retirement authority."""
import ctypes
import errno
import fcntl
import hashlib
import json
import os
import select
import signal
import subprocess
import sys
import tempfile
import time

BASE = "/home/lyuaoss/projects/FsusBlog/.tmp"
LOCK = BASE + "/governance/resource-control-20261001.heavy.lock"
ENV = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_OPTIONAL_LOCKS": "0"}
signals = []
signal.signal(signal.SIGIO, lambda number, frame: signals.append(number))


def floor():
    with open("/proc/meminfo", encoding="ascii") as stream:
        available = next(int(row.split()[1]) * 1024 for row in stream if row.startswith("MemAvailable:"))
    disk = os.statvfs(BASE)
    if available < 2147483648 or disk.f_bavail * disk.f_frsize < 1593835520:
        raise RuntimeError("operational probe resource floor")


def primary_close(fd, primary=None):
    try:
        os.close(fd)
    except BaseException as secondary:
        if primary is None:
            raise
        try:
            print(json.dumps({"phase": "close-secondary", "primary": str(primary), "secondary": str(secondary)}), file=sys.stderr, flush=True)
        except BaseException:
            pass


def record(file):
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    primary = None
    try:
        s = os.fstat(fd)
        digest = hashlib.sha256()
        while True:
            block = os.read(fd, 65536)
            if not block:
                break
            digest.update(block)
        after = os.fstat(fd)
        fields = ("st_dev", "st_ino", "st_mode", "st_uid", "st_gid", "st_size", "st_mtime_ns", "st_ctime_ns")
        if any(getattr(s, key) != getattr(after, key) for key in fields):
            raise RuntimeError("fixture changed during hash")
        return dict({key: getattr(s, key) for key in fields}, sha256=digest.hexdigest())
    except BaseException as error:
        primary = error
        raise
    finally:
        primary_close(fd, primary)


def child(code, *args):
    return subprocess.Popen([sys.executable, "-I", "-S", "-c", code, *args], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)


def ready(process):
    if not select.select([process.stdout], [], [], 5)[0]:
        raise RuntimeError("fixture child readiness timeout")
    return json.loads(process.stdout.readline())


def finish(process):
    try:
        output, errors = process.communicate("STOP\n", timeout=5)
    except BaseException as primary:
        try:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
        except BaseException as secondary:
            log_secondary("communication-stop", primary, secondary)
        raise
    if process.returncode != 0:
        raise RuntimeError("fixture child terminal failure: " + errors)
    return {"code": process.returncode, "stdout": output, "stderr": errors}


def log_secondary(phase, primary, secondary):
    try:
        print(json.dumps({"phase": phase + "-secondary", "primary": str(primary), "secondary": str(secondary)}), file=sys.stderr, flush=True)
    except BaseException:
        pass


def lease(fd, owned):
    fcntl.fcntl(fd, fcntl.F_SETLEASE, fcntl.F_WRLCK)
    owned.add(fd)  # SET succeeded: ownership exists even if GET fails or reports a break.
    if fcntl.fcntl(fd, fcntl.F_GETLEASE) != fcntl.F_WRLCK:
        raise RuntimeError("exclusive lease not actually held")


def release(fd, owned):
    if fd in owned:
        fcntl.fcntl(fd, fcntl.F_SETLEASE, fcntl.F_UNLCK)
        owned.remove(fd)  # Only successful explicit release clears ownership.


def close_owned(fd, owned):
    os.close(fd)
    owned.discard(fd)  # Successful close also ends this FD ownership.


def cleanup(process, descriptors, owned, primary):
    first = primary
    operations = []
    if process is not None:
        def stop():
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
            process.communicate(timeout=5)
        operations.append(("child-terminal", stop))
    for fd in descriptors:
        operations.extend([("unlock", lambda fd=fd: release(fd, owned)), ("close", lambda fd=fd: close_owned(fd, owned))])
    for phase, operation in operations:
        try:
            operation()
        except BaseException as error:
            if first is None:
                first = error
            else:
                try:
                    print(json.dumps({"phase": phase + "-secondary", "primary": str(first), "secondary": str(error)}), file=sys.stderr, flush=True)
                except BaseException:
                    pass
    if primary is None and first is not None:
        raise first


MAPPING = """import ctypes, json, os, sys
lib = ctypes.CDLL(None, use_errno=True)
lib.mmap.restype = ctypes.c_void_p
lib.mmap.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_long]
lib.munmap.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
fd = os.open(sys.argv[1], os.O_RDONLY | os.O_CLOEXEC)
ptr = lib.mmap(None, 4096, 1, int(sys.argv[2]), fd, 0)
if ptr == ctypes.c_void_p(-1).value: raise OSError(ctypes.get_errno(), 'mmap')
os.close(fd)
try:
    try: os.fstat(fd); raise RuntimeError('original FD still open')
    except OSError: pass
    print(json.dumps({'mappingLive': True, 'originalFdClosed': True, 'firstByte': ctypes.string_at(ptr, 1).hex()}), flush=True)
    sys.stdin.readline()
finally:
    if lib.munmap(ptr, 4096) != 0: raise OSError(ctypes.get_errno(), 'munmap')
"""


def mapping_probe(file, kind):
    floor()
    before = record(file)
    fd = os.open(file, os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
    process = None
    primary = None
    held = False
    owned = set()
    try:
        process = child(MAPPING, file, str(kind))
        actual = ready(process)
        rejected = False
        try:
            lease(fd, owned)
            held = True
        except OSError as error:
            if error.errno != errno.EAGAIN or fd in owned:
                raise
            rejected = True
        if held:
            release(fd, owned)
            held = False
        terminal = finish(process)
        process = None
        if record(file) != before:
            raise RuntimeError("mapping fixture physical epoch changed")
        return {"kind": "MAP_SHARED" if kind == 1 else "MAP_PRIVATE", "child": actual, "writeLeaseRejected": rejected, "terminal": terminal, "scopePassed": rejected}
    except BaseException as error:
        primary = error
        raise
    finally:
        cleanup(process, [fd], owned, primary)


def boundary_probe(file, directory):
    floor()
    fd = os.open(file, os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
    process = None
    primary = None
    held = False
    owned = set()
    count = len(signals)
    try:
        lease(fd, owned)
        held = True
        process = child("import json,os,sys; f=os.open(sys.argv[1],os.O_PATH|os.O_NOFOLLOW); d=os.open(sys.argv[2],os.O_RDONLY|os.O_DIRECTORY); os.chdir(sys.argv[2]); print(json.dumps({'O_PATH_live':True,'directoryFdLive':True,'cwd':os.getcwd()}),flush=True); sys.stdin.readline(); os.close(d); os.close(f)", file, directory)
        actual = ready(process)
        still_held = fcntl.fcntl(fd, fcntl.F_GETLEASE) == fcntl.F_WRLCK
        terminal = finish(process)
        process = None
        return {"kind": "negative-coverage-boundary", "child": actual, "writeLeaseStillHeld": still_held, "SIGIO_delta": len(signals) - count, "terminal": terminal, "scopePassed": still_held and len(signals) == count, "proves": "file lease does not exclude O_PATH/directory/cwd references"}
    except BaseException as error:
        primary = error
        raise
    finally:
        cleanup(process, [fd], owned, primary)


def git(repo, *args):
    floor()
    return subprocess.run(["/usr/bin/git", "-C", repo, "-c", "core.fsmonitor=false", *args], env=ENV, text=True, capture_output=True, timeout=10, check=True).stdout


def sparse_probe(root):
    repo = os.path.join(root, "isolated-git")
    os.mkdir(repo, 0o700)
    git(repo, "init", "-q")
    os.mkdir(repo + "/retire")
    for relative, content in [("keep.txt", b"keep\n"), ("retire/one.txt", b"one\n"), ("retire/two.txt", b"two\n"), (".gitignore", b"ignored.raw\n"), ("ignored.raw", b"ignored evidence\n")]:
        with open(repo + "/" + relative, "xb") as stream:
            stream.write(content)
    git(repo, "add", "keep.txt", "retire/one.txt", "retire/two.txt", ".gitignore")
    git(repo, "-c", "user.name=Operational fixture", "-c", "user.email=operational-fixture@invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "task fixture")
    before = {"head": git(repo, "rev-parse", "HEAD"), "stage": git(repo, "ls-files", "--stage"), "status": git(repo, "status", "--porcelain=v1"), "keep": record(repo + "/keep.txt"), "ignored": record(repo + "/ignored.raw"), "ignore": record(repo + "/.gitignore")}
    if before["status"]:
        raise RuntimeError("isolated fixture not clean")
    holders, process = [], None
    owned = set()
    start_signals = len(signals)
    primary = None
    result = None
    try:
        for relative in ["retire/one.txt", "retire/two.txt"]:
            fd = os.open(repo + "/" + relative, os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
            holders.append(fd)
            lease(fd, owned)
        floor()
        argv = ["/usr/bin/git", "-C", repo, "-c", "core.fsmonitor=false", "sparse-checkout", "set", "--no-cone", "--no-sparse-index", "--stdin"]
        process = subprocess.Popen(argv, env=ENV, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        process.stdin.write("/keep.txt\n/.gitignore\n")
        process.stdin.close()
        process.stdin = None
        deadline = time.monotonic() + 10
        broke = False
        timed_out = False
        while True:
            broke = len(signals) != start_signals or any(fcntl.fcntl(fd, fcntl.F_GETLEASE) != fcntl.F_WRLCK for fd in holders)
            timed_out = time.monotonic() >= deadline
            if broke or timed_out:
                # Even Git's own read is a break: stop this fixture Git, release all leases, no retry.
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGTERM)
                break
            if process.poll() is not None:
                break
            time.sleep(0.01)
        for fd in holders:
            release(fd, owned)
        output, errors = process.communicate(timeout=5)
        code = process.returncode
        process = None
        broke = broke or len(signals) != start_signals
        after = {"head": git(repo, "rev-parse", "HEAD"), "stage": git(repo, "ls-files", "--stage"), "status": git(repo, "status", "--porcelain=v1"), "keep": record(repo + "/keep.txt"), "ignored": record(repo + "/ignored.raw"), "ignore": record(repo + "/.gitignore")}
        removed = not os.path.lexists(repo + "/retire/one.txt") and not os.path.lexists(repo + "/retire/two.txt")
        result = {"kind": "isolated-ordinary-noncone-sparse", "repo": repo, "argv": argv, "before": before, "after": after, "exit": code, "stdout": output, "stderr": errors, "SIGIO_delta": len(signals) - start_signals, "leaseBreakRefused": broke, "timedOut": timed_out, "retiredFixturePathsAbsent": removed, "scopePassed": not broke and not timed_out and code == 0 and before == after and removed, "realCandidateTouched": False}
        return result
    except BaseException as error:
        primary = error
        raise
    finally:
        cleanup(process, holders, owned, primary)


def main():
    if sys.argv[1:] != ["--probe-new-task-fixtures-only"] or os.getuid() != 1000:
        raise RuntimeError("explicit isolated task probe required")
    with open("/proc/%d/cmdline" % os.getppid(), "rb") as stream:
        parent = stream.read().split(b"\0")
    if not parent or os.path.basename(os.fsdecode(parent[0])) != "flock" or os.fsencode(LOCK) not in parent:
        raise RuntimeError("direct sole-heavy flock parent required")
    lock = os.stat(LOCK)
    identity = "%02x:%02x:%d" % (os.major(lock.st_dev), os.minor(lock.st_dev), lock.st_ino)
    with open("/proc/locks", encoding="ascii") as stream:
        if not any(row.split()[1:6] == ["FLOCK", "ADVISORY", "WRITE", str(os.getppid()), identity] for row in stream if len(row.split()) >= 6):
            raise RuntimeError("sole heavy lock not actually held")
    floor()
    source_before = record(os.path.abspath(__file__))
    root = tempfile.mkdtemp(prefix="operational-lease-boundaries-", dir=BASE)
    os.chmod(root, 0o700)
    tmpfs = tempfile.mkdtemp(prefix="operational-lease-boundaries-", dir="/dev/shm")
    os.chmod(tmpfs, 0o700)
    observations = []
    print(json.dumps({"root": root, "tmpfs": tmpfs, "candidateTouched": False}), flush=True)
    try:
        for label, directory in [("ext4-task", root), ("tmpfs-task", tmpfs)]:
            file = directory + "/mapping-fixture.bin"
            with open(file, "xb") as stream:
                stream.write(b"x" * 4096)
                stream.flush()
                os.fsync(stream.fileno())
            for kind in [2, 1]:
                observations.append(dict(mapping_probe(file, kind), mount=label))
            observations.append(dict(boundary_probe(file, directory), mount=label))
        observations.append(sparse_probe(root))
        if record(os.path.abspath(__file__)) != source_before:
            raise RuntimeError("probe SOURCE changed")
        value = {"observations": observations, "source": source_before, "SIGIO": signals, "scopePassed": all(row["scopePassed"] for row in observations), "globalIdleProved": False, "directoryOrOPathAbsenceProved": False, "retirementAuthorized": False, "candidateTest": False, "SDK": False, "CI": False}
        with open(root + "/actual.json", "x", encoding="utf8") as stream:
            json.dump(value, stream, indent=2)
        print(json.dumps({"root": root, "actual": root + "/actual.json", "scopePassed": value["scopePassed"], "retirementAuthorized": False}), flush=True)
        return 0 if value["scopePassed"] else 1
    except BaseException as error:
        try:
            with open(root + "/failure.json", "x", encoding="utf8") as stream:
                json.dump({"firstFailure": str(error), "observations": observations, "SIGIO": signals, "sourceBefore": source_before, "qualificationEligible": False}, stream, indent=2)
        except BaseException as secondary:
            log_secondary("failure-diagnostic", error, secondary)
        raise


if __name__ == "__main__":
    sys.exit(main())
