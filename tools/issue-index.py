#!/usr/bin/env python3
"""Validate the frozen issue evidence and project review queues and dependency candidates."""

import argparse
import csv
import datetime as dt
import gzip
import hashlib
import json
import re
from collections import Counter
from pathlib import Path
from issue_references import project as project_references


CONNECTIONS = {"comments", "labels", "blockedBy", "blocking", "subIssues"}
HEADER = (
    "requirementId", "sourceIssue", "sourceUpdatedAt", "observedState", "sourceClause",
    "productSurface", "decision", "ownerModule", "dependencies", "acceptanceCase", "evidence",
    "remainingGap",
)
PREFIX = re.compile(r"^[^()\[\]]{2,40}\(([^()]{1,65})\):")
REFERENCE = re.compile(
    r"https://github\.com/([\w.-]+/[\w.-]+)/(?:issues|pull)/(\d+)"
    r"|(?<![\w/-])([\w.-]+/[\w.-]+)#(\d+)"
    r"|(?<![\w/])#(\d+)"
)
EXPLICIT = re.compile(
    r"^\s*(?:[-*]\s+)?(?:\*{1,2})?(?P<marker>"
    r"Depends? on|Dependencies|Blocks|Blocked by|Parent|Related|Implementation DAG"
    r"|(?:本仓|跨仓)?前置依赖|依赖|父项|阻塞|关联)(?:\*{1,2})?\s*[:：]",
    re.I,
)


def tsv(path, header, rows):
    with path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream, delimiter="\t", lineterminator="\n")
        writer.writerow(header)
        writer.writerows(rows)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def verify(folder, independent):
    meta = json.loads((folder / "census.json").read_text())
    compressed = (folder / "open-issues.ndjson.gz").read_bytes()
    content = gzip.decompress(compressed)
    if (sha256(compressed), sha256(content)) != (meta["snapshotSha256"], meta["ndjsonSha256"]):
        raise ValueError("census digest mismatch")
    issues = [json.loads(line) for line in content.splitlines()]
    seen = {i["number"] for i in issues if i["state"] == "OPEN"}
    pages = meta["inventoryPages"]
    if (pages[0]["fromExclusive"] is not None
            or any(a["through"] != b["fromExclusive"] or not a["hasNextPage"]
                   for a, b in zip(pages, pages[1:]))
            or pages[-1]["hasNextPage"]):
        raise ValueError("inventory cursor chain was not exhausted")
    if (len(issues) != len(seen) or len(seen) != meta["githubOpenIssueCount"]
            or len(seen) != meta["exportedIssueCount"]
            or sorted(n for page in pages for n in page["issueNumbers"]) != sorted(seen)):
        raise ValueError("open issue inventory mismatch")
    if {kind: sum(len(i[kind]) for i in issues) for kind in CONNECTIONS} != meta["connectionTotals"]:
        raise ValueError("connection totals differ")
    if sum(i["parent"] is not None for i in issues) != meta["parentLinkCount"]:
        raise ValueError("parent link total differs")
    if independent:
        direct = [json.loads(line) for line in independent.read_bytes().splitlines()]
        left = [(i["number"], i["updated_at"], i["state"].upper(), i["body"] or "") for i in direct]
        right = [(i["number"], i["updatedAt"], i["state"], i["body"] or "") for i in issues]
        if sorted(left) != sorted(right):
            raise ValueError("independent REST inventory disagrees with the GraphQL snapshot")
        graphql = {i["number"]: len(i["comments"]) for i in issues}
        differences = [
            {"number": i["number"], "restListCount": i["comments"], "graphqlCount": graphql[i["number"]]}
            for i in direct if i["comments"] != graphql[i["number"]]
        ]
        crosscheck = {
            "verifiedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "sameIssueNumbersStatesUpdatedTimesAndBodies": len(issues),
            "restEvidenceSha256": sha256(independent.read_bytes()),
            "restListComments": sum(i["comments"] for i in direct),
            "graphqlComments": sum(graphql.values()),
            "commentCountDifferences": differences,
        }
        (folder / "rest-crosscheck.json").write_text(json.dumps(crosscheck, indent=2) + "\n")
        print(f"REST and GraphQL agree on {len(issues)} identities, states, timestamps and bodies; "
              f"{len(differences)} comment totals differ between list counts.")
    return meta["repository"], issues


def references(repository, item):
    sources = [(item["url"], item["body"])]
    sources.extend((c["url"], c["body"]) for c in item["comments"])
    for source, body in sources:
        for lineno, line in enumerate((body or "").splitlines(), 1):
            prefix = EXPLICIT.match(line)
            if prefix:
                for match in REFERENCE.finditer(line):
                    repo1, number1, repo2, number2, same_repo = match.groups()
                    yield (item["url"], source, lineno, prefix["marker"],
                           repo1 or repo2 or repository, number1 or number2 or same_repo)


