"""Task-owned lease boundary diagnostic; no retirement or qualification authority."""
import argparse
import ctypes
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import select
import signal
import subprocess
import sys
import tempfile
import time

ENV = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_OPTIONAL_LOCKS": "0", "GIT_NO_REPLACE_OBJECTS": "1"}
signals = []
settings = None


def read_plan(argv, modes, source=__file__):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", required=True)
    parser.add_argument("--plan-sha256", required=True)
    parser.add_argument("--mode", choices=["inspect", *modes], default="inspect")
    if len(argv) % 2 or len(set(argv[::2])) != len(argv[::2]) or any(key not in {"--plan", "--plan-sha256", "--mode"} for key in argv[::2]):
        raise RuntimeError("closed unique plan CLI pairs required")
    args = parser.parse_args(argv)
    fd = os.open(args.plan, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or before.st_nlink != 1 or before.st_size > 1024 * 1024:
            raise RuntimeError("plan regular file/size refusal")
        data = os.read(fd, 1024 * 1024 + 1)
        after = os.fstat(fd)
        fields = ("st_dev", "st_ino", "st_mode", "st_uid", "st_gid", "st_nlink", "st_size", "st_mtime_ns", "st_ctime_ns")
        named = os.lstat(args.plan)
        if len(data) != before.st_size or any(getattr(before, key) != getattr(after, key) or getattr(before, key) != getattr(named, key) for key in fields) or hashlib.sha256(data).hexdigest() != args.plan_sha256:
            raise RuntimeError("plan changed or digest mismatch")
    finally:
        os.close(fd)
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise RuntimeError("duplicate plan property")
            result[key] = value
        return result
    plan = json.loads(data, object_pairs_hook=unique_object)
    keys = {"schema", "taskRoot", "fixtureDirs", "minMemoryBytes", "minDiskBytes", "taskLock", "sourceSha256", "boundarySourceSha256", "timeoutSeconds"}
    if not isinstance(plan, dict) or set(plan) != keys or plan["schema"] != "fsusblog.local-task-plan.v1":
        raise RuntimeError("closed lease plan required")
    canonical_owned(plan["taskRoot"], directory=True)
    canonical_owned(os.path.abspath(args.plan), root=plan["taskRoot"])
    if not isinstance(plan["fixtureDirs"], list) or not plan["fixtureDirs"]:
        raise RuntimeError("fixture directory roster required")
    labels = set()
    for item in plan["fixtureDirs"]:
        if not isinstance(item, dict) or set(item) != {"label", "directory"} or not isinstance(item["label"], str) or not item["label"] or item["label"] in labels:
            raise RuntimeError("closed unique fixture directory required")
        labels.add(item["label"])
        canonical_owned(item["directory"], directory=True, root=plan["taskRoot"])
    for key in ["minMemoryBytes", "minDiskBytes", "timeoutSeconds"]:
        if type(plan[key]) is not int or plan[key] <= 0:
            raise RuntimeError("explicit positive resource floor required")
    canonical_owned(plan["taskLock"], root=plan["taskRoot"])
    if not isinstance(plan["sourceSha256"], str) or len(plan["sourceSha256"]) != 64 or record(str(Path(source).resolve()))["sha256"] != plan["sourceSha256"]:
        raise RuntimeError("current source digest mismatch")
    if record(str(Path(__file__).resolve()))["sha256"] != plan["boundarySourceSha256"]:
        raise RuntimeError("current shared boundary source SHA mismatch")
    return args, plan


def canonical_owned(file, directory=False, root=None):
    if not isinstance(file, str) or not os.path.isabs(file) or os.path.realpath(file) != file:
        raise RuntimeError("canonical absolute path required")
    if root is not None and (file == root or os.path.commonpath([root, file]) != root):
        raise RuntimeError("path outside task root")
    info = os.lstat(file)
    if info.st_uid != os.getuid() or (not directory and info.st_nlink != 1) or (not stat.S_ISDIR(info.st_mode) if directory else not stat.S_ISREG(info.st_mode)):
        raise RuntimeError("task ownership/type refusal")
    return info


def require_lock(file):
    with open("/proc/%d/cmdline" % os.getppid(), "rb") as stream:
        parent = stream.read().split(b"\0")
    if not parent or os.path.basename(os.fsdecode(parent[0])) != "flock" or os.fsencode(file) not in parent or b"-n" not in parent or b"--close" not in parent:
        raise RuntimeError("direct task flock parent required")
    info = os.stat(file)
    identity = "%02x:%02x:%d" % (os.major(info.st_dev), os.minor(info.st_dev), info.st_ino)
    with open("/proc/locks", encoding="ascii") as stream:
        if not any(row.split()[1:6] == ["FLOCK", "ADVISORY", "WRITE", str(os.getppid()), identity] for row in stream if len(row.split()) >= 6):
            raise RuntimeError("task lock not actually held")


def floor():
    with open("/proc/meminfo", encoding="ascii") as stream:
        available = next(int(row.split()[1]) * 1024 for row in stream if row.startswith("MemAvailable:"))
    disk = os.statvfs(settings["taskRoot"])
    if available < settings["minMemoryBytes"] or disk.f_bavail * disk.f_frsize < settings["minDiskBytes"]:
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
    if not select.select([process.stdout], [], [], settings["timeoutSeconds"])[0]:
        raise RuntimeError("fixture child readiness timeout")
    return json.loads(process.stdout.readline())


def finish(process):
    try:
        output, errors = process.communicate("STOP\n", timeout=settings["timeoutSeconds"])
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
            try:
                process.communicate(timeout=settings["timeoutSeconds"])
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate(timeout=settings["timeoutSeconds"])
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
    return subprocess.run(["/usr/bin/git", "-C", repo, "-c", "core.fsmonitor=false", *args], env=ENV, text=True, capture_output=True, timeout=settings["timeoutSeconds"], check=True).stdout


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
        deadline = time.monotonic() + settings["timeoutSeconds"]
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
        output, errors = process.communicate(timeout=settings["timeoutSeconds"])
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
    global settings
    args, settings = read_plan(sys.argv[1:], ["probe-new-task-fixtures-only"])
    if args.mode == "inspect":
        print(json.dumps({"mode": "inspect", "planSha256": args.plan_sha256, "effects": False, "nativeLeaseValidated": False, "qualificationEligible": False}))
        return 0
    require_lock(settings["taskLock"])
    signal.signal(signal.SIGIO, lambda number, frame: signals.append(number))
    floor()
    source_before = record(os.path.abspath(__file__))
    directories = [(item["label"], tempfile.mkdtemp(prefix="lease-boundaries-", dir=item["directory"])) for item in settings["fixtureDirs"]]
    for _, directory in directories:
        os.chmod(directory, 0o700)
    root = directories[0][1]
    observations = []
    print(json.dumps({"root": root, "directories": directories, "candidateTouched": False}), flush=True)
    try:
        for label, directory in directories:
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
