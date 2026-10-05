"""Run-owned exec barrier; the inherited control descriptor is never a target FD."""

import errno
import hashlib
import json
import os
import secrets
import signal
import stat
import sys


def write_message(control, value):
    control.write((json.dumps(value, separators=(",", ":")) + "\n").encode())


def executable_snapshot(command, environment):
    name = command[0]
    candidates = [name] if os.path.dirname(name) else [
        os.path.join(directory, name) for directory in environment.get("PATH", "/usr/bin:/bin").split(os.pathsep)
    ]
    result = []
    for candidate in candidates:
        try:
            if not stat.S_ISREG(os.stat(candidate).st_mode):
                raise PermissionError(errno.EACCES, "not a regular executable", candidate)
            with open(candidate, "rb") as executable:
                metadata = os.fstat(executable.fileno())
                hasher = hashlib.sha256()
                for chunk in iter(lambda: executable.read(1024 * 1024), b""):
                    hasher.update(chunk)
                digest = hasher.hexdigest()
            result.append({
                "path": candidate,
                "realPath": os.path.realpath(candidate),
                "device": metadata.st_dev,
                "inode": metadata.st_ino,
                "mode": metadata.st_mode,
                "size": metadata.st_size,
                "modified": str(metadata.st_mtime_ns),
                "changed": str(metadata.st_ctime_ns),
                "sha256": digest,
            })
        except OSError as error:
            result.append({"path": candidate, "code": errno.errorcode.get(error.errno)})
    return result


def execute(command, environment, candidates):
    # Match execvp's ordered PATH search and its historical ENOEXEC shell fallback.
    saved_error = None
    for candidate in candidates:
        if candidate.get("code") == "EACCES" and os.path.isfile(candidate["path"]) and os.access(candidate["path"], os.X_OK):
            raise PermissionError(errno.EACCES, "physical execution executable bytes are unverifiable", candidate["path"])
        try:
            os.execve(candidate["path"], command, environment)
        except OSError as error:
            if error.errno == errno.ENOEXEC:
                os.execve("/bin/sh", ["/bin/sh", candidate["path"], *command[1:]], environment)
            if error.errno == errno.EACCES:
                saved_error = error
            elif error.errno not in (errno.ENOENT, errno.ENOTDIR):
                raise
            last_error = error
    raise saved_error or last_error


def observe_owned_private_tmp(plan):
    if plan is None:
        return None
    if plan["destination"] != "/tmp" or os.path.realpath(plan["source"]) != plan["source"]:
        raise RuntimeError("physical execution owned /tmp source is not canonical")
    flags = os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    source_fd = os.open(plan["source"], flags)
    try:
        alias_fd = os.open("/tmp", flags)
        try:
            source = os.fstat(source_fd)
            alias = os.fstat(alias_fd)
            namespace = os.readlink("/proc/self/ns/mnt")
            with open("/proc/self/mountinfo", encoding="utf8") as mounts:
                entries = [line.rstrip("\n") for line in mounts if line.split()[4] == "/tmp"]
            if (str(source.st_dev) != plan["device"] or str(source.st_ino) != plan["inode"]
                    or (alias.st_dev, alias.st_ino) != (source.st_dev, source.st_ino)
                    or stat.S_IMODE(alias.st_mode) != 0o700 or str(alias.st_uid) != plan["uid"]
                    or namespace == plan["hostMountNamespace"]
                    or (str(alias.st_dev), str(alias.st_ino)) == (plan["hostTmpDevice"], plan["hostTmpInode"])
                    or len(entries) != 1 or "rw" not in entries[0].split()[5].split(",")):
                raise RuntimeError("physical execution kernel owned /tmp alias is unverifiable")
            return {"plan": plan, "mountNamespace": namespace,
                    "sourceDevice": str(source.st_dev), "sourceInode": str(source.st_ino),
                    "aliasDevice": str(alias.st_dev), "aliasInode": str(alias.st_ino),
                    "aliasMode": stat.S_IMODE(alias.st_mode), "aliasUid": str(alias.st_uid),
                    "mountInfo": entries[0]}
        finally:
            os.close(alias_fd)
    finally:
        os.close(source_fd)


def main():
    # secrets and f-strings require Python 3.6; no optional packages are loaded.
    if sys.platform != "linux" or sys.version_info < (3, 6):
        raise RuntimeError("physical execution requires Linux Python 3.6 or newer")
    os.set_inheritable(3, False)
    with os.fdopen(3, "r+b", buffering=0) as control:
        request = json.loads(control.readline())
        command = request["command"]
        environment = json.loads(request["environmentJson"])
        snapshot = executable_snapshot(command, environment)
        owned_private_tmp = observe_owned_private_tmp(request.get("privateTmpPlan"))
        with open("/proc/self/stat", encoding="utf8") as stat_file:
            fields = stat_file.read().rsplit(")", 1)[1].split()
        with open("/proc/sys/kernel/random/boot_id", encoding="utf8") as boot_file:
            boot_id = boot_file.read().strip()
        with open("/proc/self/cgroup", encoding="utf8") as cgroup_file:
            cgroup = cgroup_file.read()
        registration = {
            "pid": os.getpid(),
            "nonce": secrets.token_hex(32),
            "authorityId": request["authorityId"],
            "startIdentity": f"linux:{boot_id}:{fields[19]}",
            "processGroup": os.getpgrp(),
            "cgroup": cgroup,
            "command": command,
            "environmentDigest": "sha256:" + hashlib.sha256(request["environmentJson"].encode()).hexdigest(),
            "executables": snapshot,
            "ownedPrivateTmp": owned_private_tmp,
        }
        serialized = json.dumps(registration, separators=(",", ":"))
        write_message(control, {"registration": serialized})
        release = json.loads(control.readline())
        if release != {"release": serialized}:
            raise RuntimeError("physical execution pre-exec release does not match admission")
        if executable_snapshot(command, environment) != snapshot:
            raise RuntimeError("physical execution executable changed before release")
        if observe_owned_private_tmp(request.get("privateTmpPlan")) != owned_private_tmp:
            raise RuntimeError("physical execution owned /tmp alias changed before release")
        for name in ("SIGPIPE", "SIGXFZ", "SIGXFSZ"):
            if hasattr(signal, name):
                signal.signal(getattr(signal, name), signal.SIG_DFL)
        try:
            execute(command, environment, snapshot)
        except OSError as error:
            write_message(control, {"spawnError": {
                "name": "Error",
                "code": errno.errorcode.get(error.errno),
                "message": str(error),
            }})
            return 127
    return 1


if __name__ == "__main__":
    sys.exit(main())
