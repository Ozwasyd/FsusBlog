#!/usr/bin/env python3
"""Capture and verify a private offline PostgreSQL + media backup candidate."""

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import PurePath
import re
import selectors
import stat
import subprocess
import sys
import time


class BackupError(RuntimeError):
    pass


MANIFEST = "manifest.json"
DUMP = "database.dump"
MEDIA = "media"
MAX_MANIFEST = 2_000_000
MAX_MEDIA_BYTES = 100 * 1024**3
HASH = re.compile(r"[0-9a-f]{64}")
ID = re.compile(r"[0-9a-f]{32}")
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
PG_MAJOR = re.compile(r"pg_dump \(PostgreSQL\) ([0-9]{1,2})[.]")


def ensure(condition, message):
    if not condition:
        raise BackupError(message)


@contextlib.contextmanager
def open_directory(path):
    """Anchor every path component without following links."""
    parts = PurePath(path).parts
    ensure(parts and parts[0] == "/" and ".." not in parts, "Use an absolute path with no '..' elements.")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    current = os.open("/", flags)
    try:
        for part in parts[1:]:
            leaf = os.open(part, flags, dir_fd=current)
            os.close(current)
            current = leaf
        check_directory(current)
        yield current
    finally:
        os.close(current)


def check_directory(fd):
    value = os.fstat(fd)
    ensure(stat.S_ISDIR(value.st_mode) and value.st_uid == os.getuid() and
           stat.S_IMODE(value.st_mode) == 0o700, "A directory must be owned by this user with mode 0700.")


@contextlib.contextmanager
def directory_child(parent, name, create=False):
    if create:
        os.mkdir(name, 0o700, dir_fd=parent)
    child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
    try:
        check_directory(child)
        yield child
    finally:
        os.close(child)


@contextlib.contextmanager
def read_file(directory, name):
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
    with os.fdopen(os.open(name, flags, dir_fd=directory), "rb") as file:
        info = os.fstat(file.fileno())
        ensure(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and
               info.st_nlink == 1 and stat.S_IMODE(info.st_mode) in (0o400, 0o600),
               "Backup contents must be private regular files with one link.")
        yield file


@contextlib.contextmanager
def new_file(directory, name):
    flags = os.O_WRONLY | os.O_NOFOLLOW | os.O_EXCL | os.O_CREAT | os.O_CLOEXEC
    with os.fdopen(os.open(name, flags, 0o600, dir_fd=directory), "wb") as file:
        yield file
        file.flush()
        os.fsync(file.fileno())


def json_document(data):
    def no_duplicates(pairs):
        result = {}
        for key, value in pairs:
            ensure(key not in result, "Duplicate backup manifest property.")
            result[key] = value
        return result

    def reject_constant(_):
        raise BackupError("Invalid numeric value in backup metadata.")

    ensure(0 < len(data) <= MAX_MANIFEST, "Backup metadata exceeds its input limit.")
    return json.loads(data, object_pairs_hook=no_duplicates, parse_constant=reject_constant)


def require_keys(value, fields):
    ensure(isinstance(value, dict) and set(value) == set(fields.split()),
           "Backup metadata does not match its declared shape.")


def is_hash(value):
    return isinstance(value, str) and HASH.fullmatch(value) is not None


def media_items(values):
    ensure(isinstance(values, list) and len(values) <= 5000, "Invalid backup media list.")
    files = {}
    for row in values:
        require_keys(row, "id bytes sha256")
        ident, length, digest = row["id"], row["bytes"], row["sha256"]
        ensure(isinstance(ident, str) and ID.fullmatch(ident) and
               type(length) is int and 0 < length <= 20 * 1024**2 and is_hash(digest),
               "Invalid backup media entry.")
        leaf = f"{ident}.media"
        ensure(leaf not in files, "Duplicate backup media entry.")
        files[leaf] = (length, digest)
    return files


