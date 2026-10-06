"""Private Unix transport for the existing physical execution owner, not an executor."""

import asyncio
import array
import fcntl
import hashlib
import json
import os
import select
import socket
import stat
import struct
import sys
import types


class NativeInputListener:
    """One raw fixed-roster carrier; the ordinary StreamReader never consumes it."""

    def __init__(self, manifest, emit, loop, timeout):
        if set(manifest) != {"directory", "controllerIdentity", "files", "preexecSha256"}:
            raise RuntimeError("native carrier startup data roster differs")
        self.manifest = manifest
        self.emit = emit
        self.loop = loop
        self.timeout = timeout
        self.closed = False
        self.consumed = False
        self.pending = {}
        self.tasks = set()
        self.descriptors = []
        self.socket = None
        self.accept_task = None
        helper_path = os.path.join(os.path.dirname(os.path.realpath(__file__)), "physical-execution-linux-preexec.py")
        with open(helper_path, "rb") as source:
            helper_bytes = source.read(1024 * 1024 + 1)
            if len(helper_bytes) > 1024 * 1024 or hashlib.sha256(helper_bytes).hexdigest() != manifest["preexecSha256"]:
                raise RuntimeError("native fixed source-bound preexec helper differs")
        self.helper = types.ModuleType("fsus_original_native_preexec")
        self.helper.__file__ = helper_path
        exec(compile(helper_bytes, helper_path, "exec"), self.helper.__dict__)
        try:
            self.ensure_parent()
            # Source4/5/6 are occupied stdio mappings; relocate without clobbering loop/control FDs.
            for original in (4, 5, 6):
                os.set_inheritable(original, False)
                self.descriptors.append(fcntl.fcntl(original, fcntl.F_DUPFD_CLOEXEC, 8))
            for original in (4, 5, 6):
                os.close(original)
            self.validate_files()
            directory = os.fstat(self.descriptors[2])
            reference = manifest["directory"]
            if (not stat.S_ISDIR(directory.st_mode)
                    or str(directory.st_dev) != reference["device"] or str(directory.st_ino) != reference["inode"]
                    or directory.st_uid != os.getuid() or directory.st_mode & 0o7777 != 0o700):
                raise RuntimeError("native inherited directory identity differs")
            os.fchdir(self.descriptors[2])
            if os.getcwd() != reference["path"]:
                raise RuntimeError("native broker held cwd is not the original directory")
            self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
            self.socket.set_inheritable(False)
            self.socket.bind("inputs.sock")
            os.chmod("inputs.sock", 0o600)
            self.socket.listen(4)
            self.socket.setblocking(False)
            created = os.lstat("inputs.sock")
            if not stat.S_ISSOCK(created.st_mode) or created.st_uid != os.getuid() or stat.S_IMODE(created.st_mode) != 0o600:
                raise RuntimeError("native created socket identity is not private")
            self.created_socket = {"path": os.path.join(reference["path"], "inputs.sock"),
                "device": str(created.st_dev), "inode": str(created.st_ino), "mode": str(created.st_mode), "uid": str(created.st_uid)}
        except BaseException:
            if self.socket is not None:
                self.socket.close()
            for descriptor in self.descriptors:
                os.close(descriptor)
            raise

    def ensure_parent(self):
        identity = self.manifest["controllerIdentity"]
        admission_pipe = select.poll()
        admission_pipe.register(0, select.POLLHUP | select.POLLERR | select.POLLNVAL)
        pipe_closed = any(flags & (select.POLLHUP | select.POLLERR | select.POLLNVAL)
                          for _, flags in admission_pipe.poll(0))
        if (pipe_closed or self.closed or os.getppid() != identity["pid"]
                or self.helper.process_start(identity["pid"]) != identity["processStartIdentity"]):
            raise RuntimeError("native original parent admission is closed")

    def validate_files(self):
        files = self.manifest["files"]
        if len(files) != 2 or [(item["role"], item["targetDescriptor"]) for item in files] != list(self.helper.NATIVE_ROLES):
            raise RuntimeError("native original fixed role roster differs")
        for index in range(2):
            self.helper.observe_native_input(self.descriptors[index], files[index]["path"], files[index])
        left, right = [os.fstat(descriptor) for descriptor in self.descriptors[:2]]
        if (left.st_dev, left.st_ino) == (right.st_dev, right.st_ino):
            raise RuntimeError("native original input roles alias one inode")

    async def readable(self, connection, writing=False):
        future = self.loop.create_future()
        def ready():
            if not future.done():
                future.set_result(None)
        add = self.loop.add_writer if writing else self.loop.add_reader
        remove = self.loop.remove_writer if writing else self.loop.remove_reader
        add(connection.fileno(), ready)
        try:
            await asyncio.wait_for(future, self.timeout)
        finally:
            remove(connection.fileno())

    async def accept(self):
        while not self.closed:
            connection, _ = await self.loop.sock_accept(self.socket)
            connection.set_inheritable(False)
            task = self.loop.create_task(self.receive(connection))
            self.tasks.add(task)
            task.add_done_callback(self.tasks.discard)

    async def receive(self, connection):
        request_id = None
        unexpected = []
        try:
            self.ensure_parent()
            peer = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if peer[1] != os.getuid():
                raise RuntimeError("native input peer UID differs")
            await self.readable(connection)
            self.ensure_parent()
            packet, ancillary, flags, _ = connection.recvmsg(4096, socket.CMSG_SPACE(16 * array.array("i").itemsize),
                                                           socket.MSG_CMSG_CLOEXEC)
            for level, kind, data in ancillary:
                if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                    values = array.array("i")
                    values.frombytes(data[:len(data) - len(data) % values.itemsize])
                    unexpected.extend(values)
            if ancillary or flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC):
                raise RuntimeError("native input request must not contain ancillary data")
            request = json.loads(packet.decode("utf8"))
            if (set(request) != {"kind", "nonce", "authorityId", "registrationSha256"}
                    or request["kind"] != "receive-original-collector-inputs"
                    or len(request["nonce"]) != 64 or any(char not in "0123456789abcdef" for char in request["nonce"])
                    or self.consumed):
                raise RuntimeError("native input request roster/state differs")
            request_id = "native-" + request["nonce"]
            if request_id in self.pending:
                raise RuntimeError("native input request nonce replayed")
            identity = self.helper.process_start(peer[0])
            authorization = self.loop.create_future()
            self.pending[request_id] = {"future": authorization, "request": request,
                "peer": {"pid": peer[0], "uid": peer[1], "startIdentity": identity}}
            self.emit({"kind": "native-input-request", "id": request_id,
                "peer": {"pid": peer[0], "uid": peer[1], "gid": peer[2]}, "request": request})
            granted = await asyncio.wait_for(authorization, self.timeout)
            self.ensure_parent()
            if self.consumed or granted["peer"] != self.pending[request_id]["peer"]:
                raise RuntimeError("native input authorization differs from actual peer")
            with open("/proc/%d/cgroup" % peer[0], encoding="utf8") as source:
                if source.read() != granted["cgroup"]:
                    raise RuntimeError("native input registered peer cgroup changed")
            if self.helper.process_start(peer[0]) != identity:
                raise RuntimeError("native input registered peer start changed")
            self.validate_files()
            self.ensure_parent()
            self.consumed = True
            response = json.dumps({"kind": "original-collector-inputs", "nonce": request["nonce"],
                "authorityId": request["authorityId"], "roles": [item[0] for item in self.helper.NATIVE_ROLES]},
                separators=(",", ":")).encode()
            descriptors = array.array("i", self.descriptors[:2])
            while True:
                self.ensure_parent()
                if self.helper.process_start(peer[0]) != identity:
                    raise RuntimeError("native input peer died before delivery")
                with open("/proc/%d/cgroup" % peer[0], encoding="utf8") as source:
                    if source.read() != granted["cgroup"]:
                        raise RuntimeError("native input peer containment changed before delivery")
                try:
                    count = connection.sendmsg([response], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, descriptors)])
                    if count != len(response):
                        raise RuntimeError("native input sequenced packet is incomplete")
                    break
                except BlockingIOError:
                    await self.readable(connection, writing=True)
            self.emit({"kind": "native-input-delivered", "id": request_id})
        except (ValueError, KeyError, TypeError, RuntimeError, OSError, asyncio.TimeoutError):
            if request_id is not None:
                self.emit({"kind": "native-input-refused", "id": request_id})
        finally:
            for descriptor in unexpected:
                os.close(descriptor)
            self.pending.pop(request_id, None)
            connection.close()

    def authorize(self, message):
        self.ensure_parent()
        if set(message) != {"kind", "id", "request", "peer", "cgroup"} or message["kind"] != "authorize-native-inputs":
            raise RuntimeError("native parent authorization roster differs")
        pending = self.pending.get(message["id"])
        if (self.consumed or pending is None or pending["future"].done()
                or pending["request"] != message["request"] or pending["peer"] != message["peer"]):
            raise RuntimeError("native parent authorization is stale or replayed")
        pending["future"].set_result(message)

    async def close(self):
        self.closed = True
        self.socket.close()
        if self.accept_task:
            self.accept_task.cancel()
        tasks = list(self.tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*(tasks + ([self.accept_task] if self.accept_task else [])), return_exceptions=True)
        for descriptor in self.descriptors:
            os.close(descriptor)


