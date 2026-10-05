#!/usr/bin/env python3

import ctypes
import errno
import json
import os
import struct
import sys

provider_binding_keys = frozenset(
    (
        "FSUSBLOG_BROWSER_CONTRACT_PROVIDER_INVOCATION_ID",
        "FSUSBLOG_PLAYWRIGHT_SESSION_MODE",
        "FSUSBLOG_TEST_NAMESPACE",
        "FSUSBLOG_FIXTURE_ROOT",
    )
)
provider_snapshot_limit_bytes = 1024 * 1024


class ProcBsdInfo(ctypes.Structure):
    _fields_ = [
        ("header", ctypes.c_uint32 * 12),
        ("command", ctypes.c_char * 16),
        ("name", ctypes.c_char * 32),
        ("tail", ctypes.c_uint32 * 5),
        ("nice", ctypes.c_int32),
        ("start_sec", ctypes.c_uint64),
        ("start_usec", ctypes.c_uint64),
    ]


def process_start_identity(pid):
    libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    libproc.proc_pidinfo.argtypes = [
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_uint64,
        ctypes.c_void_p,
        ctypes.c_int,
    ]
    libproc.proc_pidinfo.restype = ctypes.c_int
    info = ProcBsdInfo()
    size = libproc.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info))
    if size != ctypes.sizeof(info) or info.start_sec <= 0 or info.start_usec >= 1_000_000:
        raise OSError(ctypes.get_errno(), "proc_pidinfo failed")
    return str(info.start_sec * 1_000_000 + info.start_usec)


def process_environment(pid, provider_bindings=False):
    libc = ctypes.CDLL("/usr/lib/libc.dylib", use_errno=True)
    libc.sysctl.argtypes = [
        ctypes.POINTER(ctypes.c_int),
        ctypes.c_uint,
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_size_t),
        ctypes.c_void_p,
        ctypes.c_size_t,
    ]
    libc.sysctl.restype = ctypes.c_int
    mib = (ctypes.c_int * 3)(1, 49, pid)
    size = ctypes.c_size_t()
    if libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0) != 0:
        raise OSError(ctypes.get_errno(), "KERN_PROCARGS2 size query failed")
    if provider_bindings and not ctypes.sizeof(ctypes.c_int) < size.value <= provider_snapshot_limit_bytes:
        raise ValueError("provider process arguments exceed the bounded snapshot size")
    allocated_size = size.value
    buffer = ctypes.create_string_buffer(size.value)
    if libc.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0) != 0:
        raise OSError(ctypes.get_errno(), "KERN_PROCARGS2 query failed")
    if provider_bindings and not ctypes.sizeof(ctypes.c_int) < size.value <= allocated_size:
        raise ValueError("provider process argument size changed beyond the allocated bound")

    raw = buffer.raw[: size.value]
    argc = struct.unpack_from("=i", raw)[0]
    if provider_bindings and (argc < 1 or argc > len(raw) or raw[-1] != 0):
        raise ValueError("provider process argument framing is invalid")
    cursor = ctypes.sizeof(ctypes.c_int)
    executable_end = raw.index(b"\0", cursor)
    if provider_bindings:
        validate_provider_text(raw[cursor:executable_end])
    cursor = raw.index(b"\0", cursor) + 1
    while cursor < len(raw) and raw[cursor] == 0:
        cursor += 1
    for _ in range(argc):
        argument_end = raw.index(b"\0", cursor)
        if provider_bindings:
            validate_provider_text(raw[cursor:argument_end])
        cursor = argument_end + 1

    environment = {}
    for entry in raw[cursor:].split(b"\0"):
        if provider_bindings:
            validate_provider_text(entry)
        if b"=" not in entry:
            continue
        key, value = entry.split(b"=", 1)
        decoded_key = key.decode("utf-8", "strict" if provider_bindings else "surrogateescape")
        if provider_bindings:
            if decoded_key in provider_binding_keys:
                if decoded_key in environment:
                    raise ValueError("provider environment binding is duplicated")
                environment[decoded_key] = value.decode("utf-8", "strict")
        elif decoded_key.startswith("FSUSBLOG_"):
            environment[decoded_key] = value.decode("utf-8", "surrogateescape")
    if provider_bindings and set(environment) != provider_binding_keys:
        raise ValueError("provider environment binding is incomplete")
    return environment


def validate_provider_text(raw):
    text = raw.decode("utf-8", "strict")
    if any(ord(character) < 32 or 127 <= ord(character) <= 159 for character in text):
        raise ValueError("provider process text contains control bytes")


def main():
    try:
        if len(sys.argv) not in (2, 3) or (len(sys.argv) == 3 and sys.argv[2] != "--provider-bindings"):
            raise ValueError("invalid process snapshot arguments")
        pid = int(sys.argv[1])
        if pid <= 0:
            raise ValueError("invalid process snapshot PID")
        provider_bindings = len(sys.argv) == 3
        output = json.dumps(
            {
                "processGroupId": os.getpgid(pid),
                "sessionId": os.getsid(pid),
                "startTimeTicks": process_start_identity(pid),
                "environment": process_environment(pid, provider_bindings=provider_bindings),
            },
            separators=(",", ":"),
        )
        if provider_bindings and len(output.encode("utf-8")) + 1 > provider_snapshot_limit_bytes:
            raise ValueError("provider snapshot output exceeds the bounded size")
        print(output)
    except (ProcessLookupError, OSError) as error:
        if getattr(error, "errno", None) == errno.ESRCH:
            raise SystemExit(3) from None
        raise


if __name__ == "__main__":
    main()
