"""Private Unix transport for the existing physical execution owner, not an executor."""

import asyncio
import json
import os
import socket
import struct
import sys


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


async def serve(socket_path, maximum_bytes, startup_seconds, drain_seconds):
    loop = asyncio.get_event_loop()
    connections = {}
    tasks = set()
    stopped = asyncio.Event()
    next_id = 0

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
            stopped.set()

    server = await loop.create_unix_server(protocol_factory, path=socket_path)
    os.chmod(socket_path, 0o600)
    emit({"kind": "ready", "pid": os.getpid()})
    response_task = loop.create_task(responses())
    try:
        await stopped.wait()
    finally:
        server.close()
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
        event_loop.run_until_complete(serve(sys.argv[1], int(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4])))
    finally:
        event_loop.close()
