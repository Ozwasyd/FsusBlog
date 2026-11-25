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


def check(ok, msg):
    if not ok:
        raise ValueError(msg)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def signature(title, body):
    return f"{len(title)}\t{digest(title)}\t{len(body)}\t{digest(body)}\n".encode("ascii")


def read_manifest(path):
    with path.open("rb") as stream:
        value = stream.read(MAX_MANIFEST_BYTES + 1)
    check(len(value) <= MAX_MANIFEST_BYTES, "The article plan manifest exceeds its byte budget.")
    return value


def unique_members(pairs):
    result = {}
    for key, value in pairs:
        check(key not in result, f"Duplicate article plan member {key!r}.")
        result[key] = value
    return result


def article_shards(plan):
    shards, width, article_count = plan.get("articleShards"), PROFILE_SHARD_ROWS[plan["profile"]], plan["articles"]
    check(type(shards) is list and len(shards) == (article_count + width - 1) // width,
          "Unexpected article shard count for the selected profile.")
    first, numeric = 1, ("ordinal", "firstArticle", "lastArticle", "rows", "bytes")
    fields = {*numeric, "sha256"}
    for ordinal, shard in enumerate(shards, 1):
        check(type(shard) is dict and shard.keys() == fields and all(type(shard[k]) is int for k in numeric)
              and type(shard["sha256"]) is str and re.fullmatch(r"[0-9a-f]{64}", shard["sha256"]),
              f"Malformed article shard description at ordinal {ordinal}.")
        rows = shard["rows"]
        check(shard["ordinal"] == ordinal and 0 < rows <= MAX_SHARD_ROWS and rows == min(width, article_count - first + 1)
              and shard["firstArticle"] == first and shard["lastArticle"] == first + rows - 1
              and len(HEADER) < shard["bytes"] <= MAX_SHARD_BYTES,
              f"Unexpected article shard boundaries at ordinal {ordinal}.")
        first += rows
    check(first == plan["articles"] + 1, "The article shard ranges do not cover the declared plan.")
    return shards


