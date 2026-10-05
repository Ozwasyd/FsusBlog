"""Task-owned filesystem capability diagnostic; no candidate test or cleanup."""
import errno
import fcntl
import hashlib
import json
import os
import signal
import subprocess
import sys
import tempfile

if sys.argv[1:] != ["--probe-task-files-only"] or os.getuid() != 1000:
    raise RuntimeError("explicit task probe required")
root = tempfile.mkdtemp(prefix="operational-file-lease-probe-", dir="/home/lyuaoss/projects/FsusBlog/.tmp")
os.chmod(root, 0o700)
observations = []
signals = []
signal.signal(signal.SIGIO, lambda number, frame: signals.append(number))
print(json.dumps({"root": root, "SDK": False, "CI": False, "candidateTest": False}), flush=True)

for mount, parent in [("root", root), ("tmpfs", "/dev/shm")]:
    fd, file = tempfile.mkstemp(prefix="operational-file-lease-", dir=parent)
    os.write(fd, b"task owned lease availability diagnostic\n")
    os.fsync(fd)
    os.close(fd)
    fd = os.open(file, os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
    held = False
    try:
        before = os.fstat(fd)
        try:
            fcntl.fcntl(fd, fcntl.F_SETLEASE, fcntl.F_WRLCK)
            held = True
        except OSError as error:
            observations.append({"mount": mount, "file": file, "available": False, "errno": error.errno})
            continue
        actual = fcntl.fcntl(fd, fcntl.F_GETLEASE)
        if actual != fcntl.F_WRLCK:
            raise RuntimeError("write lease not actually held")
        fcntl.fcntl(fd, fcntl.F_SETLEASE, fcntl.F_UNLCK)
        held = False
        # Independent live reader must cause refusal, not a mocked syscall result.
        child = subprocess.Popen([sys.executable, "-I", "-S", "-c",
            "import os,sys; f=os.open(sys.argv[1],os.O_RDONLY); print('OPEN',flush=True); sys.stdin.readline(); os.close(f)", file],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            if child.stdout.readline().strip() != "OPEN":
                raise RuntimeError("reader did not confirm its real open FD")
            refused = False
            try:
                fcntl.fcntl(fd, fcntl.F_SETLEASE, fcntl.F_WRLCK)
                held = True
            except OSError as error:
                if error.errno != errno.EAGAIN:
                    raise
                refused = True
            if not refused:
                fcntl.fcntl(fd, fcntl.F_SETLEASE, fcntl.F_UNLCK)
                held = False
                raise RuntimeError("existing reader was not refused")
        finally:
            child.communicate("CLOSE\n", timeout=5)
        if child.returncode != 0:
            raise RuntimeError("reader failed to terminate normally")
        # A new competing reader must notify the holder; never ignore a break.
        signal_count = len(signals)
        fcntl.fcntl(fd, fcntl.F_SETLEASE, fcntl.F_WRLCK)
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
            capture_output=True, text=True, timeout=5)
        if breaker.returncode != 0 or breaker.stdout.strip() != str(errno.EWOULDBLOCK):
            raise RuntimeError("new reader did not conflict with the exclusive lease")
        if len(signals) <= signal_count or fcntl.fcntl(fd, fcntl.F_GETLEASE) == fcntl.F_WRLCK:
            raise RuntimeError("new reader did not notify or mark lease break")
        fcntl.fcntl(fd, fcntl.F_SETLEASE, fcntl.F_UNLCK)
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
    finally:
        if held:
            fcntl.fcntl(fd, fcntl.F_SETLEASE, fcntl.F_UNLCK)
        os.close(fd)

with open(root + "/actual.json", "x", encoding="utf8") as output:
    json.dump({"observations": observations, "SIGIO": signals, "qualificationEligible": False,
        "cleanupPerformed": False, "candidateTest": False, "SDK": False, "CI": False}, output, indent=2)
print(json.dumps({"root": root, "observations": observations, "cleanupPerformed": False}), flush=True)
