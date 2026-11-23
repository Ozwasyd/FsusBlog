#!/usr/bin/env python3
"""Read current metadata for reference targets absent from the frozen issue catalog."""

import argparse
import csv
import datetime as dt
import json
import re
import subprocess
import time
from collections import Counter
from pathlib import Path


COMMON = "number url title state createdAt updatedAt closedAt"
FIELDS = (f"__typename ... on Issue {{ {COMMON} stateReason }} "
          f"... on PullRequest {{ {COMMON} mergedAt headRefOid baseRefOid mergeCommit {{ oid }} }}")
HEADER = (
    "targetNumber", "frozenReferenceLocators", "observedAtUtc", "kind", "observedState",
    "stateReason", "url", "title", "createdAt", "updatedAt", "closedAt", "mergedAt",
    "headCommit", "baseCommit", "mergeCommit", "restStatus", "restRequestId",
)


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def request(arguments, payload=None):
    for attempt in range(3):
        try:
            response = subprocess.run(
                ["gh", "api", "--hostname", "github.com", "--include", *arguments],
                input=payload, capture_output=True, text=True, timeout=60,
            )
        except subprocess.TimeoutExpired:
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)
            continue
        header, _, body = response.stdout.partition("\n\n")
        match = re.match(r"HTTP/\S+ (\d{3})", header)
        if match and int(match[1]) not in (502, 503, 504):
            fields = dict(line.split(": ", 1) for line in header.splitlines()[1:])
            headers = {key.lower(): value for key, value in fields.items()}
            return int(match[1]), headers, json.loads(body) if body else None
        if attempt < 2:
            time.sleep(2 ** attempt)
    raise RuntimeError(f"GitHub did not return a usable response: {response.stderr.strip()}")


def graphql(repository, numbers):
    owner, name = repository.split("/")
    selections = " ".join(f"n{n}: issueOrPullRequest(number: {n}) {{ {FIELDS} }}" for n in numbers)
    query = (
        "query($owner: String!, $name: String!) { "
        "repository(owner: $owner, name: $name) { nameWithOwner " + selections + " } "
        "rateLimit { cost remaining } }"
    )
    status, headers, response = request(
        ["--method", "POST", "graphql", "--input", "-"],
        json.dumps({"query": query, "variables": {"owner": owner, "name": name}}),
    )
    if status != 200 or not response.get("data"):
        raise RuntimeError(f"GitHub GraphQL returned HTTP {status}: {response}")
    data = response["data"]
    found = data["repository"]
    if not found or found["nameWithOwner"].casefold() != repository.casefold():
        raise RuntimeError("GitHub returned a different repository")
    errors = {}
    for error in response.get("errors", []):
        path = error.get("path")
        if error["type"] != "NOT_FOUND" or not path or path[0] != "repository" or len(path) != 2:
            raise RuntimeError(f"GitHub returned an unexpected error: {error}")
        errors[path[1]] = error["type"]
    missing = {f"n{n}" for n in numbers if found[f"n{n}"] is None}
    if set(errors) != missing:
        raise RuntimeError("GraphQL unresolved aliases lack an exact matching error")
    return {n: found[f"n{n}"] for n in numbers}, headers, data["rateLimit"]