def plan_lines(path, shards):
    if shards is None:
        with path.open("rb") as source:
            yield from iter(lambda: source.readline(MAX_PLAN_LINE + 1), b"")
        return
    for shard in shards:
        ordinal = shard["ordinal"]
        handle = os.open(path.parent / f"articles-{ordinal:05d}.tsv", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(handle, "rb") as source:
            identity = os.fstat(source.fileno())
            check(stat.S_ISREG(identity.st_mode) and identity.st_size == shard["bytes"],
                  f"Unexpected file type or byte count for article shard {ordinal}.")
            header = source.readline(MAX_PLAN_LINE + 1)
            check(header == HEADER, f"Unexpected header in article shard {ordinal}.")
            shard_hash = hashlib.sha256(header)
            if ordinal == 1:
                yield header
            for _ in range(shard["rows"]):
                raw = source.readline(MAX_PLAN_LINE + 1)
                check(raw, f"Article shard {ordinal} ended before its declared row count.")
                shard_hash.update(raw)
                yield raw
            check(not source.read(1) and shard_hash.hexdigest() == shard["sha256"],
                  f"Article shard {ordinal} differs from its declared rows or SHA-256.")


def inspect_revisions(source, actual, plan, probe):
    source_hash = hashlib.sha256()
    header = next(source, b"")
    check(header == HEADER, "Unexpected sealed article plan header.")
    source_hash.update(header)

    article = revisions = 0
    ranges, rejected = [], False
    for kind in COHORTS:
        first, range_hash, range_revisions = article + 1, hashlib.sha256(), 0
        for _ in range(plan["cohorts"][kind]):
            article += 1
            raw = next(source, b"")
            check(len(raw) <= MAX_PLAN_LINE and raw.endswith(b"\n") and b"\r" not in raw and b"\0" not in raw,
                  f"Invalid article plan record at article {article}.")
            fields = raw[:-1].split(b"\t")
            check(len(fields) == 8 and fields[:2] == [str(article).encode("ascii"), kind.encode("ascii")],
                  f"Unexpected ordered article plan row at article {article}.")
            try:
                for text in fields[4:]:
                    text.decode("utf-8", "strict")
            except UnicodeDecodeError:
                raise ValueError(f"Invalid UTF-8 at article {article}.") from None
            source_hash.update(raw)
            signatures = (signature(fields[4], fields[5]), signature(fields[6], fields[7]))
            for revision, version in enumerate(REVISIONS[kind], 1):
                prefix = f"{article}\t{revision}\t".encode("ascii")
                expected, observed = prefix + signatures[version], actual.readline(201)
                check(len(observed) <= 200 and DIGEST_ROW.fullmatch(observed),
                      f"Missing or malformed digest row for article {article} revision {revision}.")
                if observed != expected:
                    check(probe and (article, revision) == (3, 1) and observed == prefix + signature(fields[4], fields[5] + b" "),
                          f"Raw UTF-8 differs at article {article} revision {revision}. "
                          f"Expected digest row {expected.decode('ascii').rstrip()}, observed {observed.decode('ascii').rstrip()}.")
                    rejected = True
                range_hash.update(observed)
                range_revisions += 1
        ranges.append({"cohort": kind, "firstArticle": first, "lastArticle": article,
                       "revisions": range_revisions, "readbackSha256": range_hash.hexdigest()})
        revisions += range_revisions

    check(next(source, None) is None and article == plan["articles"] and source_hash.hexdigest() == plan["articlePlanSha256"],
          "The article plan bytes, order or count differ from the seal.")
    check(revisions == plan["revisions"] and actual.readline(201) == ROLLBACK_MARKER and not actual.read(1),
          "Unexpected revision count or PostgreSQL rollback boundary.")
    check(not probe or rejected, "Rollback control failed to detect the article 3 revision 1 body mutation.")
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
        check(re.fullmatch(r"fsusv2_nightly_[0-9a-f]{32}", args.database_name)
              and Path(args.data_directory).is_absolute() and os.environ.get("PGHOST") == str(socket)
              and os.environ.get("PGDATABASE") == args.database_name and os.environ.get("PGUSER") == "fsusv2_nightly_qa",
              "Expected the owned fixture database through its private Unix socket.")
        manifest = read_manifest(args.manifest)
        plan = json.loads(manifest)
        check(isinstance(plan, dict), "Expected a sealed article plan object.")
        sharded = plan.get("format") == SHARDED_FORMAT
        if sharded:
            check(args.profile in PROFILE_SHARD_ROWS and read_manifest(args.plan) == manifest,
                  "Sharded verification requires the identical selected manifest beside the shards.")
            plan = json.loads(manifest, object_pairs_hook=unique_members)
        check(args.profile != MILLION_PROFILE or sharded, "articles-million requires the sealed sharded article plan.")
        count, band = PROFILE_ARTICLES[args.profile], PROFILE_ARTICLES[args.profile] // 20
        cohorts = {**dict.fromkeys(COHORTS, band), "published": 16 * band}
        check((sharded or plan.get("format") == "fsusblog-v2-nightly-postgres-fixture-v2")
              and plan.get("profile") == args.profile and plan.get("articles") == count and plan.get("cohorts") == cohorts,
              "Unexpected sealed article plan profile or cohort counts.")
        check(not sharded or (type(plan.get("articlePlanSha256")) is str
                              and bool(re.fullmatch(r"[0-9a-f]{64}", plan["articlePlanSha256"]))
                              and plan.get("revisions") == 3 * count + 6 * band
                              and all(type(rows) is int for rows in plan["cohorts"].values())),
              "Unexpected sharded article plan digest or revision counts.")
        if args.profile == MILLION_PROFILE:
            zero = dict.fromkeys(("rows", "roots", "replies", "visibleContent", "structuralNodes"), 0)
            check(plan.get("comments") == zero and all(type(total) is int for total in plan["comments"].values()),
                  "articles-million requires zero comment counts and no comment coordinates.")
        shards = article_shards(plan) if sharded else None
        control = None
        if args.profile == "pilot":
            postgres_readback(args, plan, probe=True, shards=shards)
            control = {"articleId": 3, "revision": 1, "rejected": True, "rolledBack": True}
        revisions, ranges = postgres_readback(args, plan, probe=False, shards=shards)
        result = {"version": 1, "profile": args.profile, "planSha256": digest(manifest),
                  "articlePlanSha256": plan["articlePlanSha256"], "verifiedRevisions": revisions,
                  "ranges": ranges, "rollbackControl": control, **({"articleShards": shards} if shards is not None else {})}
        with args.receipt.open("x", encoding="utf-8") as receipt:
            json.dump(result, receipt, indent=2, sort_keys=True)
            receipt.write("\n")
        print(f"Verified raw UTF-8 title and body bytes for {revisions} revisions.")
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        parser.exit(1, f"Nightly article byte proof failed: {error}\n")


if __name__ == "__main__":
    main()
