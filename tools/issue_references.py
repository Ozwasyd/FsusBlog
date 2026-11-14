"""Normalize frozen textual declarations and GitHub relationship metadata offline."""

import csv
import re
from collections import Counter, defaultdict


MARKERS = {
    "depends on": "prerequisite",
    "depend on": "prerequisite",
    "dependencies": "prerequisite",
    "blocked by": "prerequisite",
    "blocks": "blocks",
    "parent": "parent",
    "related": "related",
    "implementation dag": "dag-member",
    "前置依赖": "prerequisite",
    "本仓前置依赖": "prerequisite",
    "跨仓前置依赖": "prerequisite",
    "依赖": "prerequisite",
    "父项": "parent",
    "阻塞": "reported-blocker",
    "关联": "related",
}
INTERPRETATIONS = set(MARKERS.values()) | {
    "acceptance-gate", "conditional-prerequisite", "context", "historical",
    "pr-evidence", "reference-conflict", "reported-blocker", "scope-exclusion",
    "source-handoff", "tracking",
}
TOKEN = r"(?:https://github\.com/[\w.-]+/[\w.-]+/issues/\d+|(?:[\w.-]+/[\w.-]+)?#\d+)"
ISSUE_LIST = re.compile(rf"{TOKEN}(?:\s*[,、，]\s*{TOKEN})*\.?")
ISSUE_NUMBER = re.compile(r"(?:#\s*|/(?:issues|pull)/)([0-9]+)")
LOCATOR = re.compile(r"#(\d+)(?:@([0-9]+))?:(\d+)(?:[-–](\d+))?")
QUALIFICATION_HEADER = ("sourceDocument", "line", "targetNumber", "interpretation", "support", "note")
TEXT_HEADER = (
    "sourceIssue", "sourceDocument", "snapshotLocator", "marker", "targetNumber",
    "freezeTargetState", "interpretation", "formalRelations", "rawOccurrences", "support", "note",
)
FORMAL_HEADER = ("relation", "fromIssue", "fromState", "toIssue", "toState", "snapshotFields")


def formal_edges(repository, issues):
    metadata = {
        "blockedBy": ("prerequisite", True),
        "blocking": ("prerequisite", False),
        "parent": ("parent", True),
        "subIssues": ("parent", False),
    }
    states = {i["number"]: i["state"] for i in issues}
    edges = defaultdict(list)
    for issue in issues:
        for field, (relation, reverse) in metadata.items():
            records = issue[field]
            if field == "parent":
                records = [records] if records else []
            for index, target in enumerate(records):
                source, related = issue["number"], target["number"]
                locator = f"issue={source}.{field}"
                if field != "parent":
                    locator += f"[{index}]"
                url = f"https://github.com/{repository}/issues/{related}"
                if target["url"].casefold() != url.casefold():
                    raise ValueError(f"unexpected frozen formal issue identity at {locator}: {target['url']}")
                first, second = (related, source) if reverse else (source, related)
                edges[relation, first, second].append(locator)
                if states.setdefault(related, target["state"]) != target["state"]:
                    raise ValueError(f"conflicting frozen states at {locator}")
    return states, edges


def qualifications(path, sources, locators):
    if not path.exists():
        return {}
    decisions = {}
    with path.open(encoding="utf-8", newline="") as stream:
        reader = csv.DictReader(stream, delimiter="\t")
        if tuple(reader.fieldnames or ()) != QUALIFICATION_HEADER:
            raise ValueError(f"unexpected qualification header in {path}")
        for row in reader:
            document = row["sourceDocument"]
            line = int(row["line"])
            target = int(row["targetNumber"])
            key = document, line, target
            lines = sources.get(document, (None, []))[1]
            if not 1 <= line <= len(lines) or str(target) not in ISSUE_NUMBER.findall(lines[line - 1]):
                raise ValueError(f"qualification does not cite a target on the exact source line: {key}")
            if key in decisions or row["interpretation"] not in INTERPRETATIONS or not row["note"]:
                raise ValueError(f"invalid or duplicate qualification: {key}")
            for locator in row["support"].split("; "):
                match = LOCATOR.fullmatch(locator)
                if not match:
                    raise ValueError(f"invalid support locator {locator!r}: {key}")
                issue, comment, start, end = match.groups()
                lines = locators.get((int(issue), comment), [])
                if not 1 <= int(start) <= int(end or start) <= len(lines):
                    raise ValueError(f"support locator outside frozen document {locator!r}: {key}")
            decisions[key] = row
    return decisions


