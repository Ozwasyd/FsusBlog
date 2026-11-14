#!/usr/bin/env python3
"""Generate the P2 fixture and a guarded psql input file for a new owned database."""

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import re

SEED = 20261114
OWNER = "5e3986ac-4d8e-5c55-91f6-202611140001"
YEAR_END = datetime(2026, 11, 14, tzinfo=timezone.utc)
DAY = 86_400
PUBLIC = 12_000
DRAFT = 50
WITHDRAWAL = 50
TOTAL = PUBLIC + DRAFT + WITHDRAWAL
CATEGORIES = 32
TAGS = 128
SCHEMA = 1
ADMIN_IDENTITY_SCHEMA = 2
SERVER_LOCK = 716729109726707501
MIGRATION_LOCK = 4815262471654073021
SIZES = (2048, 8192, 32768)
GROUPS = (
    ("public", PUBLIC, (8400, 3000, 600), 365),
    ("draft", DRAFT, (35, 13, 2), 365),
    ("withdrawal", WITHDRAWAL, (35, 12, 3), 180),
)
TOPICS = (
    "weather trail wildlife garden harbour market museum railway forest river workshop orchard archive "
    "coast village kitchen meadow camp library valley lighthouse park footbridge ferry".split()
)
PEOPLE = (
    "The guide|The visitor|The author|The crew|The team|The caretaker|The gardeners|The historian|"
    "A neighbour|A traveller|The students|The photographer|The volunteers|The librarian|The runners|The group"
).split("|")
VERBS = (
    "recorded|studied|checked|described|collected|mapped|followed|compared|reviewed|assembled|revised|"
    "carried|noticed|counted|discussed|inspected"
).split("|")
DETAILS = (
    "the field notes|three clear sketches|the old route|a set of samples|the midday changes|the small stones|"
    "the evening schedule|several useful maps|some handwritten records|the fresh tracks|the quiet observation|"
    "a revised guide|the new report|the shared charts|the public trail|the colour patterns"
).split("|")
SETTINGS = (
    "near the bridge|beside the river|under the canopy|inside the station|around the square|behind the gate|"
    "along the ridge|across the valley|at the old crossing|outside the workshop|by the stone wall|in the courtyard|"
    "beyond the orchard|away from traffic|at the east entrance|near the north window"
).split("|")
TIMES = (
    "after sunrise|before the rain|during a cool morning|through the afternoon|on the first visit|before dusk|"
    "after the ferry left|before the next walk|when the clouds cleared|after a short pause|on the last day|"
    "before the guide returned|when the wind eased|during the return trip|after lunch|on a clear evening"
).split("|")


def utc(value):
    return value.isoformat(timespec="seconds").replace("+00:00", "Z")


