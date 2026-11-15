#!/usr/bin/env python3
"""Compare every fixture revision with the raw, sealed article plan."""

import argparse
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path


HEADER = b"id\tkind\tcategory\ttag\ttitle\tbody\treplacement_title\treplacement_body\n"
MAX_PLAN_LINE = 64 * 1024
MAX_MANIFEST_BYTES = 64 * 1024
ROLLBACK_MARKER = b"article-byte-proof-rolled-back\n"
COHORTS = ("published", "scheduled", "scheduled-update", "archived", "deleted")
REVISIONS = {
    "published": (0, 0, 0),
    "scheduled": (0, 0, 0),
    "scheduled-update": (0, 0, 0, 1, 1),
    "archived": (0, 0, 0, 1, 1, 0),
    "deleted": (0, 0, 0, 0),
}
DIGEST_ROW = re.compile(rb"[0-9]+\t[0-9]+\t[0-9]+\t[0-9a-f]{64}\t[0-9]+\t[0-9a-f]{64}\n")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def signature(title, body):
    return f"{len(title)}\t{digest(title)}\t{len(body)}\t{digest(body)}\n".encode("ascii")


def inspect_revisions(source, actual, plan, probe):
    source_hash = hashlib.sha256()
    header = source.readline(MAX_PLAN_LINE + 1)
    if header != HEADER:
        raise ValueError("Unexpected sealed article plan header.")
    source_hash.update(header)

    article = revisions = 0
    ranges = []
    rejected = False
    for kind in COHORTS:
        first = article + 1
        range_hash = hashlib.sha256()
        range_revisions = 0
        for _ in range(plan["cohorts"][kind]):
            article += 1
            raw = source.readline(MAX_PLAN_LINE + 1)
            if len(raw) > MAX_PLAN_LINE or not raw.endswith(b"\n") or b"\r" in raw or b"\0" in raw:
                raise ValueError(f"Invalid article plan record at article {article}.")
            fields = raw[:-1].split(b"\t")
            if len(fields) != 8 or fields[:2] != [str(article).encode("ascii"), kind.encode("ascii")]:
                raise ValueError(f"Unexpected ordered article plan row at article {article}.")
            try:
                for text in fields[4:]:
                    text.decode("utf-8", "strict")
            except UnicodeDecodeError:
                raise ValueError(f"Invalid UTF-8 at article {article}.") from None
            source_hash.update(raw)
            signatures = (signature(fields[4], fields[5]), signature(fields[6], fields[7]))
            for revision, version in enumerate(REVISIONS[kind], 1):
                prefix = f"{article}\t{revision}\t".encode("ascii")
                expected = prefix + signatures[version]
                observed = actual.readline(201)
                if len(observed) > 200 or not DIGEST_ROW.fullmatch(observed):
                    raise ValueError(f"Missing or malformed digest row for article {article} revision {revision}.")
                if observed != expected:
                    if not (probe and (article, revision) == (3, 1)
                            and observed == prefix + signature(fields[4], fields[5] + b" ")):
                        raise ValueError(f"Raw UTF-8 differs at article {article} revision {revision}. "
                                         f"Expected digest row {expected.decode('ascii').rstrip()}, "
                                         f"observed {observed.decode('ascii').rstrip()}.")
                    rejected = True
                range_hash.update(observed)
                range_revisions += 1
        ranges.append({"cohort": kind, "firstArticle": first, "lastArticle": article,
                       "revisions": range_revisions, "readbackSha256": range_hash.hexdigest()})
        revisions += range_revisions

    if source.read(1) or article != plan["articles"] or source_hash.hexdigest() != plan["articlePlanSha256"]:
        raise ValueError("The article plan bytes, order or count differ from the seal.")
    if revisions != plan["revisions"] or actual.readline(201) != ROLLBACK_MARKER or actual.read(1):
        raise ValueError("Unexpected revision count or PostgreSQL rollback boundary.")
    if probe and not rejected:
        raise ValueError("Rollback control failed to detect the article 3 revision 1 body mutation.")
    return revisions, ranges


