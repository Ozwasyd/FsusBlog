import errno
import os
import select
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path


MEMORY_BYTES = 48 * 1024 * 1024
TASKS = 8
RUNTIME_SECONDS = 4
CGROUP_ROOT = Path("/sys/fs/cgroup")
SYSTEMCTL = ["/usr/bin/systemctl", "--user"]
EVENTS = {"pids": ("pids.events", "max"), "memory": ("memory.events", "oom_kill"), "cpu": ("cpu.stat", "nr_throttled")}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def fields(path):
    return dict(line.split() for line in path.read_text().splitlines())


def membership(pid):
    record = Path(f"/proc/{pid}/cgroup").read_text().strip()
    require(record.startswith("0::/") and "\n" not in record, "Expected a unified cgroup v2 membership.")
    return record[3:]


def manager(*args):
    return subprocess.run([*SYSTEMCTL, *args], text=True, capture_output=True, timeout=5)


def wait_line(stream, expected, timeout=3):
    deadline = time.monotonic() + timeout
    received = bytearray()
    while len(received) < 256 and not received.endswith(b"\n"):
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([stream], [], [], remaining)[0]:
            raise RuntimeError(f"Timed out waiting for {expected!r}.")
        data = os.read(stream.fileno(), 1)
        if not data:
            break
        received.extend(data)
    require(received.startswith(expected) and received.endswith(b"\n"), f"Unexpected worker handshake: {bytes(received)!r}")
    return bytes(received)


def signal_input(process, line):
    process.stdin.write(line + b"\n")
    process.stdin.flush()


class ProbeService:
    def __init__(self, kind, witness, memory_bytes=MEMORY_BYTES):
        self.unit = f"fsus-plugin-witness-{uuid.uuid4().hex}.service"
        self.pid_fds = []
        self.path = None
        properties = [
            "Type=exec", "ExitType=cgroup", "Restart=no", "NoNewPrivileges=yes", "LimitCORE=0",
            "KillMode=control-group", "SendSIGKILL=yes", "TimeoutStopSec=250ms", f"RuntimeMaxSec={RUNTIME_SECONDS}s",
            f"MemoryMax={memory_bytes}", "MemorySwapMax=0", f"TasksMax={TASKS}",
            "CPUQuota=25%", "CPUQuotaPeriodSec=100ms", "OOMPolicy=continue",
        ]
        command = ["/usr/bin/systemd-run", "--user", "--quiet", "--pipe", "--wait", "--expand-environment=no",
                   "--unit=" + self.unit, *("--property=" + entry for entry in properties), "--", sys.executable,
                   str(Path(__file__).resolve()), "--worker", kind, witness]
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def properties(self, *names):
        result = manager("show", *("--property=" + name for name in names), self.unit)
        require(result.returncode == 0, f"Cannot inspect transient unit {self.unit}: {result.stderr.strip()}")
        return dict(line.split("=", 1) for line in result.stdout.splitlines())

    def admit(self, event=None):
        try:
            self.main_pid = int(wait_line(self.process.stdout, b"ready ").split()[1])
        except RuntimeError as error:
            if self.process.poll() is not None:
                _, details = self.process.communicate(timeout=1)
                raise RuntimeError(f"The transient service failed before admission: {details.strip()!r}") from error
            raise
        state = self.properties("ControlGroup", "MainPID", "ActiveState")
        relative = state["ControlGroup"]
        user = os.getuid()
        user_manager = f"/user.slice/user-{user}.slice/user@{user}.service/"
        require(relative.startswith(user_manager) and relative.split("/")[-1] == self.unit and
                int(state["MainPID"]) == self.main_pid and state["ActiveState"] == "active",
                "Worker must be the active transient service's main process.")
        self.path = (CGROUP_ROOT / relative.removeprefix("/")).resolve(strict=True)
        require(self.path.is_relative_to(CGROUP_ROOT), "Service escaped the unified cgroup mount.")
        require(fields(self.path / "cgroup.events")["populated"] == "1", "Worker cgroup must be populated.")
        self.main_handle = self.track(self.main_pid)
        require(membership(os.getpid()) != relative, "Controller must reside outside the probe cgroup.")
        expected = {"cgroup.type": "domain", "memory.max": str(MEMORY_BYTES), "memory.swap.max": "0",
                    "pids.max": str(TASKS), "cpu.max": "25000 100000"}
        for name, limit in expected.items():
            require((self.path / name).read_text().strip() == limit, f"Kernel did not supply {name}={limit}.")
        if event is not None:
            self.baseline = self.event(*event)
        self.started = time.monotonic()
        signal_input(self.process, b"go")

    def event(self, file, key):
        return int(fields(self.path / file)[key])

    def track(self, pid):
        descriptor = os.pidfd_open(pid)
        self.pid_fds.append(descriptor)
        require(CGROUP_ROOT / membership(pid).removeprefix("/") == self.path and
                str(pid) in (self.path / "cgroup.procs").read_text().split(), "Unexpected process cgroup membership.")
        return descriptor

    def complete(self, release=False):
        if release:
            signal_input(self.process, b"done")
        output, errors = self.process.communicate(timeout=6)
        require(self.process.returncode == 0 and not errors, f"Supervisor or worker failed: {errors!r}")
        self.wait_drained(2)
        return output

    def wait_drained(self, timeout):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                populated = fields(self.path / "cgroup.events")["populated"] != "0"
            except OSError as error:
                if error.errno not in (errno.ENOENT, errno.ENODEV):
                    raise
                populated = False
            ready = select.select(self.pid_fds, [], [], 0)[0]
            if not populated and len(ready) == len(self.pid_fds):
                return
            time.sleep(0.02)
        raise RuntimeError("The original cgroup and pidfds did not drain within their cleanup budget.")

    def close(self):
        try:
            manager("stop", self.unit)
            manager("reset-failed", self.unit)
            if self.path is not None:
                self.wait_drained(2)
            deadline = time.monotonic() + 1
            while time.monotonic() < deadline:
                status = manager("list-units", "--all", "--no-legend", "--plain", self.unit)
                if status.returncode == 0 and not status.stdout.strip():
                    break
                time.sleep(0.02)
            else:
                raise RuntimeError("Transient service remains loaded.")
        finally:
            if self.process.poll() is None:
                self.process.kill()
            self.process.communicate(timeout=5)
            for descriptor in self.pid_fds:
                os.close(descriptor)