def text_choice(line, marker, is_body):
    relation = MARKERS.get(marker.lower(), "review-needed")
    remainder = re.split("[:：]", line, maxsplit=1)[1].strip()
    if is_body and (ISSUE_LIST.fullmatch(remainder) or relation == "dag-member"):
        return relation
    return "review-needed"


def project(folder, repository, issues, candidates, write_tsv):
    sources = {}
    locators = {}
    for issue in issues:
        lines = (issue["body"] or "").splitlines()
        locators[issue["number"], None] = lines
        sources[issue["url"]] = (issue, lines)
        for comment in issue["comments"]:
            lines = (comment["body"] or "").splitlines()
            comment_id = comment["url"].rsplit("#issuecomment-", 1)[1]
            locators[issue["number"], comment_id] = lines
            sources[comment["url"]] = (issue, lines)

    rules = qualifications(folder / "text-reference-qualifications.tsv", sources, locators)
    states, edges = formal_edges(repository, issues)
    pair_relations = defaultdict(list)
    formal_rows = []
    for (relation, first, second), fields in sorted(edges.items()):
        formal_rows.append((relation, first, states[first], second, states[second], "; ".join(fields)))
        prefix, inverse = ("blocks", "prerequisite") if relation == "prerequisite" else ("child", "parent")
        pair_relations[first, second].append(prefix)
        pair_relations[second, first].append(inverse)
    write_tsv(folder / "formal-relations.tsv", FORMAL_HEADER, formal_rows)

    occurrences = Counter()
    source_markers = {}
    for _, document, line, marker, target_repo, target in candidates:
        if target_repo.casefold() != repository.casefold():
            continue
        key = document, line, int(target)
        occurrences[key] += 1
        previous = source_markers.setdefault(key, marker)
        if previous != marker:
            raise ValueError(f"frozen source line has two markers: {key}")

    rows = []
    interpretations = Counter()
    open_body_raw = 0
    target_states = Counter()
    for key in sorted(occurrences.keys() | rules.keys()):
        document, line, target = key
        issue, source_lines = sources[document]
        source = issue["number"]
        issue_url = issue["url"]
        is_body = document == issue_url
        location = f"issue={source}.body:L{line}"
        if not is_body:
            comment = document.rsplit("#issuecomment-", 1)[1]
            location = f"issue={source}.comment={comment}.body:L{line}"
        state = states.get(target, "ABSENT")
        target_states[state] += 1
        rule = rules.get(key)
        marker = source_markers.get(key, "")
        interpretation = rule["interpretation"] if rule else text_choice(source_lines[line - 1], marker, is_body)
        interpretations[interpretation] += 1
        if is_body and state == "OPEN":
            open_body_raw += occurrences[key]
        rows.append((issue_url, document, location, marker, target, state, interpretation,
                     "; ".join(pair_relations[source, target]), occurrences[key],
                     rule["support"] if rule else "—", rule["note"] if rule else "—"))
    write_tsv(folder / "text-reference-dispositions.tsv", TEXT_HEADER, rows)

    return {
        "sameRepositoryTextCandidateOccurrences": sum(occurrences.values()),
        "sameRepositoryOpenTargetBodyOccurrences": open_body_raw,
        "uniqueSameRepositoryCandidateLocators": len(occurrences),
        "qualifiedLocators": len(rules),
        "supplementalLocators": len(rules.keys() - occurrences.keys()),
        "freezeTargetStates": dict(sorted(target_states.items())),
        "interpretations": dict(sorted(interpretations.items())),
        "normalizedFormalEdges": len(formal_rows),
    }