def postgres_readback(args, plan, probe):
    script = r"""
SET LOCAL search_path TO pg_catalog;
SET LOCAL statement_timeout TO '120s';
SELECT current_database()=:'database_name' AND current_setting('data_directory')=:'data_directory'
    AND inet_server_addr() IS NULL AND current_setting('listen_addresses')=''
    AND current_user='fsusv2_nightly_qa' AND current_setting('server_encoding')='UTF8'
    AND current_setting('session_replication_role')='origin'
    AND (SELECT count(*)=1 AND bool_and(singleton AND version=1) FROM public.v2_schema)
    AND (SELECT site_id=:'site_id'::uuid FROM public.authoring_recovery_site WHERE singleton) AS owned \gset
\if :owned
\else
DO $$ BEGIN RAISE EXCEPTION 'Article byte proof requires the owned PostgreSQL fixture'; END $$;
\endif
"""
    if probe:
        script += """
DO $$
BEGIN
    UPDATE public.article_revision r SET body=r.body || ' '
    FROM public.article a WHERE a.id=r.article_id AND a.id=3 AND r.revision=1
        AND a.published_revision=3 AND a.revision=3 AND NOT a.deleted;
    IF NOT FOUND THEN RAISE EXCEPTION 'Missing expected pilot control revision'; END IF;
END $$;
"""
    script += r"""
COPY (
    SELECT article_id,revision,octet_length(convert_to(title,'UTF8')),encode(sha256(convert_to(title,'UTF8')),'hex'),
        octet_length(convert_to(body,'UTF8')),encode(sha256(convert_to(body,'UTF8')),'hex')
    FROM public.article_revision ORDER BY article_id,revision
) TO STDOUT;
ROLLBACK;
\echo article-byte-proof-rolled-back
"""
    mode = "read write" if probe else "read only"
    command = ["psql", "-X", "-qAt", "--no-password", "-v", "ON_ERROR_STOP=1",
               "-v", f"database_name={args.database_name}", "-v", f"data_directory={args.data_directory}",
               "-v", f"site_id={args.site_id}"]
    with args.plan.open("rb") as source, subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                                         env={**os.environ, "PGCONNECT_TIMEOUT": "2"}) as pg:
        try:
            pg.stdin.write((f"BEGIN ISOLATION LEVEL REPEATABLE READ {mode};\n" + script).encode("ascii"))
            pg.stdin.close()
            result = inspect_revisions(source, pg.stdout, plan, probe)
            if pg.wait(timeout=5):
                raise ValueError("PostgreSQL digest stream ended unsuccessfully.")
            return result
        finally:
            if pg.poll() is None:
                pg.kill()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("profile", choices=("pilot", "nightly"))
    parser.add_argument("plan", type=Path)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("database_name")
    parser.add_argument("data_directory")
    parser.add_argument("site_id")
    parser.add_argument("receipt", type=Path)
    args = parser.parse_args()
    try:
        socket = Path(args.data_directory).parent / "socket"
        if not (re.fullmatch(r"fsusv2_nightly_[0-9a-f]{32}", args.database_name)
                and Path(args.data_directory).is_absolute() and os.environ.get("PGHOST") == str(socket)
                and os.environ.get("PGDATABASE") == args.database_name and os.environ.get("PGUSER") == "fsusv2_nightly_qa"):
            raise ValueError("Expected the owned fixture database through its private Unix socket.")
        with args.manifest.open("rb") as stream:
            manifest = stream.read(MAX_MANIFEST_BYTES + 1)
        if len(manifest) > MAX_MANIFEST_BYTES:
            raise ValueError("The article plan manifest exceeds its byte budget.")
        plan = json.loads(manifest)
        count = 20 if args.profile == "pilot" else 100_000
        band = count // 20
        cohorts = dict.fromkeys(COHORTS, band)
        cohorts["published"] = 16 * band
        if not (plan["format"] == "fsusblog-v2-nightly-postgres-fixture-v2" and plan["profile"] == args.profile
                and plan["articles"] == count and plan["cohorts"] == cohorts):
            raise ValueError("Unexpected sealed article plan profile or cohort counts.")
        control = None
        if args.profile == "pilot":
            postgres_readback(args, plan, probe=True)
            control = {"articleId": 3, "revision": 1, "rejected": True, "rolledBack": True}
        revisions, ranges = postgres_readback(args, plan, probe=False)
        with args.receipt.open("x", encoding="utf-8") as receipt:
            json.dump({"version": 1, "profile": args.profile, "planSha256": digest(manifest),
                       "articlePlanSha256": plan["articlePlanSha256"], "verifiedRevisions": revisions,
                       "ranges": ranges, "rollbackControl": control}, receipt, indent=2, sort_keys=True)
            receipt.write("\n")
        print(f"Verified raw UTF-8 title and body bytes for {revisions} revisions.")
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        parser.exit(1, f"Nightly article byte proof failed: {error}\n")


if __name__ == "__main__":
    main()