class ConnectionProtocol(asyncio.StreamReaderProtocol):
    """Observe actual transport close without requiring post-3.6 wait_closed()."""

    def __init__(self, reader, connected):
        super().__init__(reader, connected)
        self.closed = asyncio.get_event_loop().create_future()

    def connection_lost(self, error):
        try:
            super().connection_lost(error)
        finally:
            if not self.closed.done():
                self.closed.set_result(None)


async def serve(socket_path, maximum_bytes, startup_seconds, drain_seconds, native_manifest=None):
    loop = asyncio.get_event_loop()
    connections = {}
    tasks = set()
    stopped = asyncio.Event()
    next_id = 0
    native = None

    def emit(message):
        data = (json.dumps(message, separators=(",", ":")) + "\n").encode()
        if len(data) > maximum_bytes:
            raise ValueError("nested execution transport message exceeds its bound")
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()

    async def accept(reader, writer, closed):
        nonlocal next_id
        connection_id = next_id
        next_id += 1
        raw = writer.get_extra_info("socket").getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
        pid, uid, gid = struct.unpack("3i", raw)
        if uid != os.getuid():
            writer.close()
            await asyncio.wait_for(asyncio.shield(closed), drain_seconds)
            return
        connections[connection_id] = writer
        try:
            line = await asyncio.wait_for(reader.readline(), startup_seconds)
            if not line or len(line) > maximum_bytes:
                raise ValueError("nested execution request is missing or oversized")
            emit({"kind": "request", "id": connection_id, "peer": {"pid": pid, "uid": uid, "gid": gid},
                  "request": json.loads(line)})
            while True:
                line = await reader.readline()
                if not line:
                    break
                if json.loads(line) != {"kind": "cancel"}:
                    raise ValueError("nested execution accepts only cancellation after its request")
                emit({"kind": "cancel", "id": connection_id})
        except (ValueError, ConnectionError, asyncio.LimitOverrunError, asyncio.TimeoutError):
            pass
        finally:
            try:
                emit({"kind": "disconnect", "id": connection_id})
            except BrokenPipeError:
                # The original owner may have exited without reading this terminal notice.
                pass
            finally:
                connections.pop(connection_id, None)
                writer.close()
                try:
                    await asyncio.wait_for(asyncio.shield(closed), drain_seconds)
                except (ConnectionError, asyncio.TimeoutError):
                    writer.transport.abort()

    def start_connection(reader, writer, closed):
        task = loop.create_task(accept(reader, writer, closed))
        tasks.add(task)
        task.add_done_callback(tasks.discard)

    def protocol_factory():
        reader = asyncio.StreamReader(limit=maximum_bytes)
        protocol = ConnectionProtocol(reader, lambda source, writer: start_connection(source, writer, protocol.closed))
        return protocol

    async def responses():
        reader = asyncio.StreamReader(limit=maximum_bytes)
        await loop.connect_read_pipe(
            lambda: asyncio.StreamReaderProtocol(reader), sys.stdin.buffer)
        try:
            while True:
                line = await reader.readline()
                if not line:
                    break
                message = json.loads(line)
                if message == {"kind": "shutdown"}:
                    break
                if message.get("kind") == "authorize-native-inputs" and native is not None:
                    native.authorize(message)
                    continue
                writer = connections.get(message["id"])
                if writer is not None:
                    data = (json.dumps(message["message"], separators=(",", ":")) + "\n").encode()
                    if len(data) > maximum_bytes:
                        raise ValueError("nested execution response exceeds its bound")
                    try:
                        writer.write(data)
                        await asyncio.wait_for(writer.drain(), drain_seconds)
                    except (ConnectionError, asyncio.TimeoutError):
                        writer.transport.abort()
        finally:
            if native is not None:
                native.closed = True
            stopped.set()

    server = await loop.create_unix_server(protocol_factory, path=socket_path)
    os.chmod(socket_path, 0o600)
    if native_manifest is not None:
        native = NativeInputListener(native_manifest, emit, loop, startup_seconds)
        native.accept_task = loop.create_task(native.accept())
    readiness = {"kind": "ready", "pid": os.getpid()}
    if native is not None:
        readiness["nativeInputSocket"] = native.created_socket
    emit(readiness)
    response_task = loop.create_task(responses())
    try:
        await stopped.wait()
    finally:
        server.close()
        if native is not None:
            await native.close()
        pending = list(tasks)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        # Python 3.12 waits for active peers here; their tasks must close them first.
        await asyncio.wait_for(server.wait_closed(), drain_seconds)
        await response_task


if __name__ == "__main__":
    if sys.platform != "linux" or sys.version_info < (3, 6):
        raise RuntimeError("nested physical execution requires Linux Python 3.6 or newer")
    event_loop = asyncio.new_event_loop()
    asyncio.set_event_loop(event_loop)
    try:
        event_loop.run_until_complete(serve(sys.argv[1], int(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4]),
                                           json.loads(sys.argv[5]) if len(sys.argv) == 6 else None))
    finally:
        event_loop.close()
