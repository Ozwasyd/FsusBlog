#!/usr/bin/env python3
"""Replay audited synthetic V1 custody against fresh current-checkout Release builds.

MacBook-only: uses /private/tmp. Run with DOTNET_BIN pointing at global.json's
SDK and PostgreSQL 18 tools on PATH.
No installs, remote package sources, frozen binaries, or pre-existing databases.
Evidence is retained in a printed temporary directory; the owned cluster is stopped.
This covers one rollback + one first publication + one republish, not multi-rollback.
"""

import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[3]
FIXTURE = ROOT / "artifacts/legacy-v1-mixed-global-custody/frozen-fixture"
MANIFEST_SHA256 = "faba65d31a56b559e01abc95b9bbfc070172706bfa3946b7757f76026b9b5fd0"


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def replace_once(text, old, new):
    require(text.count(old) == 1, f"Reviewed script boundary changed: {old!r}")
    return text.replace(old, new, 1)


def source_state():
    paths = subprocess.check_output(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z",
                                     "src", "Directory.Build.*", "Directory.Packages.props", "global.json",
                                     "NuGet.Config"], cwd=ROOT).decode().split("\0")
    inputs = {path: digest(ROOT / path) if (ROOT / path).is_file() else None for path in paths if path}
    # Server's native Markdown target also consumes the adjacent FsusUI sources.
    native = ROOT.parent / "FsusUI/vue/packages/wasm/markdown"
    for path in sorted([*native.glob("src/*.cpp"), *native.glob("src/*.hpp"), *native.glob("include/*.hpp")]):
        inputs[str(path)] = digest(path)
    return {"head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
            "status": subprocess.check_output(["git", "status", "--short"], cwd=ROOT, text=True), "inputs": inputs}


