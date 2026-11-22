import json
import os
import runpy
import select
import signal
import subprocess
import sys
import time
from pathlib import Path
from tempfile import TemporaryDirectory

from hashlib import sha256

HERE = Path(__file__).resolve().parent
FIXTURE = runpy.run_path(str(HERE / "platform-plugin.py"))
INSTALL = Path("/opt/fsusblog-platform-plugin-arm64")
SYSTEMCTL = ["/usr/bin/systemctl", "--user"]
PREFIX = "fsus-platform-plugin-"


def need(condition, message):
    if not condition:
        raise RuntimeError(message)


def run_control(*args):
    result = subprocess.run([*SYSTEMCTL, *args], capture_output=True, text=True, timeout=5, check=True)
    return result.stdout


def units():
    rows = run_control("list-units", "--all", "--plain", "--no-legend", PREFIX + "*.service")
    return {line.split()[0] for line in rows.splitlines()}


def wait_unit(parent, original):
    end = time.monotonic() + 2
    while time.monotonic() < end and parent.poll() is None:
        for unit in units() - original:
            state = run_control("show", "--property=ActiveState", "--property=ControlGroup", unit)
            fields = dict(line.split("=", 1) for line in state.splitlines())
            name = fields["ControlGroup"]
            if fields["ActiveState"] == "active" and name.endswith("/" + unit):
                group = Path("/sys/fs/cgroup" + name)
                if (group / "cgroup.procs").exists():
                    return unit, group
        time.sleep(.005)
    raise RuntimeError("Could not observe the active signed Hook service.")


def guard_empty(group, pid_fds, timeout=1):
    deadline = time.monotonic() + timeout
    pending = set(pid_fds)
    while pending and time.monotonic() < deadline:
        completed, _, _ = select.select(pending, [], [], max(0, deadline - time.monotonic()))
        pending.difference_update(completed)
    need(not pending, "Original worker processes did not exit.")
    try:
        events = dict(line.split() for line in (group / "cgroup.events").read_text().splitlines())
    except FileNotFoundError:
        return
    need(events["populated"] == "0", "Owned worker cgroup remains populated.")


