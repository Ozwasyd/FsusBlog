#!/usr/bin/env python3
"""Write the bounded, fixed C11 input and independently inspectable case coordinates."""

import argparse
import hashlib
import json
import re
from pathlib import Path

from seed import words


SOURCE_REFERENCE = "2605b438eed8f16d12ddddf033d08a6fa18fcd12"
PROFILE_ARTICLES = {"pilot": 20, "nightly": 100_000}
COMMENT_BASE = 9_007_199_254_740_993
HEADER = "id\tkind\tcategory\ttag\ttitle\tbody\treplacement_title\treplacement_body\n"


def token_matches(text, pattern):
    text = text.lower()
    for match in pattern.finditer(text):
        start, end = match.span()
        if (not start or not text[start - 1:start].isalnum()) and not text[end:end + 1].isalnum():
            yield match


def prepare(profile, due, output):
    total = PROFILE_ARTICLES[profile]
    secondary = total // 20
    ordinary = total - 4 * secondary
    scheduled = ordinary + secondary
    active_end = scheduled + secondary
    archived_end = active_end + secondary
    search_cases = {
        "publicTitle": (1, 3, "title", b"fixture00001", True),
        "retainedBody": (scheduled + 1, 3, "body", f"c11body{scheduled + 1:06d}".encode("ascii"), True),
        "pendingUpdate": (scheduled + 1, 5, "body", f"c11pending{scheduled + 1:06d}".encode("ascii"), False),
        "archivedInterim": (active_end + 1, 5, "body", f"c11interim{active_end + 1:06d}".encode("ascii"), False),
        "deletedPrior": (archived_end + 1, 3, "body", f"c11body{archived_end + 1:06d}".encode("ascii"), False),
    }
    search_pattern = re.compile(b"|".join(case[3] for case in search_cases.values()))
    search_facts = {}
    public_matches = {}
    samples = {1, 2, ordinary, ordinary + 1, scheduled + 1, active_end, active_end + 1, archived_end, archived_end + 1}
    samples = sorted(samples)
    sample_rows = []
    sizes = {512: 0, 2048: 0, 8192: 0}
    digest = hashlib.sha256()

    with (output / "articles.tsv").open("xb") as rows:
        header = HEADER.encode("ascii")
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
            body = f"{generated.decode('ascii').rstrip()} c11body{article:06d}"
            if article % 29 == 0:
                body += " 文章与评论规模样本。"
            replacement_title = replacement_body = ""
            if kind == "scheduled-update":
                replacement_title = f"Unpublished scheduled update {article:06d}"
                replacement_body = f"Pending revision only: c11pending{article:06d}."
            if kind == "archived":
                replacement_title = f"Interim public release before archive {article:06d}"
                replacement_body = f"Interim publication selected for archive: c11interim{article:06d}."
            fields = (str(article), kind, str(category), str(tag), title, body, replacement_title, replacement_body)
            assert all("\t" not in value and "\n" not in value and "\r" not in value for value in fields)
            encoded = tuple(value.encode("utf-8") for value in fields)
            data = b"\t".join(encoded) + b"\n"
            rows.write(data)
            digest.update(data)

            active = kind in ("published", "scheduled-update")
            title_bytes, body_bytes, replacement_title_bytes, replacement_body_bytes = encoded[4:]
            if active:
                # The synthetic prose starts in ASCII so 200 bytes equal the public summary's 200 UTF-16 units.
                summary = body_bytes[:200]
                if not summary.isascii():
                    raise ValueError(f"Non-ASCII public summary at article {article}.")
                for field, source in (("title", title_bytes), ("summary", summary), ("body", body_bytes)):
                    for match in token_matches(source, search_pattern):
                        term = match.group()
                        if term in public_matches:
                            raise ValueError(f"Repeated public search canary at article {article} field {field}.")
                        public_matches[term] = (article, field)

            if article in samples:
                archive_ordinal = article - active_end
                archive_release = total - secondary + 2 * archive_ordinal
                sample_rows.append({
                    "id": article, "kind": kind, "currentRevision": revision,
                    "publicationId": publication if active else None,
                    "historicalFirstPublicationId": publication,
                    "archiveSupersededReleaseId": archive_release - 1 if kind == "archived" else None,
                    "archivedReleaseId": archive_release if kind == "archived" else None,
                    "publicRevision": 3 if active else None, "category": category, "tag": tag,
                    "originalTitle": title,
                    "originalBodySha256": hashlib.sha256(body_bytes).hexdigest(),
                    "currentBodySha256": hashlib.sha256(replacement_body_bytes if kind == "scheduled-update" else body_bytes).hexdigest(),
                    "archiveInterimBodySha256": hashlib.sha256(replacement_body_bytes).hexdigest() if kind == "archived" else None,
                    "titleSearchTerm": f"fixture{article:05d}", "bodySearchTerm": f"c11body{article:06d}",
                    "pendingOnlyTerm": f"c11pending{article:06d}" if kind == "scheduled-update" else None,
                    "archiveInterimOnlyTerm": f"c11interim{article:06d}" if kind == "archived" else None,
                })
                for role, (target, source_revision, field, term, public) in search_cases.items():
                    if target != article:
                        continue
                    source_title, source_body = (title_bytes, body_bytes) if source_revision == 3 else (
                        replacement_title_bytes, replacement_body_bytes)
                    source = source_title if field == "title" else source_body
                    matches = [match for match in token_matches(source, search_pattern) if match.group() == term]
                    if len(matches) != 1:
                        raise ValueError(f"Expected exactly one {role} token at article {article} revision {source_revision} field {field}.")
                    match = matches[0]
                    source_publication = publication
                    if role == "pendingUpdate":
                        source_publication = None
                    if role == "archivedInterim":
                        source_publication = archive_release - 1
                    search_facts[role] = {
                        "term": term.decode("ascii"),
                        "anonymousMatchIds": [article] if public else [],
                        "source": {
                            "articleId": article, "revision": source_revision, "publicationId": source_publication,
                            "categoryId": category, "tagId": tag, "field": field,
                            "utf8Offset": match.start(), "utf8Length": match.end() - match.start(), "fieldBytes": len(source),
                            "titleSha256": hashlib.sha256(source_title).hexdigest(),
                            "summarySha256": hashlib.sha256(source_body[:200]).hexdigest(),
                            "bodySha256": hashlib.sha256(source_body).hexdigest(),
                        },
                    }

    expected_matches = {term: (article, field) for article, _, field, term, public in search_cases.values() if public}
    if search_facts.keys() != search_cases.keys() or public_matches != expected_matches:
        raise ValueError("Search canaries do not match the expected anonymous source roles.")

    pilot = profile == "pilot"
    roots, replies, wide, chain_start = (48, 84, 12, 13) if pilot else (500_000, 500_000, 480, 481)
    manifest = {
        "format": "fsusblog-v2-nightly-postgres-fixture-v2",
        "profile": profile,
        "sourceReference": SOURCE_REFERENCE,
        "articlePlanSha256": digest.hexdigest(),
        "articles": total,
        "cohorts": {"published": ordinary, "scheduled": secondary, "scheduled-update": secondary,
                    "archived": secondary, "deleted": secondary},
        "v1ArchivedParity": False,
        "activePublications": ordinary + secondary,
        "revisions": 3 * total + 6 * secondary,
        "authorCommands": 3 * total + 5 * secondary,
        "archivedReleases": secondary,
        "publicationHistory": total + 2 * secondary,
        "canonicalPublications": total,
        "retainedReleaseRights": total + secondary,
        "responsibilitySnapshots": 2 * secondary,
        "scheduleDueUnixMs": due,
        "scheduled": secondary * 2,
        "sizeBucketsBeforeSentinelSuffix": sizes,
        "articleCases": sample_rows,
        "articleQueryFacts": {
            "version": 1, "search": search_facts,
            "unpublishedDetailIds": [ordinary + 1, active_end + 1, archived_end + 1],
        },
        "comments": {
            "rows": roots + replies, "roots": roots, "replies": replies,
            "visibleContent": roots + replies - 12, "structuralNodes": roots + replies - 9,
            "hotArticle": 1, "emptyActiveArticle": 2,
            "historicalPrivateArticles": [active_end + 1, archived_end + 1],
            "wideRoot": str(COMMENT_BASE + 1), "wideReplyCount": wide,
            "deepRoot": str(COMMENT_BASE + 2), "deepTarget": str(COMMENT_BASE + roots + chain_start + 31),
        },
    }
    with (output / "plan.json").open("x", encoding="utf-8") as plan:
        json.dump(manifest, plan, ensure_ascii=False, indent=2, sort_keys=True)
        plan.write("\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("profile", choices=PROFILE_ARTICLES)
    parser.add_argument("due_unix_ms", type=int)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if args.due_unix_ms <= 0:
        parser.error("the scheduled Unix time must be positive")
    prepare(args.profile, args.due_unix_ms, args.output)


if __name__ == "__main__":
    main()