def main():
    os.umask(0o077)
    # Pin all frozen inputs, including both independent Python checkers and the
    # fully reviewed orchestration script. Never execute arbitrary artifact code.
    manifest = (FIXTURE / "SHA256SUMS").read_bytes()
    require(hashlib.sha256(manifest).hexdigest() == MANIFEST_SHA256, "Frozen manifest changed; review required")
    frozen = {}
    for line in manifest.decode().splitlines():
        expected, name = line.split("  ", 1)
        require(Path(name).name == name, "Frozen input must be a direct child")
        data = (FIXTURE / name).read_bytes()
        require(hashlib.sha256(data).hexdigest() == expected, f"Frozen input changed: {name}")
        frozen[name] = data

    sdk = shutil.which(os.environ.get("DOTNET_BIN", "dotnet"))
    require(sdk is not None, "Set DOTNET_BIN to the pinned SDK executable")
    for tool in ("initdb", "pg_ctl", "psql", "pg_dump", "pg_restore", "openssl", "rg", "curl"):
        require(shutil.which(tool), f"Missing preinstalled tool: {tool}")
    # Drop ambient service credentials, connection strings, proxy and shell hooks.
    env = {"PATH": os.environ["PATH"], "HOME": str(Path.home()), "LC_ALL": "C", "TZ": "UTC",
           "DOTNET_CLI_TELEMETRY_OPTOUT": "1", "DOTNET_NOLOGO": "1", "PYTHONDONTWRITEBYTECODE": "1"}
    expected_sdk = json.loads((ROOT / "global.json").read_text())["sdk"]["version"]
    observed_sdk = subprocess.check_output([sdk, "--version"], cwd=ROOT, env=env, text=True).strip()
    require(observed_sdk == expected_sdk, f"Expected SDK {expected_sdk}, got {observed_sdk}")
    pg_version = subprocess.check_output(["pg_dump", "--version"], env=env, text=True)
    require(" 18." in pg_version, "The frozen restore normalization requires PostgreSQL 18")
    work = Path(tempfile.mkdtemp(prefix="fsus-global-current-", dir="/private/tmp")).resolve()
    print(f"Current-checkout custody evidence: {work}", flush=True)
    fixture = work / "frozen-fixture"
    fixture.mkdir()
    for name, data in frozen.items():
        target = fixture / name
        target.write_bytes(data)
        target.chmod(0o400)
    build = work / "build"
    config = work / "NuGet.Config"
    config.write_text('<configuration><packageSources><clear /></packageSources>'
                      '<fallbackPackageFolders><clear /></fallbackPackageFolders></configuration>\n')
    before = source_state()
    (work / "source-before.json").write_text(json.dumps(before, indent=2) + "\n")
    with (work / "build.log").open("w") as log:
        for project in ("Migrate/FsusBlogV2.Migrate", "Server/FsusBlog.V2.Server"):
            subprocess.run([sdk, "build", str(ROOT / "src" / f"{project}.csproj"), "-c", "Release",
                            "--artifacts-path", str(build), "--disable-build-servers", "--configfile", str(config),
                            "-p:RestoreLockedMode=true", "-p:NuGetAudit=false"],
                           cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=180)
    after = source_state()
    (work / "source-after.json").write_text(json.dumps(after, indent=2) + "\n")
    require(before["inputs"] == after["inputs"], "Source inputs changed during compilation; rerun")
    migrate = build / "bin/FsusBlogV2.Migrate/release/FsusBlogV2.Migrate.dll"
    server = build / "bin/FsusBlog.V2.Server/release/FsusBlog.V2.Server.dll"
    require(migrate.is_file() and server.is_file(), "Fresh Release binaries missing")
    (work / "checkout-status.txt").write_bytes(subprocess.check_output(["git", "status", "--short"], cwd=ROOT))
    web = work / "web"
    web.mkdir()
    (web / "index.html").write_text('<!doctype html><html><head></head><body><!--fsus-public-content--></body></html>\n')

    original = frozen["rehearse-global.sh"].decode()
    # Discard only the old machine-specific bootstrap; the digest-pinned body is
    # reused unchanged except explicit paths and the additional retained-edge check.
    _, body = original.split('mkdir -p "$root"\n', 1)
    values = {"fixture_root": fixture, "root": work, "DOTNET_BIN": sdk,
              "FSUSBLOG_MIGRATE_DLL": migrate, "server": server, "web": web}
    header = "#!/usr/bin/env bash\nset -euo pipefail\numask 077\nulimit -c 0\n"
    header += f"cd {shlex.quote(str(ROOT))}\n"
    header += "".join(f"export {key}={shlex.quote(str(value))}\n" for key, value in values.items())
    body = body.replace("$base/fixture", "$fixture_root")
    # Capture source edge objects and compare every retained field after restore,
    # rather than treating the source's 56-row count as proof of runtime retention.
    body = replace_once(body, "boot fsusv2_import_global_stage\n", '''psql_db "$restored_source" -Atc 'SELECT row_to_json(e) FROM article_mutation_outbox_edge e ORDER BY id' > "$evidence/source-edges.jsonl"
boot fsusv2_import_global_stage
''')
    body = replace_once(body, 'python3 "$fixture_root/check-custody.py" "$evidence"\n', '''python3 "$fixture_root/check-custody.py" "$evidence"
psql_db global_restore -Atc "SELECT edge FROM legacy_release_origin o CROSS JOIN LATERAL jsonb_array_elements(coalesce(o.evidence->'edges','[]'::jsonb) || coalesce(o.evidence->'rightsProjection'->'edges','[]'::jsonb)) edge ORDER BY (edge->>'id')::bigint" > "$evidence/runtime-edges.jsonl"
python3 - "$evidence" <<'EDGES'
import json, sys
from datetime import datetime
from pathlib import Path
root = Path(sys.argv[1])
source, retained = ([json.loads(line) for line in (root/name).read_text().splitlines()]
                    for name in ("source-edges.jsonl", "runtime-edges.jsonl"))
assert len(source) == len(retained) == 56
# PostgreSQL row_to_json omits zero fractions; the sealed projection renders
# the same timestamp with seven fractional digits. Compare that exact spelling.
for row in source:
    row["updated_at"] = datetime.fromisoformat(row["updated_at"]).isoformat(timespec="microseconds") + "0"
assert source == retained
assert all(row["status"] == "completed" for row in retained)
print("All 56 original completed deliveries retain every source field after restore.")
EDGES
''')
    require("$base" not in body and "worktree" not in body, "Unresolved historical path")
    script = work / "replay.sh"
    script.write_text(header + body)
    subprocess.run(["bash", "-n", str(script)], check=True)
    with (work / "replay.log").open("w") as log:
        subprocess.run(["bash", str(script)], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
    print(f"PASS: current-checkout custody, 56 retained deliveries, independent signatures and sparse proofs. Evidence: {work}")


if __name__ == "__main__":
    main()
