#!/usr/bin/env python3
"""Write the bounded, fixed C11 input and independently inspectable case coordinates."""

import argparse
import hashlib
import json
from pathlib import Path

from seed import words


SOURCE_REFERENCE = "2605b438eed8f16d12ddddf033d08a6fa18fcd12"
PROFILE_ARTICLES = {"pilot": 20, "nightly": 100_000}
COMMENT_BASE = 9_007_199_254_740_993
HEADER = "id\tkind\tcategory\ttag\ttitle\tbody\treplacement_title\treplacement_body\n"


def prepare(profile, due, output):
    total = PROFILE_ARTICLES[profile]
    secondary = total // 20
    ordinary = total - 4 * secondary
    scheduled = ordinary + secondary
    active_end = scheduled + secondary
    retracted_end = active_end + secondary
    samples = {1, 2, ordinary, ordinary + 1, scheduled + 1, active_end, active_end + 1, retracted_end + 1}
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
            elif article <= retracted_end:
                kind, revision, publication = "retracted", 4, article - secondary
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
            replacement_title = f"Unpublished scheduled update {article:06d}" if kind == "scheduled-update" else ""
            replacement_body = f"Pending revision only: c11pending{article:06d}." if replacement_title else ""
            fields = (str(article), kind, str(category), str(tag), title, body, replacement_title, replacement_body)
            assert all("\t" not in value and "\n" not in value and "\r" not in value for value in fields)
            data = ("\t".join(fields) + "\n").encode("utf-8")
            rows.write(data)
            digest.update(data)

            if article in samples:
                active = kind in ("published", "scheduled-update")
                sample_rows.append({
                    "id": article, "kind": kind, "currentRevision": revision,
                    "publicationId": publication if active else None,
                    "historicalFirstPublicationId": publication,
                    "publicRevision": 3 if active else None, "category": category, "tag": tag,
                    "originalTitle": title,
                    "originalBodySha256": hashlib.sha256(body.encode("utf-8")).hexdigest(),
                    "currentBodySha256": hashlib.sha256((replacement_body or body).encode("utf-8")).hexdigest(),
                    "titleSearchTerm": f"fixture{article:05d}", "bodySearchTerm": f"c11body{article:06d}",
                    "pendingOnlyTerm": f"c11pending{article:06d}" if replacement_body else None,
                })

    pilot = profile == "pilot"
    roots, replies, wide, chain_start = (48, 84, 12, 13) if pilot else (500_000, 500_000, 480, 481)
    manifest = {
        "format": "fsusblog-v2-nightly-postgres-fixture-v1",
        "profile": profile,
        "sourceReference": SOURCE_REFERENCE,
        "articlePlanSha256": digest.hexdigest(),
        "articles": total,
        "cohorts": {"published": ordinary, "scheduled": secondary, "scheduled-update": secondary,
                    "retracted": secondary, "deleted": secondary},
        "v1ArchivedParity": False,
        "activePublications": ordinary + secondary,
        "revisions": 3 * ordinary + 16 * secondary,
        "publicationHistory": ordinary + 5 * secondary,
        "historicalPublications": ordinary + 3 * secondary,
        "scheduleDueUnixMs": due,
        "scheduled": secondary * 2,
        "sizeBucketsBeforeSentinelSuffix": sizes,
        "articleCases": sample_rows,
        "comments": {
            "rows": roots + replies, "roots": roots, "replies": replies,
            "visibleContent": roots + replies - 12, "structuralNodes": roots + replies - 9,
            "hotArticle": 1, "emptyActiveArticle": 2,
            "historicalPrivateArticles": [active_end + 1, retracted_end + 1],
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
