#!/usr/bin/env python3

import ctypes
import errno
import json
import os
import struct
import sys


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


def process_environment(pid):
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
    buffer = ctypes.create_string_buffer(size.value)
    if libc.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0) != 0:
        raise OSError(ctypes.get_errno(), "KERN_PROCARGS2 query failed")

    raw = buffer.raw[: size.value]
    argc = struct.unpack_from("=i", raw)[0]
    cursor = ctypes.sizeof(ctypes.c_int)
    cursor = raw.index(b"\0", cursor) + 1
    while cursor < len(raw) and raw[cursor] == 0:
        cursor += 1
    for _ in range(argc):
        cursor = raw.index(b"\0", cursor) + 1

    environment = {}
    for entry in raw[cursor:].split(b"\0"):
        if b"=" not in entry:
            continue
        key, value = entry.split(b"=", 1)
        decoded_key = key.decode("utf-8", "surrogateescape")
        if decoded_key.startswith("FSUSBLOG_"):
            environment[decoded_key] = value.decode("utf-8", "surrogateescape")
    return environment


def main():
    try:
        pid = int(sys.argv[1])
        print(
            json.dumps(
                {
                    "processGroupId": os.getpgid(pid),
                    "sessionId": os.getsid(pid),
                    "startTimeTicks": process_start_identity(pid),
                    "environment": process_environment(pid),
                },
                separators=(",", ":"),
            )
        )
    except (ProcessLookupError, OSError) as error:
        if getattr(error, "errno", None) == errno.ESRCH:
            raise SystemExit(3) from None
        raise


if __name__ == "__main__":
    main()