def route(issue):
    title = issue["title"]
    match = PREFIX.match(title)
    kind = match[1] if match else ""
    if (kind == "i18n" or kind in {"viewport", "ios", "layout-governance", "settings", "frontend", "test-frontend", "test-visual"}
            or re.search(r"Inspector focus|Outline close|canonical frontend", title)):
        return "页面与组件", "Web"
    if kind in {"article-vault", "article-export", "document-export", "article-portability", "article-package"}:
        return "导出、包与本地 Vault", "Authoring / Extensions"
    if kind in {"authoring-extensions", "authoring-packages", "authoring-rpc", "plugin-admin"}:
        return "扩展与插件", "Extensions"
    if kind.startswith(("authoring", "article-", "author-")) or kind in {"block-links", "relation-graph", "saved-views"} or "Canvas" in title:
        return "创作与文章工作区", "Authoring"
    if kind in {"auth", "auth-session", "security", "zk-config", "security-risk"}:
        return "身份或安全", "Identity"
    if kind.startswith("aeds") or kind in {"api", "binary-reader", "binary-transport", "behavior-observation"}:
        return "协议与错误", "Contracts"
    if kind in {"assets", "storage", "article", "comments", "comment-author", "public-aot"} or "PublicHot" in title:
        return "内容读取与资产", "Content"
    if kind in {"db-migration", "architecture", "database"} or "migration" in title.lower():
        return "数据库与迁移", "Operations / Migrate"
    if kind in {"data-scale", "load", "soak", "resource", "resource-model", "resource-budget", "perf-gate", "production-fresh", "test-load", "test-backend-perf"} or "MEM-" in title:
        return "负载、资源与发布", "Operations / Performance"
    if "FsusUI" in title or "freshness" in title.lower() or kind in {"deps", "release-train"}:
        return "依赖治理", "Build / Web"
    if re.match(r"^(?:[Docs]|tracking|test|ci|evidence|governance)", title, re.I) or kind.startswith("release"):
        return "验证与运维治理", "Operations / Tests"
    return "需打开全文进一步定位", "待复核"


DECISIONS = {"采用", "合并采用", "仅吸收教训", "旧工程限定，不适用", "待决冲突"}
PRIORITY_ISSUES = {1950, 2218, 2295, 2322, 3665, 3738, 4234, 4537, 4750}
COMMENT_HEADER = ("sourceIssue", "sourceComment", "sourceUpdatedAt", "decision", "note", "acceptanceLinks")
REQUIREMENT_REFERENCE = re.compile(r"\b(?:V2S-\d+|R-\d+-[A-Z]?\d+)\b")


def dispositions(folder, issues):
    by_number = {i["number"]: i for i in issues}
    files = ["accepted-priority.tsv", "memory-review.tsv"]
    files.extend(path.name for path in sorted(folder.glob("review-*.tsv")) if path.name != "review-queue.tsv")
    coverage = {}
    requirement_ids = set()
    for file in files:
        artifact = folder / file
        if not artifact.exists():
            continue
        with artifact.open(encoding="utf-8", newline="") as stream:
            reader = csv.DictReader(stream, delimiter="\t")
            if tuple(reader.fieldnames or ()) != HEADER:
                raise ValueError(f"unexpected requirement header in {file}")
            for row in reader:
                n = int(re.search(r"(\d+)$", row["sourceIssue"])[1])
                i = by_number[n]
                req = row["requirementId"]
                decision = row["decision"]
                if (req in requirement_ids or i["updatedAt"] != row["sourceUpdatedAt"]
                        or i["state"] != row["observedState"].upper()
                        or decision not in DECISIONS
                        or not all(row[field] for field in ("sourceClause", "acceptanceCase", "remainingGap"))):
                    raise ValueError(f"stale or invalid requirement row {file}/{req}: {decision!r}")
                requirement_ids.add(req)
                coverage.setdefault(n, []).append((file, row))
    return coverage