def exercise(kind, witness):
    memory_bytes = MEMORY_BYTES + 1024 * 1024 if kind == "budget-mismatch" else MEMORY_BYTES
    service = ProbeService("sandbox" if kind == "budget-mismatch" else kind, witness, memory_bytes)
    try:
        if kind == "budget-mismatch":
            try:
                service.admit()
            except RuntimeError as error:
                require(str(error) == f"Kernel did not supply memory.max={MEMORY_BYTES}.", "Wrong admission failure.")
                print("budget-mismatch: rejected before workload dispatch")
                return
            raise RuntimeError("An unexpected kernel limit was admitted.")

        service.admit(EVENTS.get(kind))
        if kind == "sandbox":
            output = service.complete()
            *namespaces, marker = output.decode().splitlines()
            summary = "seccomp=filter no-new-privileges=1 effective-and-ambient-caps=0 descriptors=stdio mounts=readonly"
            require(marker == summary and len(namespaces) == 7, "The cgroup-scoped sandbox witness did not pass.")
            observed = dict(line.split("=", 1) for line in namespaces)
            require(set(observed) == {"user", "mnt", "pid", "net", "ipc", "uts", "cgroup"} and
                    all(os.readlink(f"/proc/self/ns/{name}") != value for name, value in observed.items()),
                    "The cgroup-scoped probe did not establish all seven namespaces.")
            print("sandbox: verified sealed Bubblewrap witness in admitted cgroup")
            return

        if kind in ("cancel", "deadline"):
            child = int(wait_line(service.process.stdout, b"child ").split()[1])
            handle = service.track(child)
            signal.pidfd_send_signal(handle, signal.SIGSTOP)
            if kind == "cancel":
                cancelled = time.monotonic()
                require(manager("stop", service.unit).returncode == 0, "Could not stop the owned service.")
                service.wait_drained(2)
                elapsed = time.monotonic() - cancelled
                require(elapsed < 2, f"Cancellation requires prompt group drain, got {elapsed:.3f}s.")
                print(f"cancel: stopped child and main reaped after {elapsed:.3f}s")
                return
            service.process.kill()
            service.process.wait(timeout=2)
            require(not select.select([service.main_handle, handle], [], [], 0)[0],
                    "Workload must survive its console client before the manager's deadline.")
            service.wait_drained(RUNTIME_SECONDS + 2)
            elapsed = time.monotonic() - service.started
            state = service.properties("Result", "ExecMainCode", "ExecMainStatus")
            require(2 < elapsed < RUNTIME_SECONDS + 2 and state == {"Result": "timeout", "ExecMainCode": "2", "ExecMainStatus": "9"},
                    f"Expected service timeout and group SIGKILL, got {state} after {elapsed:.3f}s.")
            print(f"deadline: launcher killed, stopped child and main reaped after {elapsed:.3f}s")
            return

        wait_line(service.process.stdout, b"measured\n")
        file, key = EVENTS[kind]
        counter = service.event(file, key) - service.baseline
        require(counter > 0, f"No kernel {file} {key} event was observed.")
        service.complete(release=True)
        print(f"{kind}: {file} {key} increased by {counter}, drained")
    finally:
        service.close()


