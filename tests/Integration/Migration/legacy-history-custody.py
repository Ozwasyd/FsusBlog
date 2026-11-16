#!/usr/bin/env python3
"""Mac-only owned synthetic prototype: independent V1 signer, read-only custody, restore and negative cases.

Run legacy-global-custody.py first, then pass its evidence directory as --baseline.
No old import-plan/admission/activation support is asserted by this experiment.
The two new rights records intentionally exercise cryptographic custody only; no
terminal outbox evidence is invented for them or accepted by this new command.
"""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
import resource
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("global_custody", HERE / "legacy-global-custody.py")
shared = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shared)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def signing_check(payload, key, signature, work, env):
    def decode(value):
        return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))

    def integer(value):
        value = value.lstrip(b"\0") or b"\0"
        if value[0] & 128:
            value = b"\0" + value
        return b"\x02" + bytes([len(value)]) + value

    raw = decode(signature)
    assert len(raw) == 64
    body = integer(raw[:32]) + integer(raw[32:])
    (work / "spki").write_bytes(decode(key["publicKey"]))
    (work / "payload").write_bytes(payload)
    (work / "signature").write_bytes(b"\x30" + bytes([len(body)]) + body)
    subprocess.run(["openssl", "pkey", "-pubin", "-inform", "DER", "-in", str(work / "spki"),
                    "-out", str(work / "public.pem")], env=env, check=True, capture_output=True)
    assert subprocess.check_output(["openssl", "dgst", "-sha256", "-verify", str(work / "public.pem"),
                                    "-signature", str(work / "signature"), str(work / "payload")], env=env).strip() == b"Verified OK"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, required=True)
    args = parser.parse_args()
    before = json.loads((args.baseline / "source-after.json").read_text())
    assert shared.source_state()["inputs"] == before["inputs"], "Rebuild: current source differs from the baseline's compiled source"
    baseline_run, = args.baseline.glob("global-native.*")
    assert (baseline_run / "run.txt").read_text().endswith("exit=0\n")
    dll = args.baseline / "build/bin/FsusBlogV2.Migrate/release/FsusBlogV2.Migrate.dll"
    assert f"{shared.digest(dll)}  {dll}" in (baseline_run / "run.txt").read_text()
    sdk = shutil.which(os.environ["DOTNET_BIN"])
    env = {"PATH": os.environ["PATH"], "HOME": str(Path.home()), "LC_ALL": "C", "TZ": "UTC",
           "PYTHONDONTWRITEBYTECODE": "1", "DOTNET_CLI_TELEMETRY_OPTOUT": "1", "DOTNET_NOLOGO": "1"}
    os.umask(0o077)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    work = Path(tempfile.mkdtemp(prefix="fsus-history-custody-", dir="/private/tmp")).resolve()
    print(f"History custody evidence: {work}", flush=True)
    (work / "provenance.json").write_text(json.dumps({"baseline": str(args.baseline), "source": before,
                                                     "migrateSha256": shared.digest(dll)}, indent=2))
    fixture = work / "fixture"
    fixture.mkdir()
    manifest = (shared.FIXTURE / "SHA256SUMS").read_bytes()
    assert sha(manifest) == shared.MANIFEST_SHA256
    for line in manifest.decode().splitlines():
        expected, name = line.split("  ", 1)
        assert Path(name).name == name
        data = (shared.FIXTURE / name).read_bytes()
        assert sha(data) == expected
        (fixture / name).write_bytes(data)
    program = (fixture / "Program.cs").read_text()
    program = shared.replace_once(program, "var rows = new List<object>();", "var rows = new List<object>();\nvar extraRights = new List<object>();")
    marker = '    File.WriteAllBytes($"payload-{input.Article}-{input.Rev}.bin", SiteIntegritySigningPayloadCanonicalizer.BuildPayloadBytes(payload));'
    program = shared.replace_once(program, marker, marker + '''
    if (input.Rev == 1 && input.Article is 42 or 43)
        extraRights.Add(AddCrossArticleRights(input.Article, input.Original, input.Rev, input.Id, input.Issued, input.Appended.AddTicks(10)));''')
    program = shared.replace_once(program, 'Save("rights.json", new[] { rightsRow });', 'extraRights.Add(rightsRow);\nSave("rights.json", extraRights);')
    (fixture / "Program.cs").write_text(program + "\n" + (HERE / "legacy-history-custody-fixture.cs").read_text())
    config = work / "NuGet.Config"
    config.write_text('<configuration><packageSources><clear /></packageSources><fallbackPackageFolders><clear /></fallbackPackageFolders></configuration>')
    with (work / "signer-build.log").open("w") as log:
        subprocess.run([sdk, "build", str(fixture / "fixture.csproj"), "-c", "Release", "--artifacts-path", str(work / "signer-build"),
                        "--disable-build-servers", "--configfile", str(config), "-p:NuGetAudit=false"], cwd=fixture, env=env,
                       stdout=log, stderr=subprocess.STDOUT, check=True, timeout=180)
    subprocess.run([sdk, str(work / "signer-build/bin/fixture/release/fixture.dll")], cwd=fixture, env=env, check=True)
    subprocess.run(["python3", str(fixture / "generate-sql.py")], cwd=fixture, env=env, check=True)
    keys = {key["keyId"]: key for key in json.loads((fixture / "keys.json").read_text())}
    # Golden signing bytes come only from frozen V1 source, never the new verifier.
    checks = 0
    for rights, filename in ((False, "proofs.json"), (True, "rights.json")):
        for row in json.loads((fixture / filename).read_text()):
            name = ("rights-payload.bin" if (row["article_id"], row["revision_no"]) == (42, 3)
                    else f'rights-payload-{row["article_id"]}-{row["revision_no"]}.bin') if rights else f'payload-{row["article_id"]}-{row["revision_no"]}.bin'
            signing_check((fixture / name).read_bytes(), keys[row["signing_key_id"]], row["signature"], work, env)
            checks += 1
    checkpoint, = json.loads((fixture / "checkpoints.json").read_text())
    signing_check((fixture / "checkpoint-payload.bin").read_bytes(), keys[checkpoint["signing_key_id"]], checkpoint["signature"], work, env)
    assert checks == 9
    (work / "independent-signatures.txt").write_text("6 publish + 3 rights + 1 checkpoint: OpenSSL Verified OK\n")
    scene = work / "scene"
    scene.mkdir()
    socket = scene / "socket"
    socket.mkdir()
    env.update(PGHOST=str(socket), PGPORT="54937", PGUSER="history_custody", PGPASSWORD="")
    source = f"fsusv2_import_{secrets.token_hex(12)}_source"
    restored = source + "_restore"

    def pg(database, sql=None, file=None):
        args = ["psql", "-X", "-qAt", "--no-password", "-v", "ON_ERROR_STOP=1", "-d", database]
        args += ["-c", sql] if sql is not None else ["-f", str(file)]
        return subprocess.check_output(args, env=env)

    def custody(database, name, allowed=True, **overrides):
        config = dict(env, FSUSBLOG_V1_DB=f"Host={socket};Port=54937;Username=history_custody;Database={database};Options=-c default_transaction_read_only=on",
                      FSUSBLOG_V1_SCHEMA="public", FSUSBLOG_LEGACY_V1_PROOF_KEY=str(fixture / "keys.json"),
                      FSUSBLOG_LEGACY_V1_PROOF_KEY_SHA256=shared.digest(fixture / "keys.json"),
                      FSUSBLOG_LEGACY_V1_CHECKPOINT_SHA256=checkpoint_sha)
        config.update(overrides)
        result = subprocess.run([sdk, str(dll), "legacy", "history", "custody", "postgres"], env=config, capture_output=True, timeout=20)
        (work / f"{name}.json").write_bytes(result.stdout)
        (work / f"{name}.log").write_bytes(result.stderr)
        assert result.returncode == (0 if allowed else 1), (name, result.returncode, result.stderr.decode())
        if not allowed:
            assert result.stderr.strip() == b"The history custody proof could not be verified."
        return json.loads(result.stdout) if allowed else None

    def dump(database):
        return subprocess.check_output(["pg_dump", "--no-password", "--format=plain", "--restrict-key=HistoryCustody",
                                        "--no-owner", "--no-privileges", "-d", database], env=env)

    started = False
    success = False
    try:
        with (work / "init.log").open("w") as log:
            subprocess.run(["initdb", "-D", str(scene / "data"), "-U", env["PGUSER"], "--auth-local=trust", "--auth-host=reject",
                            "--locale=C", "-E", "UTF8"], env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
        subprocess.run(["pg_ctl", "-D", str(scene / "data"), "-l", str(work / "postgres.log"), "-o",
                        f"-c listen_addresses='' -p 54937 -k {socket} -c unix_socket_permissions=0700", "-w", "-t", "20", "start"], env=env, check=True)
        started = True
        for database in (source, restored):
            pg("postgres", f"CREATE DATABASE {database} TEMPLATE template0")
        for sql in ("legacy-source-fixture.sql", "legacy-shared-rights-fixture.sql", "legacy-article-outbox-fixture.sql",
                    "legacy-republish-outbox-fixture.sql", "legacy-rollback-outbox-fixture.sql"):
            pg(source, file=HERE / sql)
        for sql in ("second-article.sql", "third-article.sql", "third-digests.sql", "rights-projection.sql", "global-proofs.sql"):
            pg(source, file=fixture / sql)
        pg(source, "UPDATE article_rights_snapshot SET proof_binding_enabled=true WHERE id=703")
        checkpoint_sha = sha(pg(source, "SELECT row_to_json(c) FROM integrity_merkle_checkpoint c").rstrip(b"\n"))
        first_dump = dump(source)
        first = custody(source, "original")
        assert first["custodyVerified"] and not any(first[k] for k in ("outboxVerified", "readyToApply", "readyToStage"))
        coords = {(r["coordinates"]["articleId"], r["coordinates"]["revisionNumber"]) for r in first["witnesses"]}
        assert coords == {(42, 1), (43, 1), (42, 3)}
        raw = {r["article_revision_id"]: (r, line) for line in pg(source, "SELECT row_to_json(r) FROM article_rights_proof r ORDER BY id").splitlines()
               for r in [json.loads(line)]}
        parents = {json.loads(line)["id"]: line for line in pg(source, "SELECT row_to_json(p) FROM article_publish_proof p ORDER BY id").splitlines()}
        logs = {json.loads(line)["id"]: line for line in pg(source, "SELECT row_to_json(l) FROM integrity_transparency_log l ORDER BY seq").splitlines()}
        original_rights = {row["id"]: row for row in json.loads((fixture / "rights.json").read_text())}
        rollback, = (item for item in first["witnesses"] if item["coordinates"]["revisionNumber"] == 3)
        assert rollback["coordinates"]["articleIssuedAt"] == "2026-10-01T00:00:00"
        assert rollback["coordinates"]["publishedAt"] == "2026-10-03T00:00:00"
        assert b"issuedAt:t:2026-10-01T00:00:00.0000000Z\n" in (fixture / "rights-payload.bin").read_bytes()
        for item in first["witnesses"]:
            c = item["coordinates"]
            row, line = raw[c["revisionId"]]
            name = "rights-payload.bin" if (c["articleId"], c["revisionNumber"]) == (42, 3) else f'rights-payload-{c["articleId"]}-{c["revisionNumber"]}.bin'
            assert item["signedPayloadSha256"] == shared.digest(fixture / name)
            assert item["sourceRowSha256"] == sha(line)
            assert c["rightsSnapshotId"] == row["article_rights_snapshot_id"]
            assert row["signature"] == original_rights[row["id"]]["signature"]
            assert row["signing_key_id"] == original_rights[row["id"]]["signing_key_id"]
            assert item["parentSourceRowSha256"] == sha(parents[row["publish_proof_id"]])
            assert item["logSourceRowSha256"] == sha(logs[row["transparency_log_entry_id"]])
        archive = work / "source-backup"
        archive.mkdir()
        with (work / "restored-source.json").open("w") as log:
            subprocess.run(["python3", str(HERE / "legacy-source-backup.py"), source, restored, str(archive)], env=env, stdout=log, check=True)
        restored_dump = dump(restored)
        second = custody(restored, "restored")
        assert first == second, "Proof bytes, exact signing input or relational witness changed after restore"
        assert dump(source) == first_dump and dump(restored) == restored_dump, "Read-only verification changed source data"
        custody(restored, "wrong-checkpoint", False, FSUSBLOG_LEGACY_V1_CHECKPOINT_SHA256="0" * 64)
        custody(restored, "wrong-key-pin", False, FSUSBLOG_LEGACY_V1_PROOF_KEY_SHA256="0" * 64)
        pg("postgres", f"CREATE DATABASE custody_unpublished TEMPLATE {restored}")
        pg("custody_unpublished", """
            INSERT INTO article_revision_content_block VALUES
                (400,encode(sha256(convert_to('Unpublished draft','UTF8')),'hex'),'Unpublished draft',
                 octet_length('Unpublished draft'),'2026-10-04');
            INSERT INTO article_revision SELECT (jsonb_populate_record(NULL::article_revision, to_jsonb(r) ||
                '{"id":5000000099,"revision_no":4,"title":"Unpublished edit","content_block_id":400,
                  "markdown_content":"","diff_summary":"draft edit","rollback_source_revision_id":null,
                  "rollback_reason":null,"created_at":"2026-10-04T00:00:00"}'::jsonb)).*
                FROM article_revision r WHERE id=5000000003;
            UPDATE article SET current_revision_id=5000000099,title='Unpublished edit',metadata_updated_at='2026-10-04' WHERE id=42;
            UPDATE article_body SET markdown_content='Unpublished draft',updated_at='2026-10-04' WHERE article_id=42;
            """)
        unpublished_before = dump("custody_unpublished")
        assert custody("custody_unpublished", "unpublished-edit") == first
        assert dump("custody_unpublished") == unpublished_before
        cases = {
            "wrong-current-pointer": "UPDATE article SET current_publication_id=900000001 WHERE id=42",
            "foreign-current-pointer": "UPDATE article SET current_publication_id=900000004 WHERE id=42",
            "gapped-numbering": "UPDATE article_publication SET publication_no=3 WHERE id=900000006",
            "missing-first-number": "UPDATE article_publication SET publication_no=2 WHERE id=900000004",
            "unbound-publication-coordinate": "UPDATE article_revision SET id=5000000044 WHERE id=5000000004; UPDATE article_publication SET article_revision_id=5000000044 WHERE id=900000004; UPDATE article_rights_snapshot SET article_revision_id=5000000044 WHERE id=703; UPDATE article SET current_revision_id=5000000044 WHERE id=43",
            "cross-parent": "UPDATE article_rights_proof SET publish_proof_id=125 WHERE id=201",
            "cross-snapshot": "UPDATE article_rights_proof SET article_rights_snapshot_id=703 WHERE id=201",
            "wrong-publication": "UPDATE article_publication SET article_id=43 WHERE id=900000001",
            "retired-boundary": "UPDATE article_rights_proof SET updated_at='2026-10-02' WHERE id=201",
            "missing-parent": "DELETE FROM article_publish_proof WHERE id=123",
            "duplicate-coordinate": "INSERT INTO article_rights_proof SELECT (jsonb_populate_record(NULL::article_rights_proof, to_jsonb(r) || '{\"id\":203,\"idempotency_key\":\"duplicate\"}'::jsonb)).* FROM article_rights_proof r WHERE id=201",
            "foreign-log": "UPDATE integrity_transparency_log SET article_id=43 WHERE proof_id=201 AND entry_type='article-rights-proof'",
        }
        for number, (name, sql) in enumerate(cases.items()):
            database = f"custody_negative_{number}"
            pg("postgres", f"CREATE DATABASE {database} TEMPLATE {restored}")
            pg(database, sql)
            custody(database, name, False)
        assert dump(restored) == restored_dump
        success = True
        (work / "result.json").write_text(json.dumps({"result": "passed", "rights": 3, "sameRevisionAcrossArticles": [42, 43],
            "independentOpenSslChecks": 10, "rejections": len(cases) + 2, "sourceUnchanged": True, "restoreWitnessEqual": True,
            "unpublishedEditDoesNotChangePublicationWitness": True, "admissionOrActivationSupport": False}, indent=2) + "\n")
    finally:
        if started:
            subprocess.run(["pg_ctl", "-D", str(scene / "data"), "-m", "fast", "-w", "-t", "15", "stop"], env=env, check=True)
            assert not (scene / "data/postmaster.pid").exists()
        if success:
            shutil.rmtree(scene)
        print(f"History custody {'PASS' if success else 'FAILED; stopped scene retained'}: {work}", flush=True)


if __name__ == "__main__":
    main()
