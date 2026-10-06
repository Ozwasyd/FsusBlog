"""Run-owned exec barrier; the inherited control descriptor is never a target FD."""

import errno
import array
import fcntl
import hashlib
import json
import os
import secrets
import signal
import stat
import socket
import struct
import sys


NATIVE_ROLES = (("collector-environment", 4), ("collector-receipt", 5))
NATIVE_MAX_BYTES = 1024 * 1024


def process_start(pid):
    with open("/proc/%d/stat" % pid, encoding="utf8") as source:
        fields = source.read().rsplit(")", 1)[1].split()
    if fields[0] in ("Z", "X"):
        raise RuntimeError("original input process is not live")
    with open("/proc/sys/kernel/random/boot_id", encoding="utf8") as source:
        return "linux:%s:%s" % (source.read().strip(), fields[19])


def native_directory(stat_value):
    return {"deviceMajor": str(os.major(stat_value.st_dev)), "deviceMinor": str(os.minor(stat_value.st_dev)),
            "inode": str(stat_value.st_ino), "mode": str(stat_value.st_mode)}


def native_leaf(stat_value):
    modified = divmod(stat_value.st_mtime_ns, 1000000000)
    changed = divmod(stat_value.st_ctime_ns, 1000000000)
    value = native_directory(stat_value)
    value.update({"links": str(stat_value.st_nlink), "uid": str(stat_value.st_uid), "gid": str(stat_value.st_gid),
                  "size": str(stat_value.st_size), "modifiedSeconds": str(modified[0]),
                  "modifiedNanoseconds": str(modified[1]), "changedSeconds": str(changed[0]),
                  "changedNanoseconds": str(changed[1])})
    return value


def native_epoch_bytes(epoch):
    leaf_fields = ("deviceMajor", "deviceMinor", "inode", "mode", "links", "uid", "gid", "size",
                   "modifiedSeconds", "modifiedNanoseconds", "changedSeconds", "changedNanoseconds")
    directory_fields = ("deviceMajor", "deviceMinor", "inode", "mode")
    value = "fsus-original-file-epoch-v1\npath:%d:%s\nleaf:%s\nancestors:%d\n" % (
        len(epoch["path"].encode("utf8")), epoch["path"],
        ":".join(epoch["leaf"][field] for field in leaf_fields), len(epoch["ancestors"]))
    return (value + "".join("ancestor:%s\n" % ":".join(row[field] for field in directory_fields)
                            for row in epoch["ancestors"])).encode("utf8")


