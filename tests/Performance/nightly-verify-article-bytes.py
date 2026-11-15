#!/usr/bin/env python3
"""Compare every fixture revision with the raw, sealed article plan."""

import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
from contextlib import closing
from pathlib import Path


HEADER = b"id\tkind\tcategory\ttag\ttitle\tbody\treplacement_title\treplacement_body\n"
MAX_PLAN_LINE = 64 * 1024
MAX_MANIFEST_BYTES = 64 * 1024
MAX_SHARD_BYTES = 512 * 1024 * 1024
MAX_SHARD_ROWS = 65_536
SHARDED_FORMAT = "fsusblog-v2-nightly-postgres-fixture-v3"
MILLION_PROFILE = "articles-million"
PROFILE_ARTICLES = {"pilot": 20, "nightly": 100_000, MILLION_PROFILE: 1_000_000}
PROFILE_SHARD_ROWS = {"pilot": 8, MILLION_PROFILE: MAX_SHARD_ROWS}
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


def read_manifest(path):
    with path.open("rb") as stream:
        value = stream.read(MAX_MANIFEST_BYTES + 1)
    if len(value) > MAX_MANIFEST_BYTES:
        raise ValueError("The article plan manifest exceeds its byte budget.")
    return value


def unique_members(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate article plan member {key!r}.")
        result[key] = value
    return result


def article_shards(plan):
    shards = plan.get("articleShards")
    width = PROFILE_SHARD_ROWS[plan["profile"]]
    article_count = plan["articles"]
    expected_parts = (article_count + width - 1) // width
    if type(shards) is not list or len(shards) != expected_parts:
        raise ValueError("Unexpected article shard count for the selected profile.")
    first = 1
    numeric = ("ordinal", "firstArticle", "lastArticle", "rows", "bytes")
    fields = {*numeric, "sha256"}
    for ordinal, shard in enumerate(shards, 1):
        if (type(shard) is not dict or shard.keys() != fields or any(type(shard[key]) is not int for key in numeric)
                or type(shard["sha256"]) is not str or not re.fullmatch(r"[0-9a-f]{64}", shard["sha256"])):
            raise ValueError(f"Malformed article shard description at ordinal {ordinal}.")
        rows = shard["rows"]
        expected_rows = min(width, article_count - first + 1)
        if (shard["ordinal"] != ordinal or not 0 < rows <= MAX_SHARD_ROWS or rows != expected_rows
                or shard["firstArticle"] != first or shard["lastArticle"] != first + rows - 1
                or not len(HEADER) < shard["bytes"] <= MAX_SHARD_BYTES):
            raise ValueError(f"Unexpected article shard boundaries at ordinal {ordinal}.")
        first += rows
    if first != plan["articles"] + 1:
        raise ValueError("The article shard ranges do not cover the declared plan.")
    return shards


def plan_lines(path, shards):
    if shards is None:
        with path.open("rb") as source:
            yield from iter(lambda: source.readline(MAX_PLAN_LINE + 1), b"")
        return

    for shard in shards:
        ordinal = shard["ordinal"]
        path_for_shard = path.parent / f"articles-{ordinal:05d}.tsv"
        handle = os.open(path_for_shard, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(handle, "rb") as source:
            identity = os.fstat(source.fileno())
            if not stat.S_ISREG(identity.st_mode) or identity.st_size != shard["bytes"]:
                raise ValueError(f"Unexpected file type or byte count for article shard {ordinal}.")
            header = source.readline(MAX_PLAN_LINE + 1)
            if header != HEADER:
                raise ValueError(f"Unexpected header in article shard {ordinal}.")
            shard_hash = hashlib.sha256(header)
            if ordinal == 1:
                yield header
            for _ in range(shard["rows"]):
                raw = source.readline(MAX_PLAN_LINE + 1)
                if not raw:
                    raise ValueError(f"Article shard {ordinal} ended before its declared row count.")
                shard_hash.update(raw)
                yield raw
            if source.read(1) or shard_hash.hexdigest() != shard["sha256"]:
                raise ValueError(f"Article shard {ordinal} differs from its declared rows or SHA-256.")


def inspect_revisions(source, actual, plan, probe):
    source_hash = hashlib.sha256()
    header = next(source, b"")
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
            raw = next(source, b"")
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

    if next(source, None) is not None or article != plan["articles"] or source_hash.hexdigest() != plan["articlePlanSha256"]:
        raise ValueError("The article plan bytes, order or count differ from the seal.")
    if revisions != plan["revisions"] or actual.readline(201) != ROLLBACK_MARKER or actual.read(1):
        raise ValueError("Unexpected revision count or PostgreSQL rollback boundary.")
    if probe and not rejected:
        raise ValueError("Rollback control failed to detect the article 3 revision 1 body mutation.")
    return revisions, ranges


def postgres_readback(args, plan, probe, shards):
    timeout = "900s" if args.profile == MILLION_PROFILE else "120s"
    script = r"""
SET LOCAL search_path TO pg_catalog;
SET LOCAL statement_timeout TO :'statement_timeout';
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
               "-v", f"site_id={args.site_id}", "-v", f"statement_timeout={timeout}"]
    with closing(plan_lines(args.plan, shards)) as source, subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
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
    parser.add_argument("profile", choices=PROFILE_ARTICLES)
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
        manifest = read_manifest(args.manifest)
        plan = json.loads(manifest)
        if not isinstance(plan, dict):
            raise ValueError("Expected a sealed article plan object.")
        sharded = plan.get("format") == SHARDED_FORMAT
        if sharded:
            if args.profile not in PROFILE_SHARD_ROWS or read_manifest(args.plan) != manifest:
                raise ValueError("Sharded verification requires the identical selected manifest beside the shards.")
            plan = json.loads(manifest, object_pairs_hook=unique_members)
        if args.profile == MILLION_PROFILE and not sharded:
            raise ValueError("articles-million requires the sealed sharded article plan.")
        count = PROFILE_ARTICLES[args.profile]
        band = count // 20
        cohorts = dict.fromkeys(COHORTS, band)
        cohorts["published"] = 16 * band
        if (not sharded and plan.get("format") != "fsusblog-v2-nightly-postgres-fixture-v2"
                or plan.get("profile") != args.profile or plan.get("articles") != count or plan.get("cohorts") != cohorts):
            raise ValueError("Unexpected sealed article plan profile or cohort counts.")
        if sharded and (type(plan.get("articlePlanSha256")) is not str
                        or not re.fullmatch(r"[0-9a-f]{64}", plan["articlePlanSha256"])
                        or plan.get("revisions") != 3 * count + 6 * band
                        or any(type(rows) is not int for rows in plan["cohorts"].values())):
            raise ValueError("Unexpected sharded article plan digest or revision counts.")
        if args.profile == MILLION_PROFILE:
            zero_comments = {"rows": 0, "roots": 0, "replies": 0, "visibleContent": 0, "structuralNodes": 0}
            if plan.get("comments") != zero_comments or any(type(total) is not int for total in plan["comments"].values()):
                raise ValueError("articles-million requires zero comment counts and no comment coordinates.")
        shards = article_shards(plan) if sharded else None
        control = None
        if args.profile == "pilot":
            postgres_readback(args, plan, probe=True, shards=shards)
            control = {"articleId": 3, "revision": 1, "rejected": True, "rolledBack": True}
        revisions, ranges = postgres_readback(args, plan, probe=False, shards=shards)
        result = {"version": 1, "profile": args.profile, "planSha256": digest(manifest),
                  "articlePlanSha256": plan["articlePlanSha256"], "verifiedRevisions": revisions,
                  "ranges": ranges, "rollbackControl": control}
        if shards is not None:
            result["articleShards"] = shards
        with args.receipt.open("x", encoding="utf-8") as receipt:
            json.dump(result, receipt, indent=2, sort_keys=True)
            receipt.write("\n")
        print(f"Verified raw UTF-8 title and body bytes for {revisions} revisions.")
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        parser.exit(1, f"Nightly article byte proof failed: {error}\n")


if __name__ == "__main__":
    main()
