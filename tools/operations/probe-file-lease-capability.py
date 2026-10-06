"""Task-owned filesystem capability diagnostic; no candidate test or cleanup."""
import errno
import fcntl
import hashlib
import importlib.util
import json
import os
import signal
import subprocess
import sys
import tempfile

from pathlib import Path

spec = importlib.util.spec_from_file_location("lease_boundaries", Path(__file__).with_name("probe-file-lease-boundaries.py"))
boundaries = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boundaries)


def main():
    args, plan = boundaries.read_plan(sys.argv[1:], ["probe-task-files-only"], source=__file__)
    # The source binding is to this public entry point, not the shared boundary module.
    if args.mode == "inspect":
        print(json.dumps({"mode": "inspect", "effects": False, "nativeLeaseValidated": False, "qualificationEligible": False}))
        return 0
    boundaries.settings = plan
    boundaries.require_lock(plan["taskLock"])
    boundaries.floor()
    root = tempfile.mkdtemp(prefix="file-lease-probe-", dir=plan["taskRoot"])
    os.chmod(root, 0o700)
    observations = []
    signals = []
    signal.signal(signal.SIGIO, lambda number, frame: signals.append(number))
    print(json.dumps({"root": root, "SDK": False, "CI": False, "candidateTest": False}), flush=True)

    for mount, parent in [(item["label"], item["directory"]) for item in plan["fixtureDirs"]]:
        fd, file = tempfile.mkstemp(prefix="operational-file-lease-", dir=parent)
        os.write(fd, b"task owned lease availability diagnostic\n")
        os.fsync(fd)
        os.close(fd)
        fd = os.open(file, os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
        held = False
        owned = set()
        primary = None
        child = None
        try:
            before = os.fstat(fd)
            try:
                boundaries.lease(fd, owned)
                held = True
            except OSError as error:
                observations.append({"mount": mount, "file": file, "available": False, "errno": error.errno})
                continue
            actual = fcntl.fcntl(fd, fcntl.F_GETLEASE)
            if actual != fcntl.F_WRLCK:
                raise RuntimeError("write lease not actually held")
            boundaries.release(fd, owned)
            held = False
            # Independent live reader must cause refusal, not a mocked syscall result.
            child = subprocess.Popen([sys.executable, "-I", "-S", "-c",
                "import os,sys; f=os.open(sys.argv[1],os.O_RDONLY); print('OPEN',flush=True); sys.stdin.readline(); os.close(f)", file],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
            try:
                if not boundaries.select.select([child.stdout], [], [], plan["timeoutSeconds"])[0] or child.stdout.readline().strip() != "OPEN":
                    raise RuntimeError("reader did not confirm its real open FD")
                refused = False
                try:
                    boundaries.lease(fd, owned)
                    held = True
                except OSError as error:
                    if error.errno != errno.EAGAIN:
                        raise
                    refused = True
                if not refused:
                    boundaries.release(fd, owned)
                    held = False
                    raise RuntimeError("existing reader was not refused")
            finally:
                boundaries.finish(child)
            if child.returncode != 0:
                raise RuntimeError("reader failed to terminate normally")
            # A new competing reader must notify the holder; never ignore a break.
            signal_count = len(signals)
            boundaries.lease(fd, owned)
            held = True
            breaker_script = """import errno, os, sys
try:
    f = os.open(sys.argv[1], os.O_RDONLY | os.O_NONBLOCK)
    os.close(f)
    print('UNEXPECTED_OPEN')
    sys.exit(1)
except OSError as error:
    print(error.errno)
    sys.exit(0 if error.errno == errno.EWOULDBLOCK else 1)
"""
            breaker = subprocess.run([sys.executable, "-I", "-S", "-c", breaker_script, file],
                capture_output=True, text=True, timeout=plan["timeoutSeconds"])
            if breaker.returncode != 0 or breaker.stdout.strip() != str(errno.EWOULDBLOCK):
                raise RuntimeError("new reader did not conflict with the exclusive lease")
            if len(signals) <= signal_count or fcntl.fcntl(fd, fcntl.F_GETLEASE) == fcntl.F_WRLCK:
                raise RuntimeError("new reader did not notify or mark lease break")
            boundaries.release(fd, owned)
            held = False
            after = os.fstat(fd)
            epoch = lambda s: (s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_gid, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
            if epoch(before) != epoch(after):
                raise RuntimeError("probe bytes or metadata changed")
            observations.append({"mount": mount, "file": file, "available": True,
                "actualExclusiveLease": True, "actualLiveReaderRefused": True,
                "actualNewReaderNonblockingRefused": True, "actualSIGIONotification": True,
                "readerTerminalCode": child.returncode, "epochUnchanged": True,
                "sha256": hashlib.sha256(os.pread(fd, after.st_size, 0)).hexdigest()})
        except BaseException as error:
            primary = error
            raise
        finally:
            boundaries.cleanup(child, [fd], owned, primary)

    with open(root + "/actual.json", "x", encoding="utf8") as output:
        json.dump({"observations": observations, "SIGIO": signals, "qualificationEligible": False,
            "cleanupPerformed": False, "candidateTest": False, "SDK": False, "CI": False}, output, indent=2)
    print(json.dumps({"root": root, "observations": observations, "cleanupPerformed": False}), flush=True)

    return 0 if all(item["available"] for item in observations) else 1


if __name__ == "__main__":
    sys.exit(main())
