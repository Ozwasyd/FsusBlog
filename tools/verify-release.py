#!/usr/bin/env python3
"""Verify the checksums, payload and complete Git history of a local FsusBlog release."""

import argparse
import hashlib
import json
import os
import re
import subprocess
import tarfile
import tempfile
from pathlib import Path, PurePosixPath


SUM = re.compile(r"([a-f0-9]{64})  (.+)")
COMMIT = re.compile(r"[a-f0-9]{40}")
PACKAGE_ID = re.compile(r"@ozwasyd/element-plus@[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?")
PACKAGE = "fsusblog-v2.tar.gz"
HISTORY = "history.bundle"


def ensure(condition, message: str) -> None:
    if not condition:
        raise ValueError(message)


def file_sha256(file) -> str:
    digest = hashlib.sha256()
    for block in iter(lambda: file.read(128 * 1024), b""):
        digest.update(block)
    return digest.hexdigest()


def relative_name(name: str) -> str:
    path = PurePosixPath(name)
    ensure(name not in ("", ".") and not path.is_absolute() and path.as_posix() == name and ".." not in path.parts,
           f"Invalid release path: {name!r}")
    return name


def read_manifest(path: Path, prefix: str = "") -> dict[str, str]:
    entries: dict[str, str] = {}
    with path.open(encoding="utf-8") as manifest:
        for line in manifest:
            match = SUM.fullmatch(line.rstrip("\n"))
            ensure(match and match[2].startswith(prefix), f"Invalid checksum record in {path.name}")
            name = relative_name(match[2][len(prefix):])
            ensure(name not in entries, f"Duplicate checksum record for {name}")
            entries[name] = match[1]
    return entries


def verify_payload(archive: Path, expected: dict[str, str]) -> dict[str, str]:
    seen: set[str] = set()
    coordinates: dict[str, str] = {}
    with tarfile.open(archive, "r:gz") as package:
        for member in package:
            if member.isdir() and member.name == ".":
                continue
            name = relative_name(member.name.removeprefix("./"))
            if member.isdir():
                continue
            ensure(member.isfile() and name not in seen and name in expected, f"Unexpected payload entry: {name}")
            seen.add(name)
            with package.extractfile(member) as data:
                if name == "release.txt":
                    ensure(member.size <= 4096, "Release coordinates exceed the size limit")
                    contents = data.read()
                    digest = hashlib.sha256(contents).hexdigest()
                    for line in contents.decode("ascii").splitlines():
                        key, separator, value = line.partition("=")
                        ensure(separator and key and key not in coordinates, "Invalid release coordinates")
                        coordinates[key] = value
                else:
                    digest = file_sha256(data)
            ensure(digest == expected[name], f"Payload checksum mismatch: {name}")
    if missing := expected.keys() - seen:
        raise ValueError(f"Package is missing {min(missing)}")
    ensure(COMMIT.fullmatch(coordinates.get("fsusblog_commit", "")), "Missing or invalid release commit coordinates")
    ensure(PACKAGE_ID.fullmatch(coordinates.get("fsusui_package", "")) or COMMIT.fullmatch(coordinates.get("fsusui_commit", "")),
           "Missing or invalid FsusUI release coordinates")
    ensure(coordinates.get("web") == "web/" and "web/index.html" in seen, "Missing built web entry point")
    cli_path = coordinates.get("cli")
    ensure(cli_path is None or cli_path == "cli/FsusBlog.V2.Cli.dll", "Invalid release CLI coordinates")
    for key in ("server", "cli" if cli_path is not None else "migrate", "dictionary"):
        if key != "dictionary" or key in coordinates:
            ensure(coordinates.get(key) in seen, f"Missing release file for {key}")
    if "server_rid" in coordinates or "heading_parser" in coordinates:
        libraries = {
            "osx-arm64": "server/libfsus_author_heading.dylib", "osx-x64": "server/libfsus_author_heading.dylib",
            "linux-arm64": "server/libfsus_author_heading.so", "linux-x64": "server/libfsus_author_heading.so",
        }
        library = libraries.get(coordinates.get("server_rid"))
        ensure(library in seen and coordinates.get("heading_parser") == library, "Missing or invalid release heading parser coordinates")
    return coordinates


def verify_history(bundle: Path, commit: str) -> int:
    with tempfile.TemporaryDirectory(prefix="fsusblog-release-history-") as scratch:
        git = ["git", "-C", scratch]
        environment = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        environment.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1", GIT_ALLOW_PROTOCOL="file")

        def command(*args: str) -> str:
            return subprocess.run([*git, *args], env=environment, capture_output=True, text=True, check=True).stdout.strip()

        command("init", "--bare", "--template=")
        command("fetch", "--no-tags", str(bundle), "HEAD:refs/heads/candidate")
        command("fsck", "--full")
        ensure(command("rev-parse", "refs/heads/candidate") == commit, "Git history and payload identify different commits")
        return int(command("rev-list", "--count", "refs/heads/candidate"))


def verify_wasm(inputs: dict[str, str], payload: dict[str, str]) -> None:
    for stem in ("ep_wasm", "markdown_basic", "markdown_simd"):
        matches = [digest for name, digest in payload.items()
                   if name.startswith(f"web/assets/{stem}-") and name.endswith(".wasm")]
        ensure(len(matches) == 1 and matches[0] == inputs.get(f"{stem}.wasm"),
               f"Bundled Wasm differs from the reported FsusUI input: {stem}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("release", type=Path)
    directory = parser.parse_args().release.resolve()
    try:
        outer = read_manifest(directory / "SHA256SUMS")
        ensure(set(outer) == {PACKAGE, HISTORY}, "SHA256SUMS must identify the release archive and Git bundle")
        for name, digest in outer.items():
            with (directory / name).open("rb") as file:
                ensure(file_sha256(file) == digest, f"Release checksum mismatch: {name}")
        payload = read_manifest(directory / "payload.sha256", "./")
        coordinates = verify_payload(directory / PACKAGE, payload)
        verify_wasm(read_manifest(directory / "fsusui-wasm.sha256"), payload)
        commits = verify_history(directory / HISTORY, coordinates["fsusblog_commit"])
    except (OSError, ValueError, tarfile.TarError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"{error}\n")
    summary = {"fsusblogCommit": coordinates["fsusblog_commit"], "payloadFiles": len(payload), "gitCommits": commits}
    for src, dst in (("fsusui_package", "fsusuiPackage"), ("fsusui_commit", "fsusuiCommit")):
        if src in coordinates:
            summary[dst] = coordinates[src]
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
