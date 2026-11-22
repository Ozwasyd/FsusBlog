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
PACKAGE = "fsusblog-v2.tar.gz"
HISTORY = "history.bundle"


def file_sha256(file) -> str:
    digest = hashlib.sha256()
    for block in iter(lambda: file.read(128 * 1024), b""):
        digest.update(block)
    return digest.hexdigest()


def relative_name(name: str) -> str:
    path = PurePosixPath(name)
    if name in ("", ".") or path.is_absolute() or path.as_posix() != name or ".." in path.parts:
        raise ValueError(f"Invalid release path: {name!r}")
    return name


def read_manifest(path: Path, prefix: str = "") -> dict[str, str]:
    entries: dict[str, str] = {}
    with path.open(encoding="utf-8") as manifest:
        for line in manifest:
            match = SUM.fullmatch(line.rstrip("\n"))
            if not match or not match[2].startswith(prefix):
                raise ValueError(f"Invalid checksum record in {path.name}")
            name = relative_name(match[2][len(prefix):])
            if name in entries:
                raise ValueError(f"Duplicate checksum record for {name}")
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
            if not member.isfile() or name in seen or name not in expected:
                raise ValueError(f"Unexpected payload entry: {name}")
            seen.add(name)
            with package.extractfile(member) as data:
                if name == "release.txt":
                    if member.size > 4096:
                        raise ValueError("Release coordinates exceed the size limit")
                    contents = data.read()
                    digest = hashlib.sha256(contents).hexdigest()
                    for line in contents.decode("ascii").splitlines():
                        key, separator, value = line.partition("=")
                        if not separator or not key or key in coordinates:
                            raise ValueError("Invalid release coordinates")
                        coordinates[key] = value
                else:
                    digest = file_sha256(data)
            if digest != expected[name]:
                raise ValueError(f"Payload checksum mismatch: {name}")
    if missing := expected.keys() - seen:
        raise ValueError(f"Package is missing {min(missing)}")
    if any(not COMMIT.fullmatch(coordinates.get(key, "")) for key in ("fsusblog_commit", "fsusui_commit")):
        raise ValueError("Missing or invalid release commit coordinates")
    if coordinates.get("web") != "web/" or "web/index.html" not in seen:
        raise ValueError("Missing built web entry point")
    cli_path = coordinates.get("cli")
    if cli_path is not None and cli_path != "cli/FsusBlog.V2.Cli.dll":
        raise ValueError("Invalid release CLI coordinates")
    cli_key = "cli" if cli_path is not None else "migrate"
    for key in ("server", cli_key, "dictionary"):
        if key == "dictionary" and key not in coordinates:
            continue
        if coordinates.get(key) not in seen:
            raise ValueError(f"Missing release file for {key}")
    if "server_rid" in coordinates or "heading_parser" in coordinates:
        libraries = {
            "osx-arm64": "server/libfsus_author_heading.dylib",
            "osx-x64": "server/libfsus_author_heading.dylib",
            "linux-arm64": "server/libfsus_author_heading.so",
            "linux-x64": "server/libfsus_author_heading.so",
        }
        library = libraries.get(coordinates.get("server_rid"))
        if library not in seen or coordinates.get("heading_parser") != library:
            raise ValueError("Missing or invalid release heading parser coordinates")
    return coordinates


def verify_history(bundle: Path, commit: str) -> int:
    with tempfile.TemporaryDirectory(prefix="fsusblog-release-history-") as scratch:
        git = ["git", "-C", scratch]
        environment = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        environment.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1", GIT_ALLOW_PROTOCOL="file")

        def command(*args: str) -> str:
            result = subprocess.run([*git, *args], env=environment, capture_output=True, text=True, check=True)
            return result.stdout.strip()

        command("init", "--bare", "--template=")
        command("fetch", "--no-tags", str(bundle), "HEAD:refs/heads/candidate")
        command("fsck", "--full")
        if command("rev-parse", "refs/heads/candidate") != commit:
            raise ValueError("Git history and payload identify different commits")
        return int(command("rev-list", "--count", "refs/heads/candidate"))


def verify_wasm(inputs: dict[str, str], payload: dict[str, str]) -> None:
    for stem in ("ep_wasm", "markdown_basic", "markdown_simd"):
        matches = [digest for name, digest in payload.items()
                   if name.startswith(f"web/assets/{stem}-") and name.endswith(".wasm")]
        if len(matches) != 1 or matches[0] != inputs.get(f"{stem}.wasm"):
            raise ValueError(f"Bundled Wasm differs from the reported FsusUI input: {stem}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("release", type=Path)
    directory = parser.parse_args().release.resolve()
    try:
        outer = read_manifest(directory / "SHA256SUMS")
        if set(outer) != {PACKAGE, HISTORY}:
            raise ValueError("SHA256SUMS must identify the release archive and Git bundle")
        for name, digest in outer.items():
            with (directory / name).open("rb") as file:
                if file_sha256(file) != digest:
                    raise ValueError(f"Release checksum mismatch: {name}")
        payload = read_manifest(directory / "payload.sha256", "./")
        coordinates = verify_payload(directory / PACKAGE, payload)
        verify_wasm(read_manifest(directory / "fsusui-wasm.sha256"), payload)
        commits = verify_history(directory / HISTORY, coordinates["fsusblog_commit"])
    except (OSError, ValueError, tarfile.TarError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"{error}\n")
    print(json.dumps({"fsusblogCommit": coordinates["fsusblog_commit"], "fsusuiCommit": coordinates["fsusui_commit"],
                      "payloadFiles": len(payload), "gitCommits": commits}, indent=2))


if __name__ == "__main__":
    main()