def main(assembly):
    uid = os.getuid()
    env = {**os.environ, "FSUSBLOG_PLATFORM_PLUGIN_LINUX": "1",
           "FSUSBLOG_PLATFORM_PLUGIN_LINUX_INSTALL_SHA256": sha256((INSTALL / "payload.sha256").read_bytes()).hexdigest(),
           "XDG_RUNTIME_DIR": f"/run/user/{uid}", "DBUS_SESSION_BUS_ADDRESS": f"unix:path=/run/user/{uid}/bus"}
    env.pop("FSUSBLOG_DB", None)
    plugin = FIXTURE["PLUGIN"]
    hook_name = FIXTURE["HOOK"]
    command = ["dotnet", str(assembly), "platform-plugin", "render", plugin]

    def hook(statement):
        return "export default { id:" + json.dumps(plugin) + ",hooks:{" + json.dumps(hook_name) + ":async ctx=>{" + statement + "}}};"

    with TemporaryDirectory(prefix="fsus-linux-signed-hook-") as raw:
        base = Path(raw).resolve(strict=True)
        key = base / "signer.pem"
        public = FIXTURE["generate_key"](key)

        def approve(name, script, **kwargs):
            root = base / name
            FIXTURE["fixture"](root, key, public, script, **kwargs)
            return root

        def run_case(name, root, expected, input_data="原稿\r\n".encode(), override=None):
            settings = env if override is None else override
            result = subprocess.run(command, input=input_data, capture_output=True, timeout=8,
                                    env={**settings, "FSUSBLOG_PLATFORM_PLUGIN_ROOT": str(root)})
            observed = result.returncode, result.stdout, result.stderr.strip()
            need(observed == expected, f"{name}: wrong signed Hook result {observed!r}")
            print(name, flush=True)

        good = approve("signed", hook('return ctx.next("# Approved\\n"+ctx.payload);'))
        denied = {key: value for key, value in env.items() if key != "FSUSBLOG_PLATFORM_PLUGIN_LINUX"}
        run_case("default-linux-disabled", good, (1, b"", b"plugin-isolation-unavailable"), override=denied)
        mismatched = {**env, "FSUSBLOG_PLATFORM_PLUGIN_LINUX_INSTALL_SHA256": "0" * 64}
        run_case("install-pin-mismatch", good, (1, b"", b"plugin-install-digest"), override=mismatched)
        run_case("signed-linux-hook", good, (0, "# Approved\n原稿\r\n".encode(), b""))
        run_case("wrong-signature", approve("wrong", hook('return "never";'), bad_signature=True),
                 (1, b"", b"archive-signature"))
        run_case("revoked-signer", approve("revoked", hook('return "never";'), revoked=True),
                 (1, b"", b"publisher-key-not-current"))
        run_case("import-rejected", approve("import", 'import x from "file:///etc/passwd";' + hook("return x;")),
                 (1, b"", b"plugin-execution-rejected"))
        run_case("wall-clock-apis-unavailable", approve("clock", hook('return typeof Temporal + ":" + typeof globalThis.Intl?.DateTimeFormat;')),
                 (0, b"undefined:undefined", b""))
        run_case("output-too-big", approve("large", hook('return "x".repeat(16385);')),
                 (1, b"", b"plugin-execution-rejected"))
        run_case("input-too-big", good, (1, b"", b"plugin-io-limit"), input_data=b"x" * 16385)

        for reason in ("changed-approval", "deadline", "host-exit"):
            root = approve(reason, hook('return "unpublished";'))
            before = units()
            with subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  env={**env, "FSUSBLOG_PLATFORM_PLUGIN_ROOT": str(root)}) as parent:
                parent.stdin.write(b"original")
                parent.stdin.close()
                parent.stdin = None
                unit = None
                handles = []
                try:
                    unit, group = wait_unit(parent, before)
                    if reason != "changed-approval":
                        run_control("kill", "--kill-whom=all", "--signal=SIGSTOP", unit)
                    handles = [os.pidfd_open(int(pid)) for pid in (group / "cgroup.procs").read_text().split()]
                    need(handles, "No test-owned processes to supervise.")
                    if reason == "changed-approval":
                        state = root / "platform-plugin.json"
                        data = json.loads(state.read_bytes())
                        data["Enabled"] = False
                        temp = state.with_suffix(".pending")
                        FIXTURE["write"](temp, json.dumps(data).encode(), 0o400)
                        temp.replace(state)
                    if reason == "host-exit":
                        parent.kill()
                        stdout, stderr = parent.communicate(timeout=8)
                        need((parent.returncode, stdout, stderr) == (-signal.SIGKILL, b"", b""),
                             "Killed host produced a response.")
                        guard_empty(group, handles, timeout=6)
                        print(reason, flush=True)
                        continue
                    stdout, stderr = parent.communicate(timeout=8)
                    code = b"plugin-approval-changed" if reason == "changed-approval" else b"plugin-worker-deadline"
                    need((parent.returncode, stdout, stderr.strip()) == (1, b"", code), f"{reason}: unexpected {stderr!r}")
                    guard_empty(group, handles)
                    print(reason, flush=True)
                finally:
                    if unit is not None:
                        subprocess.run([*SYSTEMCTL, "stop", unit], capture_output=True, timeout=5)
                    if parent.poll() is None:
                        parent.kill()
                        parent.wait(timeout=5)
                    for item in handles:
                        os.close(item)


if __name__ == "__main__":
    need(len(sys.argv) == 2 and sys.platform == "linux" and os.uname().machine == "aarch64" and os.getuid() != 0,
         "Run on Linux ARM64 as an unprivileged user with the exact Migrate assembly path.")
    main(Path(sys.argv[1]).resolve(strict=True))
