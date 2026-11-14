#!/usr/bin/env python3
"""Capture a GitHub issue census using read-only GraphQL queries."""

import argparse
import csv
import datetime as dt
import gzip
import hashlib
import json
import re
import subprocess
import sys
import time
from pathlib import Path


QUERY_META = """
query($owner:String!, $name:String!){
  repository(owner:$owner,name:$name){
    nameWithOwner url isArchived
    issues(states:OPEN){totalCount}
    pullRequests(states:OPEN){totalCount}
  }
}
"""

RELATED = "number url state title updatedAt"
CONNECTIONS = {
    "labels": "name",
    "comments": "id url createdAt updatedAt body author{login}",
    "blockedBy": RELATED,
    "blocking": RELATED,
    "subIssues": RELATED,
}


def connection(name, selection, first, after=""):
    return (f"{name}(first:{first}{after})"
            f"{{totalCount pageInfo{{hasNextPage endCursor}} nodes{{{selection}}}}}")


def run_query(query, **variables):
    payload = {"query": query, "variables": variables}
    for attempt in range(3):
        result = subprocess.run(
            ["gh", "api", "graphql", "--method", "POST", "--input", "-"],
            input=json.dumps(payload), capture_output=True, text=True, timeout=120,
        )
        if result.returncode == 0 or not re.search(r"EOF|HTTP 50[0234]|timed out", result.stderr):
            break
        time.sleep(attempt + 1)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or f"gh exited {result.returncode}")
    data = json.loads(result.stdout)
    if data.get("errors"):
        raise RuntimeError(str(data["errors"]))
    return data["data"]


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def collect(args):
    owner, name = args.repository.split("/", 1)
    repo = {"owner": owner, "name": name}
    started_at = now()
    before = run_query(QUERY_META, **repo)["repository"]
    if not before:
        raise RuntimeError("repository not found")
    expected = before["issues"]["totalCount"]
    fields = " ".join(connection(k, v, 8) for k, v in CONNECTIONS.items())
    query = ("""
query($owner:String!, $name:String!, $after:String, $first:Int!) {
  repository(owner:$owner,name:$name){
    issues(first:$first,after:$after,states:OPEN,orderBy:{field:CREATED_AT,direction:ASC}) {
      totalCount pageInfo{hasNextPage endCursor} nodes{
        number url state createdAt updatedAt title body
"""
             + f"        parent{{{RELATED}}} {fields}"
             + "      }\n    }\n  }\n}")

    records = {}
    inventory_pages = []
    after = None
    while True:
        page = run_query(query, **repo, after=after, first=args.page_size)["repository"]["issues"]
        if page["totalCount"] != expected:
            raise RuntimeError("open issue count changed during pagination; retry")
        nodes = page["nodes"]
        for issue in nodes:
            number = issue["number"]
            if issue["state"] != "OPEN" or number in records:
                raise RuntimeError(f"invalid or duplicate open issue #{number}")
            records[number] = issue
        end = page["pageInfo"]["endCursor"]
        inventory_pages.append({
            "fromExclusive": after, "through": end,
            "hasNextPage": page["pageInfo"]["hasNextPage"],
            "issueNumbers": [i["number"] for i in nodes],
        })
        print(f"Fetched {len(records)} / {expected} issues", file=sys.stderr, flush=True)
        if not page["pageInfo"]["hasNextPage"]:
            break
        if not end or end == after or not nodes:
            raise RuntimeError("issue cursor did not advance")
        after = end
    if len(records) != expected:
        raise RuntimeError(f"received {len(records)}, but GitHub reported {expected} open issues")

    pending = [(issue, key) for issue in records.values() for key in CONNECTIONS
               if issue[key]["pageInfo"]["hasNextPage"]]
    continuations = dict.fromkeys(CONNECTIONS, 0)
    while pending:
        batch, pending = pending[:3], pending[3:]
        operations = []
        for i, (issue, key) in enumerate(batch):
            after = issue[key]["pageInfo"]["endCursor"]
            if not after:
                raise RuntimeError(f"missing {key} cursor for #{issue['number']}")
            field = connection(key, CONNECTIONS[key], 16, ",after:" + json.dumps(after))
            operations.append(f"i{i}:issue(number:{issue['number']}){{{field}}}")
        query = ("query($owner:String!, $name:String!){repository(owner:$owner,name:$name){"
                 + " ".join(operations) + "}}")
        pages = run_query(query, **repo)["repository"]
        for i, (issue, key) in enumerate(batch):
            previous = issue[key]
            additional = pages[f"i{i}"][key]
            if (additional["totalCount"] != previous["totalCount"]
                    or additional["pageInfo"]["endCursor"] == previous["pageInfo"]["endCursor"]
                    or not additional["nodes"]):
                raise RuntimeError(f"unstable {key} pagination on #{issue['number']}")
            previous["nodes"].extend(additional["nodes"])
            previous["pageInfo"] = additional["pageInfo"]
            continuations[key] += 1
            if previous["pageInfo"]["hasNextPage"]:
                pending.append((issue, key))
        print(f"Fetched {sum(continuations.values())} continuation pages; "
              f"{len(pending)} connections still open", file=sys.stderr, flush=True)

    totals = dict.fromkeys(CONNECTIONS, 0)
    for issue in records.values():
        for key in CONNECTIONS:
            data = issue[key]
            identity = "id" if key == "comments" else "name" if key == "labels" else "url"
            distinct = len({node[identity] for node in data["nodes"]})
            if data["pageInfo"]["hasNextPage"]:
                raise RuntimeError(f"incomplete {key} list on #{issue['number']}")
            if len(data["nodes"]) != data["totalCount"] or distinct != data["totalCount"]:
                raise RuntimeError(f"missing or repeated {key} on #{issue['number']}")
            totals[key] += data["totalCount"]
            issue[key] = data["nodes"]

    after = run_query(QUERY_META, **repo)["repository"]
    if before != after:
        raise RuntimeError("repository census metadata changed during collection; retry")
    finished_at = now()
    out = args.output
    out.mkdir(parents=True, exist_ok=True)
    records = sorted(records.values(), key=lambda i: i["number"])
    raw = "\n".join(json.dumps(issue, ensure_ascii=False, sort_keys=True) for issue in records) + "\n"
    snapshot = gzip.compress(raw.encode(), compresslevel=9, mtime=0)
    (out / "open-issues.ndjson.gz").write_bytes(snapshot)
    metadata = {
        "repository": before["nameWithOwner"], "repositoryUrl": before["url"],
        "archived": before["isArchived"], "startedAt": started_at, "finishedAt": finished_at,
        "githubOpenIssueCount": expected, "githubOpenPullRequestCount": before["pullRequests"]["totalCount"],
        "exportedIssueCount": len(records), "inventoryPages": inventory_pages,
        "connectionTotals": totals, "continuationPages": continuations,
        "parentLinkCount": sum(i["parent"] is not None for i in records),
        "snapshotSha256": hashlib.sha256(snapshot).hexdigest(),
        "ndjsonSha256": hashlib.sha256(raw.encode()).hexdigest(),
    }
    (out / "census.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")
    with (out / "inventory.tsv").open("w", encoding="utf-8", newline="") as manifest:
        writer = csv.writer(manifest, delimiter="\t", lineterminator="\n")
        writer.writerow(("sourceIssue", "sourceUpdatedAt", "observedState", "title", "comments",
                         "blockedBy", "blocking", "parent", "subIssues", "labels"))
        for i in records:
            urls = lambda key: "; ".join(v["url"] for v in i[key])
            writer.writerow((i["url"], i["updatedAt"], i["state"], re.sub(r"\s+", " ", i["title"]),
                             len(i["comments"]), urls("blockedBy"), urls("blocking"),
                             (i["parent"] or {}).get("url", ""), urls("subIssues"),
                             "; ".join(v["name"] for v in i["labels"])))
    print(f"Archived {len(records)} issue bodies and {totals['comments']} comments to {out}", file=sys.stderr)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", default="Ozwasyd/FsusBlog")
    parser.add_argument("--output", type=Path, default=Path("docs/issues"))
    parser.add_argument("--page-size", type=int, choices=range(1, 101), metavar="1..100", default=40)
    collect(parser.parse_args())