def comment_progress(folder, issues, coverage):
    frozen = {}
    for issue in issues:
        for comment in issue["comments"]:
            url = comment["url"]
            if url in frozen:
                raise ValueError(f"duplicate frozen comment URL: {url}")
            frozen[url] = (issue, comment)
    requirements = {row["requirementId"] for entries in coverage.values() for _, row in entries}
    classified = set()
    decisions, methods = Counter(), Counter()
    adopted_comments = 0
    adopted_without_requirement_id = 0
    file_counts = {}
    for path in sorted(folder.glob("comments-*.tsv")):
        count = 0
        with path.open(encoding="utf-8", newline="") as stream:
            reader = csv.DictReader(stream, delimiter="\t")
            if tuple(reader.fieldnames or ()) not in (COMMENT_HEADER, COMMENT_HEADER + ("reviewMethod",)):
                raise ValueError(f"unexpected comment review header in {path.name}")
            for row in reader:
                url = row["sourceComment"]
                if url in classified or url not in frozen:
                    raise ValueError(f"duplicate or unknown comment in {path.name}: {url}")
                issue, comment = frozen[url]
                if (row["sourceIssue"] not in (issue["url"], f"#{issue['number']}")
                        or row["sourceUpdatedAt"] != comment["updatedAt"]
                        or row["decision"] not in DECISIONS or not row["note"].strip()
                        or (row["decision"] != "旧工程限定，不适用" and not row["acceptanceLinks"].strip())):
                    raise ValueError(f"invalid comment review in {path.name}: {url}")
                referenced = set(REQUIREMENT_REFERENCE.findall(row["acceptanceLinks"]))
                unknown = referenced - requirements
                if unknown:
                    raise ValueError(f"unknown acceptance reference in {path.name}: {url}: {sorted(unknown)}")
                if row["decision"] in ("采用", "合并采用"):
                    adopted_comments += 1
                    if not referenced:
                        adopted_without_requirement_id += 1
                classified.add(url)
                decisions[row["decision"]] += 1
                methods[row.get("reviewMethod") or "内容摘要或明确注明的证据复用"] += 1
                count += 1
        file_counts[path.name] = count
    pending = Counter(issue["number"] for url, (issue, _) in frozen.items() if url not in classified)
    return {
        "totalFrozenComments": len(frozen),
        "classifiedComments": len(classified),
        "unclassifiedComments": sum(pending.values()),
        "priorityCommentsClassified": sum(frozen[url][0]["number"] in PRIORITY_ISSUES for url in classified),
        "classificationCountsByFile": file_counts,
        "decisionCounts": dict(decisions),
        "reviewMethodCounts": dict(methods),
        "adoptedComments": adopted_comments,
        "adoptedCommentsMissingExplicitRequirementId": adopted_without_requirement_id,
        "pendingCountsByIssue": dict(sorted(pending.items())),
        "allCommentsSubstantivelyReviewed": False,
    }


def review_queue(issues, edges, coverage):
    refs = {}
    for source, _, _, _, repo, n in edges:
        refs.setdefault(source, set()).add(f"{repo}#{n}")
    for issue in issues:
        number, url = issue["number"], issue["url"]
        surface, owner = route(issue)
        entries = coverage.get(number, [])
        if entries:
            artifacts = "; ".join(dict.fromkeys(file for file, _ in entries))
            decisions = list(dict.fromkeys(row["decision"] for _, row in entries))
            owners = "; ".join(dict.fromkeys(row["ownerModule"] for _, row in entries))
            decision = decisions[0] if len(decisions) == 1 else ""
            evidence, gap = artifacts, "按分项台账；保留所有冲突、待复核和运行证据缺口"
            acceptance = "; ".join(row["requirementId"] for _, row in entries)
        else:
            evidence, gap = ("open-issues.ndjson.gz: number=" + str(number),
                             "已保存正文与评论；尚未据全部条款裁决、分配测试或取实现证据")
            decision, owners, acceptance = "", owner, ""
        yield (f"ISSUE-{number}", url, issue["updatedAt"], issue["state"],
               re.sub(r"\s+", " ", issue["title"]), surface, decision, owners,
               "; ".join(sorted(refs.get(url, set()))), acceptance, evidence, gap)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=Path("docs/issues"))
    parser.add_argument("--independent-rest", type=Path)
    args = parser.parse_args()
    repository, issues = verify(args.input, args.independent_rest)
    coverage = dispositions(args.input, issues)
    comment_review = comment_progress(args.input, issues, coverage)
    edges = [edge for issue in issues for edge in references(repository, issue)]
    tsv(args.input / "text-reference-candidates.tsv",
        ("sourceIssue", "sourceDocument", "line", "marker", "targetRepository", "targetNumber"), edges)
    reference_review = project_references(args.input, repository, issues, edges, tsv)
    tsv(args.input / "review-queue.tsv", HEADER, review_queue(issues, edges, coverage))
    missing = [i["number"] for i in issues if i["number"] not in coverage]
    result = {
        "totalOpenIssues": len(issues), "issuesWithDispositionRows": len(coverage),
        "issuesWithoutDispositionRows": missing,
        "dispositionRows": sum(len(rows) for rows in coverage.values()),
        "explicitTextReferenceCandidates": len(edges),
        "explicitReferenceReview": reference_review,
        "fullClauseAdjudicationComplete": False,
    }
    (args.input / "review-progress.json").write_text(json.dumps(result, indent=2) + "\n")
    (args.input / "comment-progress.json").write_text(json.dumps(comment_review, ensure_ascii=False, indent=2) + "\n")
    print(f"Validated {len(issues)} frozen issues; {len(coverage)} have disposition rows; "
          f"{len(missing)} are queued; indexed {len(edges)} explicit-text reference candidates.")
    print(f"Validated {comment_review['classifiedComments']} distinct comment dispositions; "
          f"{comment_review['unclassifiedComments']} comments are queued.")