def observe_native_input(descriptor, original_path, expected, capture_only=False):
    if (not os.path.isabs(original_path) or os.path.abspath(original_path) != original_path
            or any(ord(char) < 32 or 127 <= ord(char) < 160 for char in original_path)):
        raise RuntimeError("native input original canonical path required")
    flags = fcntl.fcntl(descriptor, fcntl.F_GETFL)
    actual = os.fstat(descriptor)
    if (flags & os.O_ACCMODE != os.O_RDONLY or flags & os.O_PATH
            or not stat.S_ISREG(actual.st_mode) or actual.st_nlink != 1 or actual.st_uid != os.getuid()
            or stat.S_IMODE(actual.st_mode) != 0o600 or not 0 <= actual.st_size <= NATIVE_MAX_BYTES
            or expected.get("role") == "collector-receipt" and actual.st_size == 0):
        raise RuntimeError("native input requires bounded private original RO regular FD")
    directory = os.open("/", os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    ancestors = [native_directory(os.fstat(directory))]
    try:
        parts = original_path.split("/")[1:]
        private_root = os.path.dirname(os.path.dirname(original_path))
        original_directory = "/"
        for part in parts[:-1]:
            next_directory = os.open(part, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
            os.close(directory)
            directory = next_directory
            original_directory = os.path.join(original_directory, part)
            opened = os.fstat(directory)
            if (original_directory == private_root or original_directory.startswith(private_root + "/")):
                if opened.st_uid != os.getuid() or stat.S_IMODE(opened.st_mode) != 0o700:
                    raise RuntimeError("native input private attempt ancestor UID/mode changed")
            ancestors.append(native_directory(opened))
        named = os.open(parts[-1], os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
        try:
            if native_leaf(os.fstat(named)) != native_leaf(actual) or native_leaf(os.fstat(descriptor)) != native_leaf(actual):
                raise RuntimeError("native input original named/held epoch differs")
        finally:
            os.close(named)
    finally:
        os.close(directory)
    epoch = {"path": original_path, "leaf": native_leaf(actual), "ancestors": ancestors}
    epoch_sha = hashlib.sha256(native_epoch_bytes(epoch)).hexdigest()
    if epoch_sha != expected["epochSha256"]:
        raise RuntimeError("native input original full epoch expectation differs")
    if capture_only:
        return epoch
    hasher = hashlib.sha256()
    offset = 0
    while offset < actual.st_size:
        chunk = bytearray(os.pread(descriptor, min(65536, actual.st_size - offset), offset))
        if not chunk:
            raise RuntimeError("native input truncated during pread")
        offset += len(chunk)
        hasher.update(chunk)
        chunk[:] = b"\0" * len(chunk)
    if os.pread(descriptor, 1, actual.st_size) or native_leaf(os.fstat(descriptor)) != epoch["leaf"]:
        raise RuntimeError("native input changed during pread")
    artifact_sha = hasher.hexdigest()
    if artifact_sha != expected["artifactSha256"]:
        raise RuntimeError("native input original byte expectation differs")
    if observe_native_input(descriptor, original_path, expected, capture_only=True) != epoch:
        raise RuntimeError("native input named/ancestor full epoch changed after pread")
    result = dict(expected)
    result.update({"epoch": epoch, "epochSha256": epoch_sha, "artifactSha256": artifact_sha})
    return result


def observe_native_socket(carrier, private_tmp_plan):
    observe_owned_private_tmp(private_tmp_plan)
    for identity in (carrier["controllerIdentity"], carrier["brokerIdentity"]):
        if process_start(identity["pid"]) != identity["processStartIdentity"]:
            raise RuntimeError("native input original parent/broker is not live")
    directory = carrier["directory"]
    host = os.lstat(directory["path"])
    guest_directory = os.path.dirname(directory["guestSocketPath"])
    guest = os.lstat(guest_directory)
    if (directory["guestSocketPath"] != "/tmp/%s/inputs.sock" % os.path.basename(directory["path"])
            or len(directory["guestSocketPath"].encode("utf8")) > 107
            or any(not stat.S_ISDIR(value.st_mode) or value.st_uid != os.getuid()
                   or stat.S_IMODE(value.st_mode) != 0o700 for value in (host, guest))
            or str(host.st_dev) != directory["device"] or str(host.st_ino) != directory["inode"]
            or (host.st_dev, host.st_ino) != (guest.st_dev, guest.st_ino)
            or os.path.realpath(directory["path"]) != directory["path"]
            or os.path.realpath(guest_directory) != guest_directory):
        raise RuntimeError("native input original host/guest directory alias differs")
    for row in directory["ancestors"]:
        actual = os.lstat(row["path"])
        if (not stat.S_ISDIR(actual.st_mode) or stat.S_ISLNK(actual.st_mode)
                or any(str(value) != row[key] for key, value in (
                    ("device", actual.st_dev), ("inode", actual.st_ino), ("mode", actual.st_mode),
                    ("uid", actual.st_uid), ("gid", actual.st_gid)))):
            raise RuntimeError("native input original directory ancestor changed")
    for name in (carrier["socket"]["path"], directory["guestSocketPath"]):
        actual = os.lstat(name)
        expected = carrier["socket"]
        if (not stat.S_ISSOCK(actual.st_mode) or actual.st_uid != os.getuid() or stat.S_IMODE(actual.st_mode) != 0o600
                or any(str(value) != expected[key] for key, value in (
                    ("device", actual.st_dev), ("inode", actual.st_ino), ("mode", actual.st_mode), ("uid", actual.st_uid)))):
            raise RuntimeError("native input original socket incarnation differs")
    return {"mountNamespaceId": os.readlink("/proc/self/ns/mnt"),
            "controllerMountNamespaceId": os.readlink("/proc/%d/ns/mnt" % carrier["controllerIdentity"]["pid"]),
            "brokerMountNamespaceId": os.readlink("/proc/%d/ns/mnt" % carrier["brokerIdentity"]["pid"]),
            "socket": carrier["socket"], "guestSocketPath": directory["guestSocketPath"]}


def install_native_descriptors(connection, expected_packet):
    received = []
    relocated = []
    installed = []
    try:
        packet, ancillary, flags, _ = connection.recvmsg(4096, socket.CMSG_SPACE(2 * array.array("i").itemsize),
                                                       socket.MSG_CMSG_CLOEXEC)
        for level, kind, data in ancillary:
            if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                values = array.array("i")
                values.frombytes(data[:len(data) - len(data) % values.itemsize])
                received.extend(values)
        if (flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC) or len(ancillary) != 1
                or ancillary[0][0:2] != (socket.SOL_SOCKET, socket.SCM_RIGHTS)
                or len(ancillary[0][2]) != 2 * array.array("i").itemsize
                or len(received) != 2 or len(set(received)) != 2
                or json.loads(packet.decode("utf8")) != expected_packet):
            raise RuntimeError("native input ancillary packet/roster is invalid")
        # Relocate BOTH sources before touching4/5; recvmsg may allocate4/5.
        for descriptor in received:
            relocated.append(fcntl.fcntl(descriptor, fcntl.F_DUPFD_CLOEXEC, 6))
        for descriptor in received:
            os.close(descriptor)
        received = []
        for index, descriptor in enumerate(relocated):
            os.dup2(descriptor, NATIVE_ROLES[index][1], inheritable=False)
            installed.append(NATIVE_ROLES[index][1])
        return installed
    except BaseException:
        for descriptor in installed:
            os.close(descriptor)
        raise
    finally:
        for descriptor in received + relocated:
            os.close(descriptor)


def run_native(control, request):
    high_control = fcntl.fcntl(control.fileno(), fcntl.F_DUPFD_CLOEXEC, 6)
    control.close()
    with os.fdopen(high_control, "r+b", buffering=0) as control:
        command = request["command"]
        environment = json.loads(request["environmentJson"])
        carrier = request["nativeInputCarrier"]
        snapshot = executable_snapshot(command, environment)
        private_tmp = observe_owned_private_tmp(request["privateTmpPlan"])
        with open("/proc/self/cgroup", encoding="utf8") as source:
            cgroup = source.read()
        registration = {"pid": os.getpid(), "nonce": secrets.token_hex(32), "authorityId": request["authorityId"],
                        "startIdentity": process_start(os.getpid()), "processGroup": os.getpgrp(), "cgroup": cgroup,
                        "command": command, "environmentDigest": "sha256:" + hashlib.sha256(request["environmentJson"].encode()).hexdigest(),
                        "executables": snapshot, "ownedPrivateTmp": private_tmp, "requiredNativeInputs": carrier}
        serialized = json.dumps(registration, separators=(",", ":"))
        write_message(control, {"registration": serialized})
        instruction_line = control.readline(262145)
        if len(instruction_line) > 262144:
            raise RuntimeError("native receive-only instruction exceeds its bound")
        instruction = json.loads(instruction_line)
        if (set(instruction) != {"receive"}
                or set(instruction["receive"]) != {"phase", "registrationSha256", "carrier", "timeoutSeconds"}
                or instruction["receive"]["phase"] != "receive-only"
                or not isinstance(instruction["receive"]["timeoutSeconds"], (int, float))
                or not 0 < instruction["receive"]["timeoutSeconds"] < float("inf")
                or instruction["receive"]["carrier"] != carrier
                or instruction["receive"]["registrationSha256"] != hashlib.sha256(serialized.encode()).hexdigest()):
            raise RuntimeError("native input receive-only instruction differs from initial registration")
        observe_native_socket(carrier, request["privateTmpPlan"])
        raw = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        high_socket = fcntl.fcntl(raw.fileno(), fcntl.F_DUPFD_CLOEXEC, 6)
        raw.close()
        received = []
        try:
            with socket.socket(fileno=high_socket) as connection:
                connection.settimeout(instruction["receive"]["timeoutSeconds"])
                connection.connect(carrier["directory"]["guestSocketPath"])
                peer = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                if (peer[0] != carrier["brokerIdentity"]["pid"] or peer[1] != os.getuid()
                        or process_start(peer[0]) != carrier["brokerIdentity"]["processStartIdentity"]):
                    raise RuntimeError("native input connected broker identity differs")
                observe_native_socket(carrier, request["privateTmpPlan"])
                nonce = secrets.token_hex(32)
                connection.sendall(json.dumps({"kind": "receive-original-collector-inputs", "nonce": nonce,
                    "authorityId": registration["authorityId"], "registrationSha256": instruction["receive"]["registrationSha256"]},
                    separators=(",", ":")).encode())
                received = install_native_descriptors(connection, {"kind": "original-collector-inputs", "nonce": nonce,
                    "authorityId": registration["authorityId"], "roles": [name for name, _ in NATIVE_ROLES]})
                observe_native_socket(carrier, request["privateTmpPlan"])
            observed = [observe_native_input(target, carrier["files"][index]["path"], carrier["files"][index])
                        for index, (_, target) in enumerate(NATIVE_ROLES)]
            left, right = [value["epoch"]["leaf"] for value in observed]
            if all(left[field] == right[field] for field in ("deviceMajor", "deviceMinor", "inode")):
                raise RuntimeError("native input fixed roles alias one inode")
            registration["nativeInputs"] = {"carrier": carrier, "files": observed,
                "liveObservation": observe_native_socket(carrier, request["privateTmpPlan"]),
                "descriptorFlags": [{"targetDescriptor": target, "getfl": fcntl.fcntl(target, fcntl.F_GETFL),
                    "cloexec": bool(fcntl.fcntl(target, fcntl.F_GETFD) & fcntl.FD_CLOEXEC)}
                    for _, target in NATIVE_ROLES]}
            final = json.dumps(registration, separators=(",", ":"))
            write_message(control, {"registration": final})
            release_line = control.readline(262145)
            if len(release_line) > 262144 or json.loads(release_line) != {"release": final}:
                raise RuntimeError("native final release differs from complete input registration")
            if (executable_snapshot(command, environment) != snapshot
                    or observe_owned_private_tmp(request["privateTmpPlan"]) != private_tmp):
                raise RuntimeError("native executable/privateTmp changed before final exec")
            if observe_native_socket(carrier, request["privateTmpPlan"]) != registration["nativeInputs"]["liveObservation"]:
                raise RuntimeError("native original namespace/socket binding changed before exec")
            if process_start(carrier["controllerIdentity"]["pid"]) != carrier["controllerIdentity"]["processStartIdentity"]:
                raise RuntimeError("native original parent changed before final exec")
            if [observe_native_input(target, carrier["files"][index]["path"], carrier["files"][index])
                    for index, (_, target) in enumerate(NATIVE_ROLES)] != observed:
                raise RuntimeError("native original inputs changed before final exec")
            if [{"targetDescriptor": target, "getfl": fcntl.fcntl(target, fcntl.F_GETFL),
                    "cloexec": bool(fcntl.fcntl(target, fcntl.F_GETFD) & fcntl.FD_CLOEXEC)}
                    for _, target in NATIVE_ROLES] != registration["nativeInputs"]["descriptorFlags"]:
                raise RuntimeError("native descriptor flags changed before final exec")
            for target in received:
                os.set_inheritable(target, True)
            for name in ("SIGPIPE", "SIGXFZ", "SIGXFSZ"):
                if hasattr(signal, name):
                    signal.signal(getattr(signal, name), signal.SIG_DFL)
            try:
                execute(command, environment, snapshot)
            except OSError as error:
                write_message(control, {"spawnError": {"name": "Error", "code": errno.errorcode.get(error.errno), "message": str(error)}})
                return 127
        finally:
            for descriptor in received:
                os.close(descriptor)


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
        if request.get("nativeInputCarrier") is not None:
            return run_native(control, request)
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