def rest_check(repository, number, target):
    path = f"repos/{repository}/issues/{number}"
    status, headers, result = request(["--method", "GET", path])
    check = {
        "number": number, "observedAtUtc": now(), "serverDate": headers["date"],
        "requestId": headers["x-github-request-id"], "httpStatus": status,
    }
    if target:
        kind = "PullRequest" if result and result.get("pull_request") else "Issue"
        expected_state = "closed" if target["state"] == "MERGED" else target["state"].lower()
        if (status != 200 or kind != target["__typename"] or result["number"] != number
                or result["html_url"] != target["url"] or result["state"] != expected_state):
            raise RuntimeError(f"REST and GraphQL disagree for #{number}")
        check.update(kind=kind, url=result["html_url"], state=result["state"])
        if kind == "PullRequest":
            check["mergedAt"] = result["pull_request"]["merged_at"]
            if check["mergedAt"] != target["mergedAt"]:
                raise RuntimeError(f"REST and GraphQL merge dates differ for #{number}")
        else:
            check["stateReason"] = result["state_reason"]
            if (check["stateReason"] or "").upper() != (target["stateReason"] or ""):
                raise RuntimeError(f"REST and GraphQL close reasons differ for #{number}")
    else:
        if status not in (404, 410):
            raise RuntimeError(f"GraphQL did not resolve #{number} but REST returned HTTP {status}")
        check["message"] = result["message"]
    return check


def counts(folder):
    with (folder / "text-reference-dispositions.tsv").open(encoding="utf-8", newline="") as stream:
        return Counter(
            int(row["targetNumber"]) for row in csv.DictReader(stream, delimiter="\t")
            if row["freezeTargetState"] == "ABSENT"
        )


def render(folder, observation, targets):
    seen = set()
    rows = []
    observations = Counter()
    locators = Counter()
    repository = observation["repository"]
    started = dt.datetime.fromisoformat(observation["startedAtUtc"])
    finished = dt.datetime.fromisoformat(observation["finishedAtUtc"])
    rest_checks = 0
    for batch in observation["batches"]:
        observed_at = batch["observedAtUtc"]
        if not started <= dt.datetime.fromisoformat(observed_at) <= finished or not batch["requestId"]:
            raise ValueError("invalid GraphQL capture time or request ID")
        rest = {entry["number"]: entry for entry in batch["restChecks"]}
        if (len(rest) != len(batch["restChecks"])
                or not rest.keys() <= {item["number"] for item in batch["targets"]}):
            raise ValueError("unexpected or duplicate REST reads")
        rest_checks += len(rest)
        for item in batch["targets"]:
            number, target = item["number"], item["metadata"]
            if number not in targets or number in seen:
                raise ValueError(f"unexpected or duplicate target observation: {number}")
            seen.add(number)
            check = rest.get(number, {})
            if check and (not started <= dt.datetime.fromisoformat(check["observedAtUtc"]) <= finished
                          or not check["requestId"]):
                raise ValueError(f"invalid REST capture time or request ID: {number}")
            if target:
                kind, state = target["__typename"], target["state"]
                endpoint = "issues" if kind == "Issue" else "pull"
                url = f"https://github.com/{repository}/{endpoint}/{number}"
                valid_states = {"OPEN", "CLOSED"} if kind == "Issue" else {"OPEN", "CLOSED", "MERGED"}
                if (kind not in {"Issue", "PullRequest"} or target["number"] != number
                        or target["url"] != url or state not in valid_states):
                    raise ValueError(f"unexpected GitHub target identity: {number}")
                if check and (check["httpStatus"] != 200 or check["kind"] != kind or check["url"] != url
                              or check["state"] != ("closed" if state == "MERGED" else state.lower())):
                    raise ValueError(f"conflicting REST evidence: {number}")
                if "stateReason" in check and (check["stateReason"] or "").upper() != (target["stateReason"] or ""):
                    raise ValueError(f"conflicting REST close reason: {number}")
                if kind == "PullRequest":
                    shas = [target.get("headRefOid"), target.get("baseRefOid"), (target.get("mergeCommit") or {}).get("oid")]
                    if any(sha and not re.fullmatch(r"[0-9a-f]{40}", sha) for sha in shas):
                        raise ValueError(f"invalid GitHub commit SHA: {number}")
                    if state == "MERGED" and (not target["mergedAt"] or not shas[2]):
                        raise ValueError(f"missing GitHub merge evidence: {number}")
            else:
                kind = "Unresolved"
                state = {404: "NOT_VISIBLE", 410: "GONE"}.get(check.get("httpStatus"))
                if not state:
                    raise ValueError(f"unresolved target without an exact REST read: {number}")
                url = f"https://github.com/{repository}/issues/{number}"
                target = {}
            key = kind, state
            observations[key] += 1
            locators[key] += targets[number]
            rows.append((
                number, targets[number], observed_at, kind, state, target.get("stateReason") or "—", url,
                target.get("title") or "—", target.get("createdAt") or "—", target.get("updatedAt") or "—",
                target.get("closedAt") or "—", target.get("mergedAt") or "—", target.get("headRefOid") or "—",
                target.get("baseRefOid") or "—", (target.get("mergeCommit") or {}).get("oid") or "—",
                check.get("httpStatus", "—"), check.get("requestId", "—"),
            ))
    if seen != targets.keys():
        raise ValueError("capture does not match the current set of frozen absent targets")
    with (folder / "target-observations.tsv").open("w", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream, delimiter="\t", lineterminator="\n")
        writer.writerow(HEADER)
        writer.writerows(sorted(rows))
    totals = [
        {"kind": kind, "state": state, "targets": observations[kind, state], "referenceLocators": locators[kind, state]}
        for kind, state in sorted(observations)
    ]
    progress = {
        "repository": repository,
        "startedAtUtc": observation["startedAtUtc"],
        "finishedAtUtc": observation["finishedAtUtc"],
        "frozenAbsentTargets": len(targets),
        "frozenReferenceLocators": sum(targets.values()),
        "observedTargets": len(seen),
        "graphQLRequests": len(observation["batches"]),
        "restChecks": rest_checks,
        "targetTypesAndStates": totals,
        "closedIssueReasons": dict(sorted(Counter(
            row[5] for row in rows if row[3:5] == ("Issue", "CLOSED")
        ).items())),
        "currentIdentityUnresolved": observations["Unresolved", "GONE"] + observations["Unresolved", "NOT_VISIBLE"],
        "fullDependencySemanticsReviewed": False,
    }
    (folder / "target-observation-progress.json").write_text(
        json.dumps(progress, ensure_ascii=False, indent=2) + "\n", encoding="utf-8",
    )
    return totals


