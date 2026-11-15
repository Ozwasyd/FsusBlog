import os
import subprocess
import sys
from pathlib import Path


def main(executable):
    namespaces = ("user", "mnt", "pid", "net", "ipc", "uts", "cgroup")
    summary = "seccomp=filter no-new-privileges=1 effective-and-ambient-caps=0 descriptors=stdio mounts=readonly"
    before = {name: os.readlink(f"/proc/self/ns/{name}") for name in namespaces}
    environment = {**os.environ, "FSUSBLOG_TEST_PRIVATE_ENV": "stop-at-sandbox"}
    with open("/proc/self/status", "rb") as extra:
        isolated = subprocess.run([executable], env=environment, pass_fds=(extra.fileno(),),
                                  stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=5)
    if isolated.returncode != 0 or isolated.stderr or not isolated.stdout:
        raise SystemExit(f"Sandbox did not produce an isolation witness: {isolated.stderr.strip()}")
    *lines, marker = isolated.stdout.splitlines()
    if len(lines) != len(namespaces) or marker != summary:
        raise SystemExit("Sandbox returned an incomplete isolation witness.")
    observed = dict(line.split("=", 1) for line in lines)
    if observed.keys() != before.keys() or any(observed[name] == before[name] for name in namespaces):
        raise SystemExit(f"Sandbox did not establish seven private namespaces: {observed}")
    bypass = subprocess.run([executable, "--inside"], env=environment, stdin=subprocess.DEVNULL,
                            capture_output=True, text=True, timeout=5)
    denials = {"linux plugin isolation probe: " + reason + "\n" for reason in
               ("seccomp and no-new-privileges", "unexpected inherited environment")}
    if bypass.returncode != 1 or bypass.stdout or bypass.stderr not in denials:
        raise SystemExit("Direct witness invocation did not reject missing admission.")
    print(isolated.stdout, end="")
    print("Verified read-only mounts, environment and descriptor isolation, and syscall denials under seven private namespaces.")


if __name__ == "__main__":
    if len(sys.argv) != 2 or not sys.platform.startswith("linux") or os.uname().machine != "aarch64":
        raise SystemExit("Run on Linux ARM64 with the absolute static isolation probe executable.")
    main(str(Path(sys.argv[1]).resolve(strict=True)))