def words(article_id, size):
    entropy = hashlib.shake_256(f"fsusblog-p2:{SEED}:{article_id}".encode("ascii"))
    sentences = []
    topic = TOPICS[(SEED + 11 * article_id) % len(TOPICS)]
    title = (
        f"Field notes {article_id:05d} - {topic} observations fixture{article_id:05d}"
    )
    sentences.append(
        f"These field notes give a dependable view of the {topic} over several visits."
    )
    # Each group of bytes chooses independently among action, place and time phrases.
    choices = entropy.digest(size // 4)
    filled = len(sentences[0]) + 1
    for start in range(0, len(choices) - 4, 5):
        person, verb, detail, setting, when = (
            byte & 15 for byte in choices[start : start + 5]
        )
        sentence = f"{PEOPLE[person]} {VERBS[verb]} {DETAILS[detail]} {SETTINGS[setting]} {TIMES[when]}."
        remaining = size - filled
        if len(sentence) + 1 >= remaining:
            if remaining:
                tail = sentence[: remaining - 1].rstrip()
                sentences.append(tail + "." + " " * (remaining - len(tail) - 1))
            break
        sentences.append(sentence)
        filled += len(sentence) + 1
    text = " ".join(sentences).encode("ascii")
    if len(text) != size:
        raise RuntimeError(
            f"Fixture body {article_id} has {len(text)} bytes, expected {size}"
        )
    return title, text


def articles():
    first = 1
    year_start = YEAR_END - timedelta(days=365)
    for state, count, tiers, days in GROUPS:
        for offset in range(count):
            article_id = first + offset
            # 733 is coprime to each group size. The two permutations keep sizes
            # spread across IDs and dates, while retaining exact tier counts.
            size_rank = (offset * 733 + SEED) % count
            date_rank = (offset * 937 + SEED) % count
            size = SIZES[
                0 if size_rank < tiers[0] else 1 if size_rank < sum(tiers[:2]) else 2
            ]
            instant = year_start + timedelta(
                seconds=((2 * date_rank + 1) * days * DAY) // (2 * count)
            )
            title, body = words(article_id, size)
            live = state != "draft"
            category_id = 1 + ((article_id - 1) * 11 + SEED) % CATEGORIES
            tag_id = 1 + ((article_id - 1) * 37 + SEED) % TAGS
            html_body = body.rstrip(b" ")
            yield (
                {
                    "id": article_id,
                    "revision": 1,
                    "title": title,
                    "bodySha256": hashlib.sha256(body).hexdigest(),
                    "bodyBytes": size,
                    "htmlBodySha256": hashlib.sha256(html_body).hexdigest(),
                    "htmlBodyBytes": len(html_body),
                    "createdAt": utc(instant - timedelta(minutes=10)),
                    "updatedAt": utc(instant),
                    "publishedAt": utc(instant) if live else None,
                    "state": state,
                    "publicationId": article_id if live else None,
                    "publicationNo": 1 if live else None,
                    "categoryId": category_id,
                    "categoryName": f"fixture category {category_id:02d}",
                    "tagIds": [tag_id],
                    "tagNames": [f"fixture tag {tag_id:03d}"],
                },
                body.decode("ascii"),
            )
        first += count


def write_guard(out, database):
    out.write(
        f"""\\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path = pg_catalog;
DO $guard$
BEGIN
    IF current_database() IS DISTINCT FROM '{database}' THEN
        RAISE EXCEPTION 'Fixture target does not match the exact owned performance database';
    END IF;
    IF current_setting('session_replication_role') <> 'origin' THEN
        RAISE EXCEPTION 'Fixture target must enforce integrity triggers';
    END IF;
    IF NOT pg_try_advisory_xact_lock({MIGRATION_LOCK}) THEN
        RAISE EXCEPTION 'Migration already owns the fixture database';
    END IF;
    IF NOT pg_try_advisory_xact_lock({SERVER_LOCK}) THEN
        RAISE EXCEPTION 'A v2 Server already owns the fixture database';
    END IF;
END $guard$;
LOCK TABLE public.v2_schema IN ACCESS EXCLUSIVE MODE NOWAIT;
DO $empty$
DECLARE
    relation record;
    contains_rows boolean;
    valid_bootstrap boolean;
BEGIN
    IF (SELECT count(*) FROM public.v2_schema) <> 1 OR
        NOT EXISTS (SELECT FROM public.v2_schema WHERE singleton AND version = {SCHEMA}) THEN
        RAISE EXCEPTION 'Expected current v2 schema in the fixture database';
    END IF;
    FOR relation IN
        SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname <> 'v2_schema'
        ORDER BY c.relname
    LOOP
        EXECUTE format('LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE NOWAIT', relation.relname);
        IF relation.relname = 'authoring_recovery_site' THEN
            EXECUTE 'SELECT count(*) = 1 AND bool_and(singleton AND site_id <> ''00000000-0000-0000-0000-000000000000'') FROM public.authoring_recovery_site'
                INTO valid_bootstrap;
            IF valid_bootstrap IS DISTINCT FROM true THEN
                RAISE EXCEPTION 'Fixture target has an invalid authoring recovery bootstrap marker';
            END IF;
            CONTINUE;
        END IF;
        IF relation.relname = 'admin_identity_schema' THEN
            EXECUTE 'SELECT count(*) = 1 AND bool_and(singleton AND version = {ADMIN_IDENTITY_SCHEMA}) FROM public.admin_identity_schema'
                INTO valid_bootstrap;
            IF valid_bootstrap IS DISTINCT FROM true THEN
                RAISE EXCEPTION 'Fixture target has an invalid administrator identity bootstrap marker';
            END IF;
            CONTINUE;
        END IF;
        EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I)', relation.relname) INTO contains_rows;
        IF contains_rows THEN
            RAISE EXCEPTION 'Fixture target contains business data in %', relation.relname;
        END IF;
    END LOOP;
END $empty$;
CREATE TEMP TABLE fsus_perf_fixture (
    id integer PRIMARY KEY,
    title text NOT NULL,
    body text NOT NULL,
    body_bytes integer NOT NULL CHECK (octet_length(body) = body_bytes),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    published_at timestamptz,
    publication_id bigint,
    category_id integer NOT NULL CHECK (category_id BETWEEN 1 AND {CATEGORIES}),
    tag_id integer NOT NULL CHECK (tag_id BETWEEN 1 AND {TAGS}),
    CHECK ((published_at IS NULL) = (publication_id IS NULL)),
    CHECK (publication_id IS NULL OR id = publication_id)
) ON COMMIT DROP;
COPY pg_temp.fsus_perf_fixture FROM STDIN;
"""
    )


def write_inserts(out):
    out.write(
        f"""\\.
INSERT INTO public.blog_user (id,name,can_author,enabled,generation)
    VALUES ('{OWNER}','performance-fixture-author',true,true,1);
INSERT INTO public.category (id,name)
    SELECT id,'fixture category ' || lpad(id::text,2,'0') FROM generate_series(1,{CATEGORIES}) AS series(id);
INSERT INTO public.tag (id,name)
    SELECT id,'fixture tag ' || lpad(id::text,3,'0') FROM generate_series(1,{TAGS}) AS series(id);
INSERT INTO public.tag_url_name (name_key,tag_id) SELECT name,id FROM public.tag ORDER BY id;
INSERT INTO public.article
    (id,owner_id,revision,title,body,published_revision,publication_count,deleted,created_at,updated_at)
    OVERRIDING SYSTEM VALUE
    SELECT id,'{OWNER}',1,title,body,CASE WHEN publication_id IS NOT NULL THEN 1 END,
        CASE WHEN publication_id IS NOT NULL THEN 1 ELSE 0 END,false,
        created_at,updated_at FROM pg_temp.fsus_perf_fixture ORDER BY id;
INSERT INTO public.article_revision (article_id,revision,title,body,happened_at)
    SELECT id,1,title,body,updated_at FROM pg_temp.fsus_perf_fixture ORDER BY id;
INSERT INTO public.article_revision_category (article_id,revision,category_id)
    SELECT id,1,category_id FROM pg_temp.fsus_perf_fixture ORDER BY id;
INSERT INTO public.article_revision_tag (article_id,revision,tag_id)
    SELECT id,1,tag_id FROM pg_temp.fsus_perf_fixture ORDER BY id;
INSERT INTO public.article_publication (article_id,publication_id,revision,publication_no,published_at)
    SELECT id,publication_id,1,1,published_at FROM pg_temp.fsus_perf_fixture
    WHERE publication_id IS NOT NULL ORDER BY id;
ALTER SEQUENCE public.article_id_seq RESTART WITH {TOTAL + 1};
ALTER SEQUENCE public.article_publication_publication_id_seq RESTART WITH {TOTAL + 1};
ALTER SEQUENCE public.category_id_seq RESTART WITH {CATEGORIES + 1};
ALTER SEQUENCE public.tag_id_seq RESTART WITH {TAGS + 1};
DO $counts$
BEGIN
    IF (SELECT count(*) FROM public.article) <> {TOTAL}
        OR (SELECT count(*) FROM public.article_revision) <> {TOTAL}
        OR (SELECT count(*) FROM public.article_publication) <> {PUBLIC + WITHDRAWAL}
        OR (SELECT count(*) FROM public.category) <> {CATEGORIES}
        OR (SELECT count(*) FROM public.tag) <> {TAGS}
        OR (SELECT count(*) FROM public.tag_url_name) <> {TAGS}
        OR (SELECT count(*) FROM public.article_revision_category) <> {TOTAL}
        OR (SELECT count(*) FROM public.article_revision_tag) <> {TOTAL} THEN
        RAISE EXCEPTION 'Fixture row count mismatch';
    END IF;
END $counts$;
COMMIT;
"""
    )


def generate(database, sql_path, manifest_path):
    manifest = {
        "schema": "fsusblog-v2-p2-performance-fixture-v1",
        "seed": SEED,
        "windowEnd": utc(YEAR_END),
        "taxonomies": {
            "categories": {"required": CATEGORIES, "seeded": CATEGORIES},
            "tags": {"required": TAGS, "seeded": TAGS},
        },
        "articles": [],
    }
    # Each output lives in the runner's owned directory. Exclusive creation
    # prevents even an accidental reuse of an existing attempt's fixture files.
    with (
        sql_path.open("x", encoding="ascii", newline="\n") as sql,
        manifest_path.open("x", encoding="ascii", newline="\n") as receipt,
    ):
        write_guard(sql, database)
        for article, body in articles():
            published = article["publishedAt"] or r"\N"
            publication = article["publicationId"] or r"\N"
            sql.write(
                f"{article['id']}\t{article['title']}\t{body}\t{article['bodyBytes']}\t"
                f"{article['createdAt']}\t{article['updatedAt']}\t{published}\t{publication}\t"
                f"{article['categoryId']}\t{article['tagIds'][0]}\n"
            )
            manifest["articles"].append(article)
        write_inserts(sql)
        json.dump(manifest, receipt, ensure_ascii=True, separators=(",", ":"))
        receipt.write("\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", required=True)
    parser.add_argument("--sql", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"fsusv2_perf_[0-9a-f]{32}", args.database):
        parser.error(
            "--database must be fsusv2_perf_ followed by a new 32-digit lowercase hex run ID"
        )
    generate(args.database, args.sql, args.manifest)


if __name__ == "__main__":
    main()