def capture(repository, targets, rest_targets):
    if rest_targets - targets.keys():
        raise ValueError("supplemental REST targets must belong to the frozen target set")
    batches = []
    started = now()
    numbers = sorted(targets)
    for start in range(0, len(numbers), 15):
        batch = numbers[start:start + 15]
        records, headers, rate = graphql(repository, batch)
        receipt = {
            "observedAtUtc": now(), "serverDate": headers["date"], "requestId": headers["x-github-request-id"],
            "rateLimit": rate, "targets": [{"number": n, "metadata": target} for n, target in records.items()],
            "restChecks": [],
        }
        for number, target in records.items():
            if not target or number in rest_targets:
                receipt["restChecks"].append(rest_check(repository, number, target))
        batches.append(receipt)
        print(f"Read {start + len(batch)}/{len(numbers)} candidate targets", flush=True)
    return {"repository": repository, "startedAtUtc": started, "finishedAtUtc": now(), "batches": batches}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=Path("docs/archive/v1-baseline/issues"))
    parser.add_argument("--capture", action="store_true", help="requery GitHub instead of rebuilding offline")
    parser.add_argument("--rest-check", type=int, action="append", default=[])
    args = parser.parse_args()
    targets = counts(args.input)
    repository = json.loads((args.input / "census.json").read_text())["repository"]
    path = args.input / "target-observations.json"
    if args.capture:
        observation = capture(repository, targets, set(args.rest_check))
    else:
        observation = json.loads(path.read_text())
        if observation["repository"] != repository:
            raise ValueError("capture repository does not match the issue census")
    totals = render(args.input, observation, targets)
    if args.capture:
        path.write_text(json.dumps(observation, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(totals, ensure_ascii=False))


if __name__ == "__main__":
    main()
