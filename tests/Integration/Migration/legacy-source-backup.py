#!/usr/bin/env python3
"""Use an actual v1 fixture archive as the source of an owned offline import rehearsal."""

import importlib.util
import hashlib
import json
import os
from pathlib import Path
import re
import select
import subprocess
import sys
import tempfile


def backup_helpers():
    path = Path(__file__).resolve().parents[3] / "tools" / "site-backup.py"
    spec = importlib.util.spec_from_file_location("site_backup", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


backup = backup_helpers()
limit = 32 * 1024 * 1024
receipt_counts_before_restore = (
    b"    CONSTRAINT ck_author_saved_view_receipt_counts CHECK ((((previous_active_view_count >= 0) "
    b"AND (previous_active_view_count <= 1000)) AND ((active_view_count >= 0) AND (active_view_count <= 1000)) "
    b"AND ((change_count >= 0) AND (change_count <= 1000)))),\n"
)
receipt_counts_after_restore = (
    b"    CONSTRAINT ck_author_saved_view_receipt_counts CHECK (((previous_active_view_count >= 0) "
    b"AND (previous_active_view_count <= 1000) AND ((active_view_count >= 0) AND (active_view_count <= 1000)) "
    b"AND ((change_count >= 0) AND (change_count <= 1000)))),\n"
)



def asset_constraint_forms(name, field, choices, suffix):
    # A PostgreSQL 18 logical restore distributes the original text[] cast over identical literals.
    varying = [f"'{choice}'::character varying" for choice in choices]
    before = f"(ARRAY[{', '.join(varying)}])::text[]"
    after = "ARRAY[" + ", ".join(f"({value})::text" for value in varying) + "]"
    head = f"    CONSTRAINT {name} CHECK ((({field})::text = ANY ("
    return ((head + before + ")))" + suffix + "\n").encode("ascii"),
            (head + after + ")))" + suffix + "\n").encode("ascii"))


exact_check_renderings = dict([
    (receipt_counts_before_restore, receipt_counts_after_restore),
    asset_constraint_forms("content_asset_state_check", "state", ("active", "pending_delete"), ","),
    asset_constraint_forms("content_asset_storage_class_check", "storage_class", ("public", "private"), ""),
    asset_constraint_forms("content_asset_reference_source_kind_check", "source_kind", ("article", "draft", "revision"), ""),
])


def tools_for_owned_fixture(source, restored):
    prefix = re.fullmatch(r"(fsusv2_import_[0-9a-f]{24})_source", source)
    backup.ensure(prefix and restored == prefix[1] + "_source_restore", "Use the rehearsal's owned source and restore database names.")
    host, port, user = (os.environ.get(key, "") for key in ("PGHOST", "PGPORT", "PGUSER"))
    backup.ensure(Path(host).is_absolute() and Path(host).resolve().as_posix() == host and
                  port.isascii() and port.isdecimal() and 0 < int(port) < 65536 and
                  re.fullmatch(r"[a-z][a-z_0-9]{0,62}", user), "Use the owned native PostgreSQL Unix socket.")
    with backup.open_directory(host):
        pass
    explicit = [f"--host={host}", f"--port={port}", f"--username={user}", "--no-password"]
    env = {"PATH": os.environ["PATH"], "TZ": "UTC", "LC_ALL": "C"}
    return explicit, env


def inspect_database(psql, env, name, require_empty):
    command = """
        SELECT jsonb_build_object('name',current_database(),'oid',d.oid::bigint,
            'major',current_setting('server_version_num')::integer / 10000,
            'empty', NOT EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                WHERE n.nspname <> 'information_schema' AND left(n.nspname,3) <> 'pg_'
                AND c.relkind IN ('r','S','p','v','m','f')))
        FROM pg_database d WHERE d.datname=current_database()
    """
    row = json.loads(subprocess.run(psql + [f"--dbname={name}", "-c", command], env=env, check=True,
                                    stdout=subprocess.PIPE, timeout=15).stdout)
    backup.ensure(row["name"] == name and row["empty"] is require_empty and type(row["oid"]) is int,
                  "The original or empty restore database identity differs.")
    return row


def measure_dump(args, env, snapshot=None):
    # A separate native read of the schema and all COPY data, through a deterministic pg_dump encoding.
    with tempfile.TemporaryFile() as observed:
        flags = ["--format=plain", "--restrict-key=FsusLegacySourceFixture", "--no-owner", "--no-privileges"]
        if snapshot:
            flags.append(f"--snapshot={snapshot}")
        subprocess.run(args + flags, env=env, check=True, stdout=observed, timeout=40)
        observed.seek(0)
        _, raw = backup.copy_checked(observed, limit=limit)
        observed.seek(0)
        logical = hashlib.sha256()
        rewritten = set()
        for line in observed:
            if line in exact_check_renderings:
                backup.ensure(line not in rewritten, "A known CHECK rendering appears more than once in the test fixture dump.")
                rewritten.add(line)
                line = exact_check_renderings[line]
            logical.update(line)
        return raw, logical.hexdigest(), len(rewritten)


def capture_and_restore(source, restored, archive_dir):
    explicit, env = tools_for_owned_fixture(source, restored)
    psql = ["psql", *explicit, "-X", "-qAt", "-v", "ON_ERROR_STOP=1"]
    original = inspect_database(psql, env, source, require_empty=False)
    restore_target = inspect_database(psql, env, restored, require_empty=True)
    backup.ensure(original["oid"] != restore_target["oid"] and original["major"] == restore_target["major"],
                  "Restore requires a fresh database on the owned fixture cluster.")
    version = subprocess.check_output(["pg_dump", "--version"], env=env, text=True, timeout=5)
    major = backup.PG_MAJOR.search(version)
    backup.ensure(major and int(major[1]) == original["major"], "pg_dump must match the source PostgreSQL major.")
    with backup.open_directory(archive_dir) as directory:
        holder = subprocess.Popen(psql + [f"--dbname={source}"], env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        try:
            holder.stdin.write(b"BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT pg_catalog.pg_export_snapshot();\n")
            holder.stdin.flush()
            backup.ensure(select.select([holder.stdout], [], [], 15)[0], "No exported PostgreSQL source snapshot was observed.")
            snapshot = holder.stdout.readline(100).decode("ascii").strip()
            backup.ensure(re.fullmatch(r"[0-9A-Fa-f-]{5,80}", snapshot), "The source transaction did not export a PostgreSQL snapshot.")
            source_dump = ["pg_dump", *explicit, f"--dbname={source}"]
            original_content = measure_dump(source_dump, env, snapshot)
            with backup.new_file(directory, "v1-source.dump") as archive:
                subprocess.run(source_dump + ["--format=custom", f"--snapshot={snapshot}", "--no-owner", "--no-privileges"],
                               env=env, stdout=archive, check=True, timeout=40)
                os.fchmod(archive.fileno(), 0o400)
            holder.stdin.write(b"ROLLBACK;\n\\q\n")
            holder.stdin.flush()
            backup.ensure(holder.wait(timeout=10) == 0, "The exported source snapshot did not close cleanly.")
        finally:
            backup.terminate_child(holder)
            holder.stdin.close()
            holder.stdout.close()

        with backup.read_file(directory, "v1-source.dump") as archive:
            backup.ensure(archive.read(5) == b"PGDMP", "Expected a native PostgreSQL custom archive.")
            archive.seek(0)
            def identity():
                info = os.fstat(archive.fileno())
                return info.st_dev, info.st_ino, info.st_mode, info.st_size, info.st_mtime_ns, info.st_ctime_ns

            before = identity()
            archive_bytes, archive_sha = backup.copy_checked(archive, limit=limit)
            archive.seek(0)
            subprocess.run(["pg_restore", *explicit, f"--dbname={restored}", "--no-owner", "--no-privileges",
                            "--exit-on-error", "--single-transaction"], env=env, stdin=archive, check=True, timeout=60)
            archive.seek(0)
            backup.ensure(backup.copy_checked(archive, limit=limit) == (archive_bytes, archive_sha) and
                          identity() == before, "The archive changed during its native restore.")

    restored_content = measure_dump(["pg_dump", *explicit, f"--dbname={restored}"], env)
    backup.ensure(restored_content[1] == original_content[1], "The restored v1 database differs from its captured native source snapshot.")
    print(json.dumps({"archiveBytes": archive_bytes, "archiveSha256": archive_sha, "sourceDatabaseOid": original["oid"],
                      "restoredDatabaseOid": restore_target["oid"], "schemaAndDataSha256": restored_content[1],
                      "sourceNativeDumpSha256": original_content[0], "restoredNativeDumpSha256": restored_content[0],
                      "sourceCheckRenderingRewrites": original_content[2], "restoredCheckRenderingRewrites": restored_content[2]}, sort_keys=True))


if __name__ == "__main__":
    capture_and_restore(*sys.argv[1:])
