#!/usr/bin/env python3
"""Write the bounded, fixed C11 input and independently inspectable case coordinates."""

import argparse, hashlib, json, re
from contextlib import ExitStack
from pathlib import Path

from seed import words

SOURCE_REFERENCE = "2605b438eed8f16d12ddddf033d08a6fa18fcd12"
MILLION_PROFILE = "articles-million"
PROFILE_ARTICLES = {"pilot": 20, "nightly": 100_000, MILLION_PROFILE: 1_000_000}
COMMENT_BASE = 9_007_199_254_740_993
HEADER = "id\tkind\tcategory\ttag\ttitle\tbody\treplacement_title\treplacement_body\n"
PROFILE_SHARD_ROWS = {"pilot": 8, MILLION_PROFILE: 65_536}


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def check(ok, msg):
    if not ok:
        raise ValueError(msg)


def token_matches(text, pattern):
    text = text.lower()
    for match in pattern.finditer(text):
        start, end = match.span()
        if (not start or not text[start - 1:start].isalnum()) and not text[end:end + 1].isalnum():
            yield match


def prepare(profile, due, output, sharded=False):
    total = PROFILE_ARTICLES[profile]
    secondary = total // 20
    ordinary, scheduled, active_end, archived_end = total - 4 * secondary, total - 3 * secondary, total - 2 * secondary, total - secondary
    search_cases = {
        "publicTitle": (1, 3, "title", b"fixture00001", True),
        "retainedBody": (scheduled + 1, 3, "body", f"c11body{scheduled + 1:06d}".encode("ascii"), True),
        "pendingUpdate": (scheduled + 1, 5, "body", f"c11pending{scheduled + 1:06d}".encode("ascii"), False),
        "archivedInterim": (active_end + 1, 5, "body", f"c11interim{active_end + 1:06d}".encode("ascii"), False),
        "deletedPrior": (archived_end + 1, 3, "body", f"c11body{archived_end + 1:06d}".encode("ascii"), False),
    }
    search_pattern = re.compile(b"|".join(case[3] for case in search_cases.values()))
    search_facts, public_matches, sample_rows, sizes, digest = {}, {}, [], {512: 0, 2048: 0, 8192: 0}, hashlib.sha256()
    samples = {1, 2, ordinary, ordinary + 1, scheduled + 1, active_end, active_end + 1, archived_end, archived_end + 1} | (
        {total} if profile == MILLION_PROFILE else set())

    rows_per_shard = PROFILE_SHARD_ROWS[profile] if sharded else total
    article_paths = ([output / f"articles-{i:05d}.tsv" for i, _ in enumerate(range(1, total + 1, rows_per_shard), 1)]
                     if sharded else [output / "articles.tsv"])
    with ExitStack() as outputs:
        row_files = [outputs.enter_context(path.open("xb")) for path in article_paths]
        header = HEADER.encode("ascii")
        for rows in row_files:
            rows.write(header)
        digest.update(header)
        for article in range(1, total + 1):
            if article <= ordinary:
                kind, revision, publication = "published", 3, article
            elif article <= scheduled:
                kind, revision, publication = "scheduled", 3, None
            elif article <= active_end:
                kind, revision, publication = "scheduled-update", 5, article - secondary
            elif article <= archived_end:
                kind, revision, publication = "archived", 6, article - secondary
            else:
                kind, revision, publication = "deleted", 4, article - secondary

            category = 1 if article % 8 < 4 else 2 + article * 7 % 30
            tag = 1 if article % 16 < 3 else 2 + article * 37 % 126
            size_rank = (article * 733 + 57) % 100
            size = 512 if size_rank < 70 else 2048 if size_rank < 95 else 8192
            sizes[size] += 1
            title, generated = words(article, size)
            body = f"{generated.decode('ascii').rstrip()} c11body{article:06d}" + (" 文章与评论规模样本。" if article % 29 == 0 else "")
            replacement_title, replacement_body = (
                (f"Unpublished scheduled update {article:06d}", f"Pending revision only: c11pending{article:06d}.") if kind == "scheduled-update"
                else (f"Interim public release before archive {article:06d}", f"Interim publication selected for archive: c11interim{article:06d}.")
                if kind == "archived" else ("", ""))
            fields = (str(article), kind, str(category), str(tag), title, body, replacement_title, replacement_body)
            assert all("\t" not in v and "\n" not in v and "\r" not in v for v in fields)
            encoded = tuple(v.encode("utf-8") for v in fields)
            data = b"\t".join(encoded) + b"\n"
            check(not sharded or len(data) <= 64 * 1024, f"Article {article} exceeds the shard line budget.")
            row_files[(article - 1) // rows_per_shard].write(data)
            digest.update(data)

            active = kind in ("published", "scheduled-update")
            title_bytes, body_bytes, replacement_title_bytes, replacement_body_bytes = encoded[4:]
            if active:
                # The synthetic prose starts in ASCII so 200 bytes equal the public summary's 200 UTF-16 units.
                summary = body_bytes[:200]
                check(summary.isascii(), f"Non-ASCII public summary at article {article}.")
                for field, source in (("title", title_bytes), ("summary", summary), ("body", body_bytes)):
                    for match in token_matches(source, search_pattern):
                        term = match.group()
                        check(term not in public_matches, f"Repeated public search canary at article {article} field {field}.")
                        public_matches[term] = (article, field)

            if article in samples:
                archive_release = total - secondary + 2 * (article - active_end)
                sample_rows.append({
                    "id": article, "kind": kind, "currentRevision": revision,
                    "publicationId": publication if active else None, "historicalFirstPublicationId": publication,
                    "archiveSupersededReleaseId": archive_release - 1 if kind == "archived" else None,
                    "archivedReleaseId": archive_release if kind == "archived" else None,
                    "publicRevision": 3 if active else None, "category": category, "tag": tag, "originalTitle": title,
                    "originalBodySha256": sha256(body_bytes),
                    "currentBodySha256": sha256(replacement_body_bytes if kind == "scheduled-update" else body_bytes),
                    "archiveInterimBodySha256": sha256(replacement_body_bytes) if kind == "archived" else None,
                    "titleSearchTerm": f"fixture{article:05d}", "bodySearchTerm": f"c11body{article:06d}",
                    "pendingOnlyTerm": f"c11pending{article:06d}" if kind == "scheduled-update" else None,
                    "archiveInterimOnlyTerm": f"c11interim{article:06d}" if kind == "archived" else None,
                })
                for role, (target, source_revision, field, term, public) in search_cases.items():
                    if target != article:
                        continue
                    source_title, source_body = (title_bytes, body_bytes) if source_revision == 3 else (replacement_title_bytes, replacement_body_bytes)
                    source = source_title if field == "title" else source_body
                    matches = [m for m in token_matches(source, search_pattern) if m.group() == term]
                    check(len(matches) == 1, f"Expected exactly one {role} token at article {article} revision {source_revision} field {field}.")
                    match = matches[0]
                    source_publication = None if role == "pendingUpdate" else archive_release - 1 if role == "archivedInterim" else publication
                    search_facts[role] = {
                        "term": term.decode("ascii"), "anonymousMatchIds": [article] if public else [],
                        "source": {
                            "articleId": article, "revision": source_revision, "publicationId": source_publication,
                            "categoryId": category, "tagId": tag, "field": field,
                            "utf8Offset": match.start(), "utf8Length": match.end() - match.start(), "fieldBytes": len(source),
                            "titleSha256": sha256(source_title), "summarySha256": sha256(source_body[:200]), "bodySha256": sha256(source_body),
                        },
                    }

    expected_matches = {term: (article, field) for article, _, field, term, public in search_cases.values() if public}
    check(search_facts.keys() == search_cases.keys() and public_matches == expected_matches,
          "Search canaries do not match the expected anonymous source roles.")

    if profile == MILLION_PROFILE:
        comments = dict.fromkeys(("rows", "roots", "replies", "visibleContent", "structuralNodes"), 0)
    else:
        roots, replies, wide, chain_start = (48, 84, 12, 13) if profile == "pilot" else (500_000, 500_000, 480, 481)
        comments = {
            "rows": roots + replies, "roots": roots, "replies": replies,
            "visibleContent": roots + replies - 12, "structuralNodes": roots + replies - 9,
            "hotArticle": 1, "emptyActiveArticle": 2, "historicalPrivateArticles": [active_end + 1, archived_end + 1],
            "wideRoot": str(COMMENT_BASE + 1), "wideReplyCount": wide,
            "deepRoot": str(COMMENT_BASE + 2), "deepTarget": str(COMMENT_BASE + roots + chain_start + 31),
        }
    manifest = {
        "format": "fsusblog-v2-nightly-postgres-fixture-v2", "profile": profile, "sourceReference": SOURCE_REFERENCE,
        "articlePlanSha256": digest.hexdigest(), "articles": total,
        "cohorts": {"published": ordinary, "scheduled": secondary, "scheduled-update": secondary, "archived": secondary, "deleted": secondary},
        "v1ArchivedParity": False, "activePublications": ordinary + secondary, "revisions": 3 * total + 6 * secondary,
        "authorCommands": 3 * total + 5 * secondary, "archivedReleases": secondary, "publicationHistory": total + 2 * secondary,
        "canonicalPublications": total, "retainedReleaseRights": total + secondary, "responsibilitySnapshots": 2 * secondary,
        "scheduleDueUnixMs": due, "scheduled": secondary * 2, "sizeBucketsBeforeSentinelSuffix": sizes, "articleCases": sample_rows,
        "articleQueryFacts": {"version": 1, "search": search_facts, "unpublishedDetailIds": [ordinary + 1, active_end + 1, archived_end + 1]},
        "comments": comments,
    }
    if sharded:
        shards = []
        for ordinal, path in enumerate(article_paths, 1):
            first, size = (ordinal - 1) * rows_per_shard + 1, path.stat().st_size
            last = min(first + rows_per_shard - 1, total)
            check(size <= 512 * 1024 * 1024 and last - first + 1 <= 65_536, f"Article shard {ordinal} exceeds its file or row budget.")
            shard_hash = hashlib.sha256()
            with path.open("rb") as rows:
                for chunk in iter(lambda: rows.read(64 * 1024), b""):
                    shard_hash.update(chunk)
            shards.append({"ordinal": ordinal, "firstArticle": first, "lastArticle": last,
                           "rows": last - first + 1, "bytes": size, "sha256": shard_hash.hexdigest()})
        manifest.update({"format": "fsusblog-v2-nightly-postgres-fixture-v3", "articleShards": shards})
    with (output / "plan.json").open("x", encoding="utf-8") as plan:
        json.dump(manifest, plan, ensure_ascii=False, indent=2, sort_keys=True)
        plan.write("\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("profile", choices=PROFILE_ARTICLES)
    parser.add_argument("due_unix_ms", type=int)
    parser.add_argument("output", type=Path)
    parser.add_argument("--sharded", action="store_true")
    args = parser.parse_args()
    if args.due_unix_ms <= 0:
        parser.error("the scheduled Unix time must be positive")
    if args.sharded and args.profile not in PROFILE_SHARD_ROWS:
        parser.error("sharded article plans require the pilot or articles-million profile")
    if args.profile == MILLION_PROFILE and not args.sharded:
        parser.error("articles-million requires a sharded article plan")
    prepare(args.profile, args.due_unix_ms, args.output, args.sharded)


if __name__ == "__main__":
    main()