def validate_site(site):
    require_keys(site, "version schemaVersion postgreSqlMajor relations media")
    ensure(type(site["version"]) is int and site["version"] == 1 and
           type(site["schemaVersion"]) is int and site["schemaVersion"] > 0 and
           isinstance(site["postgreSqlMajor"], str) and
           re.fullmatch(r"[0-9]{1,2}", site["postgreSqlMajor"]), "Unsupported backup measurement version.")
    ensure(isinstance(site["relations"], list) and 1 <= len(site["relations"]) <= 200,
           "Invalid backup relation count.")
    unique = set()
    for row in site["relations"]:
        require_keys(row, "name kind rows sha256")
        ensure(isinstance(row["name"], str) and 0 < len(row["name"]) <= 63 and
               row["kind"] in ("r", "S") and type(row["rows"]) is int and
               0 <= row["rows"] <= 1_000_000 and is_hash(row["sha256"]),
               "Invalid backup relation measurement.")
        ensure(row["name"] not in unique, "Duplicate backup relation measurement.")
        unique.add(row["name"])
    ensure({"v2_schema", "private_media"} <= unique, "Backup lacks required business relations.")
    return media_items(site["media"])


def copy_checked(file, destination=None, limit=MAX_MEDIA_BYTES):
    before = os.fstat(file.fileno())
    ensure(0 < before.st_size <= limit, "Backup file size exceeds its bound.")
    sha = hashlib.sha256()
    count = 0
    for chunk in iter(lambda: file.read(1024 * 1024), b""):
        count += len(chunk)
        ensure(count <= limit, "Backup file size exceeds its bound.")
        sha.update(chunk)
        if destination is not None:
            destination.write(chunk)
    after = os.fstat(file.fileno())
    ensure(count == before.st_size == after.st_size and before.st_ctime_ns == after.st_ctime_ns and
           before.st_mtime_ns == after.st_mtime_ns, "Backup file changed during read.")
    return count, sha.hexdigest()


def check_media(directory, files, destination=None):
    ensure(set(os.listdir(directory)) == files.keys(), "Media directory contains missing or unexpected files.")
    ensure(sum(value[0] for value in files.values()) <= MAX_MEDIA_BYTES, "Media snapshot exceeds its byte limit.")
    for name, measurement in files.items():
        with read_file(directory, name) as file:
            if destination is None:
                observed = copy_checked(file, limit=20 * 1024**2)
            else:
                with new_file(destination, name) as target:
                    observed = copy_checked(file, target, limit=20 * 1024**2)
            ensure(observed == measurement, "Private media bytes differ from committed metadata.")


def check_separate_roots(parent, media_root):
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    for lower, outside in ((parent, media_root), (media_root, parent)):
        expected = os.fstat(outside)
        current = os.dup(lower)
        try:
            while True:
                ancestor = os.fstat(current)
                ensure((ancestor.st_dev, ancestor.st_ino) != (expected.st_dev, expected.st_ino),
                       "The backup parent and live media tree must be separate.")
                next_fd = os.open("..", flags, dir_fd=current)
                upper = os.fstat(next_fd)
                os.close(current)
                current = next_fd
                if (ancestor.st_dev, ancestor.st_ino) == (upper.st_dev, upper.st_ino):
                    break
        finally:
            os.close(current)


def read_measurement(child):
    deadline = time.monotonic() + 310
    payload = bytearray()
    with selectors.DefaultSelector() as selector:
        selector.register(child.stdout, selectors.EVENT_READ)
        while b"\n" not in payload:
            remaining = deadline - time.monotonic()
            ensure(remaining > 0 and selector.select(timeout=remaining),
                   "Database measurement did not finish within its deadline.")
            block = os.read(child.stdout.fileno(), 65_536)
            if not block:
                failure = child.stderr.readline(8192).decode("utf-8", "replace").strip()
                if failure.startswith(("Stop the v2 writer", "Settle pending", "Finish or cancel staged",
                                       "The v2 backup database has admitted writes")):
                    raise BackupError(failure)
                raise BackupError("Database measurement did not produce a complete report.")
            payload.extend(block)
            ensure(len(payload) <= MAX_MANIFEST, "Database measurement exceeded its output limit.")
    return json_document(payload)


