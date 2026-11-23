#!/usr/bin/env python3
"""Verify active FsusBlog v2 documentation integrity, link health, and config parity."""

from __future__ import annotations

import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

ALLOWED_DOCS_ROOT_FILES = {
    "index.md",
    "protocol.md",
    "migration.md",
    "fsusui.md",
    "publication-lease.md",
    "web-validation.md",
}

TOP_LEVEL_ACTIVE_DOCS = [
    "README.md",
    "AGENTS.md",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "CHANGELOG.md",
    "deploy/README.md",
    "tests/Performance/README.md",
]

# Internal child-process sentinel set by CLI/launcher, not a user deployment setting.
INTERNAL_ENV_ALLOWLIST = {
    "FSUSBLOG_PURE_PLUGIN_WORKER",
}

MD_LINK_RE = re.compile(r"!?\[([^\]]*)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
REF_DEF_RE = re.compile(r"^\s*\[([^\]]+)\]:\s*(\S+)", re.MULTILINE)
FENCE_RE = re.compile(r"^\s*(```|~~~)")
ENV_RE = re.compile(r"\bFSUSBLOG_[A-Z0-9_]+\b")


def strip_code_blocks_and_inline_code(text: str) -> str:
    """Replace fenced code blocks and inline code spans with blanks while preserving line numbers."""
    out_lines: list[str] = []
    in_fence = False
    fence_marker = ""
    for line in text.splitlines():
        m = FENCE_RE.match(line)
        if m:
            marker = m.group(1)
            if not in_fence:
                in_fence = True
                fence_marker = marker
                out_lines.append("")
                continue
            if marker == fence_marker:
                in_fence = False
                fence_marker = ""
                out_lines.append("")
                continue
        if in_fence:
            out_lines.append("")
        else:
            out_lines.append(re.sub(r"`[^`]*`", "", line))
    return "\n".join(out_lines)


def git_ls_files(*paths: str) -> list[str]:
    cmd = ["git", "-C", str(ROOT), "ls-files", "--", *paths]
    out = subprocess.check_output(cmd, text=True)
    return [line for line in out.splitlines() if line]


def iter_active_docs() -> list[pathlib.Path]:
    docs: list[pathlib.Path] = []
    for rel in TOP_LEVEL_ACTIVE_DOCS:
        p = ROOT / rel
        if p.exists():
            docs.append(p)
    for p in sorted((ROOT / "docs").rglob("*.md")):
        docs.append(p)
    return docs


def check_links(active_docs: list[pathlib.Path]) -> list[str]:
    errors: list[str] = []
    for doc in active_docs:
        rel_doc = doc.relative_to(ROOT).as_posix()
        raw = doc.read_text(encoding="utf-8")
        cleaned = strip_code_blocks_and_inline_code(raw)
        targets: list[tuple[int, str]] = []
        for idx, line in enumerate(cleaned.splitlines(), start=1):
            for m in MD_LINK_RE.finditer(line):
                targets.append((idx, m.group(2).strip()))
            ref = REF_DEF_RE.match(line)
            if ref:
                targets.append((idx, ref.group(2).strip()))

        for lineno, raw_target in targets:
            target = raw_target.strip("<>").split("#", 1)[0].split("?", 1)[0]
            if not target or target.startswith(("http://", "https://", "mailto:", "tel:")):
                continue
            norm = target.replace("\\", "/")
            if norm == "artifacts" or norm.startswith("artifacts/") or "/artifacts/" in norm or norm.endswith("/artifacts"):
                errors.append(f"{rel_doc}:{lineno}: forbidden link to gitignored artifacts/: {raw_target}")
                continue
            resolved = (doc.parent / target).resolve()
            try:
                resolved.relative_to(ROOT)
            except ValueError:
                errors.append(f"{rel_doc}:{lineno}: relative link escapes repository root: {raw_target}")
                continue
            if not resolved.exists():
                errors.append(f"{rel_doc}:{lineno}: broken relative link: {raw_target}")
    return errors


def check_docs_root_hygiene() -> list[str]:
    errors: list[str] = []
    for p in sorted((ROOT / "docs").iterdir()):
        if p.is_file() and p.suffix == ".md":
            if p.name not in ALLOWED_DOCS_ROOT_FILES:
                errors.append(
                    f"docs/{p.name}: unexpected root-level docs/*.md; place under docs/architecture, "
                    "docs/reference, docs/product, docs/development, or docs/releases"
                )
    return errors


def check_tracked_ds_store() -> list[str]:
    tracked = [p for p in git_ls_files() if pathlib.PurePosixPath(p).name == ".DS_Store"]
    return [f"{p}: .DS_Store must not be tracked in Git" for p in tracked]


def check_config_parity() -> list[str]:
    config_doc = ROOT / "docs/reference/configuration.md"
    if not config_doc.exists():
        return []
    src_files = git_ls_files("src/")
    code_vars: set[str] = set()
    for rel in src_files:
        p = ROOT / rel
        if not p.is_file():
            continue
        if p.suffix not in {".cs", ".ts", ".vue", ".json", ".c", ".h", ".cpp", ".hpp"}:
            continue
        if rel.endswith("locales.json"):
            continue
        text = p.read_text(encoding="utf-8", errors="ignore")
        code_vars.update(ENV_RE.findall(text))
    code_vars -= INTERNAL_ENV_ALLOWLIST
    doc_text = config_doc.read_text(encoding="utf-8")
    doc_vars = set(ENV_RE.findall(doc_text))
    missing = sorted(code_vars - doc_vars)
    return [
        f"docs/reference/configuration.md: missing runtime environment variable from src/: {var}"
        for var in missing
    ]


def check_index_coverage(active_docs: list[pathlib.Path]) -> list[str]:
    index_doc = ROOT / "docs/index.md"
    if not index_doc.exists():
        return ["docs/index.md: missing central documentation index"]
    cleaned = strip_code_blocks_and_inline_code(index_doc.read_text(encoding="utf-8"))
    indexed: set[pathlib.Path] = set()
    for m in MD_LINK_RE.finditer(cleaned):
        raw = m.group(2).strip().strip("<>").split("#", 1)[0].split("?", 1)[0]
        if not raw or raw.startswith(("http://", "https://", "mailto:", "tel:")):
            continue
        indexed.add((index_doc.parent / raw).resolve())

    errors: list[str] = []
    for doc in active_docs:
        rel = doc.relative_to(ROOT).as_posix()
        if not rel.startswith("docs/") or rel == "docs/index.md":
            continue
        if doc.resolve() not in indexed:
            errors.append(f"docs/index.md: missing link to active document: {rel}")
    return errors


def main() -> int:
    active_docs = iter_active_docs()
    errors: list[str] = []
    errors.extend(check_links(active_docs))
    errors.extend(check_docs_root_hygiene())
    errors.extend(check_tracked_ds_store())
    errors.extend(check_config_parity())
    errors.extend(check_index_coverage(active_docs))

    if errors:
        print(f"Documentation check failed with {len(errors)} issue(s):", file=sys.stderr)
        for err in errors:
            print(f"  - {err}", file=sys.stderr)
        return 1

    print(f"Documentation check passed ({len(active_docs)} active documents verified).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