def tasks():
    read_end, write_end = os.pipe()
    children = []
    try:
        for _ in range(TASKS + 1):
            try:
                child = os.fork()
            except BlockingIOError:
                return
            if child == 0:
                os.close(write_end)
                os.read(read_end, 1)
                os._exit(0)
            children.append(child)
        raise RuntimeError("Kernel permitted excess tasks.")
    finally:
        os.close(read_end)
        os.close(write_end)
        for child in children:
            os.waitpid(child, 0)


def memory():
    child = os.fork()
    if child == 0:
        # Prefer the allocating probe, not its waiting supervisor, as the cgroup OOM target.
        Path("/proc/self/oom_score_adj").write_text("500\n")
        blocks = []
        for _ in range(64):
            blocks.append(bytearray(b"\xa5") * (1024 * 1024))
        os._exit(1)
    _, status = os.waitpid(child, 0)
    require(os.waitstatus_to_exitcode(status) == -signal.SIGKILL, "Expected the over-limit allocator to be killed by the kernel.")


def compute():
    expires = time.monotonic() + 1.2
    while time.monotonic() < expires:
        pass


def worker(kind, witness):
    print(f"ready {os.getpid()}", flush=True)
    require(sys.stdin.readline() == "go\n", "Worker did not receive admission.")
    if kind == "sandbox":
        os.execv(witness, [witness])
    if kind in ("cancel", "deadline"):
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        child = os.fork()
        if child:
            print(f"child {child}", flush=True)
        while True:
            signal.pause()
    {"cpu": compute, "memory": memory, "pids": tasks}[kind]()
    print("measured", flush=True)
    require(sys.stdin.readline() == "done\n", "Controller did not confirm resource evidence.")


if __name__ == "__main__":
    if sys.argv[1:2] == ["--worker"] and len(sys.argv) == 4:
        worker(sys.argv[2], sys.argv[3])
    else:
        require(len(sys.argv) == 2 and sys.platform == "linux" and os.uname().machine == "aarch64" and os.getuid() != 0,
                "Run on Linux ARM64 as an unprivileged user with the static Bubblewrap witness path.")
        runtime = Path(f"/run/user/{os.getuid()}")
        os.environ["XDG_RUNTIME_DIR"] = str(runtime)
        os.environ["DBUS_SESSION_BUS_ADDRESS"] = f"unix:path={runtime}/bus"
        require((runtime / "systemd/private").is_socket() and (runtime / "bus").is_socket() and
                manager("show-environment").returncode == 0, "Active per-user systemd manager and session bus are required.")
        witness = str(Path(sys.argv[1]).resolve(strict=True))
        for case in ("sandbox", "budget-mismatch", "pids", "memory", "cpu", "cancel", "deadline"):
            exercise(case, witness)