def extract_measurement(data, hold):
    require_keys(data, "version schemaVersion postgreSqlMajor relations media database host port exportedSnapshot")
    name = data.pop("database")
    host = data.pop("host")
    port = data.pop("port")
    snapshot = data.pop("exportedSnapshot")
    ensure(isinstance(name, str) and NAME.fullmatch(name), "Set a simple explicit PostgreSQL database name.")
    ensure(isinstance(host, str) and 0 < len(host) <= 255 and "," not in host and
           not any(ord(char) < 32 for char in host) and type(port) is int and 0 < port < 65_536,
           "Set a single explicit PostgreSQL database endpoint.")
    ensure((hold and isinstance(snapshot, str) and re.fullmatch(r"[0-9A-Fa-f-]{5,80}", snapshot)) or
           (not hold and snapshot is None), "Expected a PostgreSQL snapshot from the capture helper.")
    return (name, host, port), snapshot, validate_site(data)


def dump_command(endpoint, major, snapshot):
    name, host, port = endpoint
    ensure(os.environ.get("PGDATABASE") == name and os.environ.get("PGHOST") == host and
           os.environ.get("PGPORT") == str(port) and not os.environ.get("PGHOSTADDR") and
           not os.environ.get("PGSERVICE"), "libpq must use the same source database, host and port as FSUSBLOG_DB.")
    binary = os.environ.get("PG_DUMP_BIN", "pg_dump")
    version = subprocess.run([binary, "--version"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             check=True, text=True, timeout=5)
    match = PG_MAJOR.search(version.stdout)
    ensure(match and match.group(1) == major, "pg_dump and source PostgreSQL major versions differ.")
    return [binary, "--no-password", "--format=custom", f"--dbname={name}", f"--host={host}", f"--port={port}",
            f"--snapshot={snapshot}", "--lock-wait-timeout=5000"]


def migrate_command():
    binary = os.environ.get("DOTNET_BIN", "dotnet")
    assembly = os.environ.get("FSUSBLOG_MIGRATE_DLL", "src/Migrate/bin/Release/net10.0/FsusBlogV2.Migrate.dll")
    return [binary, assembly, "backup", "measure"]


def terminate_child(child):
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()


def capture(parent_path, leaf, media_path):
    ensure(NAME.fullmatch(leaf) and leaf not in (".", ".."), "Choose a simple new backup directory name.")
    with open_directory(parent_path) as parent, open_directory(media_path) as media_root:
        check_separate_roots(parent, media_root)
        fcntl.flock(media_root, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # No replace path exists: the candidate is visible only as a directory without a manifest until completion.
        with directory_child(parent, leaf, create=True) as backup:
            database = None
            complete = False
            try:
                database = subprocess.Popen(migrate_command() + ["--hold-snapshot"], stdin=subprocess.PIPE,
                                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                site = read_measurement(database)
                endpoint, snapshot, files = extract_measurement(site, hold=True)
                args = dump_command(endpoint, site["postgreSqlMajor"], snapshot)
                with new_file(backup, DUMP) as dump:
                    try:
                        subprocess.run(args, stdout=dump, stderr=subprocess.DEVNULL, check=True, timeout=240)
                    except subprocess.CalledProcessError as error:
                        raise BackupError("pg_dump failed on the exported backup snapshot.") from error
                with directory_child(backup, MEDIA, create=True) as target:
                    check_media(media_root, files, target)
                    os.fsync(target)
                database.stdin.write(b"finish\n")
                database.stdin.flush()
                ensure(database.wait(timeout=5) == 0, "The source snapshot did not finish cleanly.")
                with read_file(backup, DUMP) as dump:
                    ensure(dump.read(5) == b"PGDMP", "Expected a PostgreSQL custom-format dump.")
                    dump.seek(0)
                    length, digest = copy_checked(dump)
                document = {"format": "fsusblog-offline-backup-candidate-v1",
                            "databaseDump": {"bytes": length, "sha256": digest}, "site": site}
                encoded = json.dumps(document, sort_keys=True, separators=(",", ":")).encode() + b"\n"
                with new_file(backup, MANIFEST) as manifest:
                    manifest.write(encoded)
                os.fsync(backup)
                os.fsync(parent)
                complete = True
            finally:
                if database is not None:
                    terminate_child(database)
                    database.stdin.close()
                    database.stdout.close()
                    database.stderr.close()
                if not complete:
                    clear_incomplete(parent, leaf, backup)
    print(f"Backup candidate manifest SHA-256: {hashlib.sha256(encoded).hexdigest()}")


def clear_incomplete(parent, leaf, backup):
    # Only remove the exact newly created candidate and names beneath its anchored descriptor.
    with contextlib.suppress(FileNotFoundError):
        with directory_child(backup, MEDIA) as media:
            for name in os.listdir(media):
                ensure(name.endswith(".media") and ID.fullmatch(name[:-6]), "Unexpected staging media leaf.")
                os.unlink(name, dir_fd=media)
        os.rmdir(MEDIA, dir_fd=backup)
    for name in (MANIFEST, DUMP):
        with contextlib.suppress(FileNotFoundError):
            os.unlink(name, dir_fd=backup)
    identity = os.fstat(backup)
    final = os.stat(leaf, dir_fd=parent, follow_symlinks=False)
    ensure((identity.st_dev, identity.st_ino) == (final.st_dev, final.st_ino),
           "Aborted backup directory identity changed before cleanup.")
    os.rmdir(leaf, dir_fd=parent)


def verify(path, expected):
    ensure(is_hash(expected), "Provide the expected manifest SHA-256 from independent custody.")
    with open_directory(path) as backup:
        ensure(set(os.listdir(backup)) == {MANIFEST, DUMP, MEDIA}, "Unexpected backup candidate contents.")
        with read_file(backup, MANIFEST) as manifest:
            encoded = manifest.read(MAX_MANIFEST + 1)
        ensure(hashlib.sha256(encoded).hexdigest() == expected, "Backup manifest digest differs.")
        document = json_document(encoded)
        require_keys(document, "format databaseDump site")
        ensure(document["format"] == "fsusblog-offline-backup-candidate-v1", "Unsupported backup manifest format.")
        require_keys(document["databaseDump"], "bytes sha256")
        files = validate_site(document["site"])
        ensure(type(document["databaseDump"]["bytes"]) is int and 5 < document["databaseDump"]["bytes"] <= MAX_MEDIA_BYTES
               and is_hash(document["databaseDump"]["sha256"]), "Invalid backup dump measurement.")
        with read_file(backup, DUMP) as dump:
            ensure(dump.read(5) == b"PGDMP", "Expected a PostgreSQL custom-format dump.")
            dump.seek(0)
            count, digest = copy_checked(dump)
        ensure(document["databaseDump"] == {"bytes": count, "sha256": digest}, "Backup database dump digest differs.")
        with directory_child(backup, MEDIA) as media:
            check_media(media, files)
    return document["site"]


def verify_restored(path, expected, media_path):
    source = verify(path, expected)
    result = subprocess.run(migrate_command(), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            check=False, timeout=310)
    ensure(result.returncode == 0, "Independent restored PostgreSQL measurement failed.")
    restored = json_document(result.stdout)
    _, _, files = extract_measurement(restored, hold=False)
    ensure(source == restored, "Restored business rows, sequences, or media metadata differ from the backup.")
    with open_directory(media_path) as media_root:
        fcntl.flock(media_root, fcntl.LOCK_EX | fcntl.LOCK_NB)
        check_media(media_root, files)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    make = commands.add_parser("capture")
    make.add_argument("parent")
    make.add_argument("new_name")
    make.add_argument("media_root")
    check = commands.add_parser("verify")
    check.add_argument("candidate")
    check.add_argument("manifest_sha256")
    restored = commands.add_parser("verify-restored")
    restored.add_argument("candidate")
    restored.add_argument("manifest_sha256")
    restored.add_argument("restored_media_root")
    args = parser.parse_args()
    if args.command == "capture":
        capture(args.parent, args.new_name, args.media_root)
    elif args.command == "verify":
        verify(args.candidate, args.manifest_sha256)
        print("Backup candidate files verified.")
    else:
        verify_restored(args.candidate, args.manifest_sha256, args.restored_media_root)
        print("Restored PostgreSQL state and media match the backup candidate.")


if __name__ == "__main__":
    os.umask(0o077)
    try:
        main()
    except (BackupError, OSError, ValueError, subprocess.TimeoutExpired, subprocess.CalledProcessError) as error:
        print(f"Backup candidate rejected: {error}", file=sys.stderr)
        sys.exit(1)
