"""Bounded diagnostic only: real PostgreSQL + independent published-store processes."""
import json
import hashlib
import os
from pathlib import Path
import re
import select
import shutil
import socket
import sys
import subprocess
import time
import uuid

if set(sys.argv[1:]) - {'--preflight-only', '--after-insert-only'} or len(sys.argv) > 2:
    raise SystemExit('Use no arguments, --preflight-only or --after-insert-only.')

ROOT = Path(__file__).resolve().parent
SOURCE = Path(os.environ['VAULT_CRASH_REPLAY_OPERATION_SOURCE']).resolve()
EXPECTED_SOURCE = '8dca9343f1a8a88a4e8f266750e7844d0186335d'
DOTNET = shutil.which('dotnet') or '/workspace/.setup/dotnet/dotnet'
DLL = str(ROOT / 'bin/Debug/net10.0/VaultCrashReplay.dll')
NAME = 'vault-crash-replay-qa-' + uuid.uuid4().hex[:10]
PASSWORD = uuid.uuid4().hex
with socket.socket() as probe:
    probe.bind(('127.0.0.1', 0))
    PORT = str(probe.getsockname()[1])
records = []
EVIDENCE = ROOT / 'evidence' / 'runs' / NAME


def shell(arguments, **kwargs):
    return subprocess.run(arguments, text=True, capture_output=True, check=True, **kwargs).stdout.strip()


def sql(database, statement):
    return shell(['docker', 'exec', '-i', NAME, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database, '-At'], input=statement)


def connection(database, user='postgres'):
    return f'Host=127.0.0.1;Port={PORT};Database={database};Username={user};Password={PASSWORD};Application Name=vault-crash-replay-qa'


def worker(action, database, expected=0, user='postgres'):
    result = subprocess.run([DOTNET, DLL, action, connection(database, user)], text=True, capture_output=True)
    record = dict(action=action, database=database, exit=result.returncode, stdout=result.stdout.strip(), stderr=result.stderr.strip())
    records.append(record)
    print(json.dumps(record), flush=True)
    assert result.returncode == expected, record
    return json.loads(result.stdout)


def database(name):
    sql('postgres', f'CREATE DATABASE {name};')
    for filename in ('ArticleVaultOperationMigrationDefinitions.cs', 'ArticleVaultExecutionMigrationDefinitions.cs'):
        source = (SOURCE / 'src/migration/Definitions' / filename).read_text()
        block = re.search(r'new RawSqlStep\("""\s*(.*?)\s*"""\)', source, re.S).group(1)
        sql(name, 'BEGIN;\n' + block + '\nCOMMIT;')


def case(name, run):
    run()
    print(json.dumps(dict(case=name, status='passed')), flush=True)
    records.append(dict(case=name, status='passed'))


def committed_kill():
    database('committed')
    process = subprocess.Popen([DOTNET, DLL, 'planned', connection('committed'), 'hold'], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert select.select([process.stdout], [], [], 15)[0], 'worker did not signal durable commit'
    line = process.stdout.readline().strip()
    assert json.loads(line)['status'] == 'committed', line
    process.kill()
    assert process.wait(timeout=10) == -9
    records.append(dict(case='commit-then-SIGKILL', pid=process.pid, exit=-9, observed=line))
    assert worker('read-planned', 'committed')['count'] == 1
    worker('planned', 'committed')
    assert sql('committed', 'SELECT count(*) FROM article_vault_operation_checkpoint;') == '1'
    shell(['docker', 'kill', '--signal=KILL', NAME])
    shell(['docker', 'start', NAME])
    ready()
    assert worker('read-planned', 'committed')['baseUnchanged']
    records.append(dict(case='postgres-SIGKILL-restart', status='passed'))


def interrupted_append(after_insert=False):
    database('interrupted')
    worker('planned', 'interrupted')
    timing = 'AFTER' if after_insert else 'BEFORE'
    sql('interrupted', f'''CREATE FUNCTION qa_delay_append() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(30); RETURN NEW; END; $$;
        CREATE TRIGGER qa_delay {timing} INSERT ON article_vault_operation_checkpoint FOR EACH ROW EXECUTE FUNCTION qa_delay_append();''')
    process = subprocess.Popen([DOTNET, DLL, 'validating', connection('interrupted')], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    for _ in range(150):
        if sql('interrupted', "SELECT count(*) FROM pg_stat_activity WHERE application_name='vault-crash-replay-qa' AND wait_event='PgSleep';") == '1':
            break
        if process.poll() is not None:
            raise AssertionError(process.communicate())
        time.sleep(0.05)
    else:
        process.kill()
        raise AssertionError('no real PostgreSQL in-transaction delay observed')
    process.kill()
    assert process.wait(timeout=10) == -9
    sql('interrupted', 'DROP TRIGGER qa_delay ON article_vault_operation_checkpoint; DROP FUNCTION qa_delay_append();')
    assert sql('interrupted', 'SELECT count(*) FROM article_vault_operation_checkpoint;') == '1'
    worker('read-planned', 'interrupted')
    worker('validating', 'interrupted')
    assert worker('read-validating', 'interrupted')['count'] == 2
    records.append(dict(case='uncommitted-append-SIGKILL', triggerTiming=timing, pid=process.pid, exit=-9, persistedRowsBeforeReplay=1))


def independent_competitors(actions, name):
    processes = [subprocess.Popen([DOTNET, DLL, action, connection(name)], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE) for action in actions]
    results = []
    for process in processes:
        stdout, stderr = process.communicate(timeout=20)
        results.append(process.returncode)
        records.append(dict(case='independent-process-race', database=name, pid=process.pid, exit=process.returncode, stdout=stdout.strip(), stderr=stderr.strip()))
    return results


def duplicate_race():
    database('duplicate')
    assert independent_competitors(['planned', 'planned', 'planned', 'planned'], 'duplicate') == [0] * 4
    assert sql('duplicate', 'SELECT count(*) FROM article_vault_operation_identity;') == '1'
    assert sql('duplicate', 'SELECT count(*) FROM article_vault_operation_checkpoint;') == '1'
    worker('identity-conflict', 'duplicate', 20)
    worker('stale-plan', 'duplicate', 20)
    assert worker('read-planned', 'duplicate')['count'] == 1


def cancel_race():
    database('race')
    worker('planned', 'race')
    worker('validating', 'race')
    assert sorted(independent_competitors(['executing', 'cancel'], 'race')) == [0, 20]
    state = sql('race', "SELECT checkpoint_json::json->>'state' FROM article_vault_operation_checkpoint WHERE sequence=2;")
    assert state in ('executing-server', 'cancelled'), state
    assert sql('race', 'SELECT count(*) FROM article_vault_operation_checkpoint;') == '3'


def unknown_result():
    database('unknown_result')
    for stage in ('planned', 'validating', 'executing'):
        worker(stage, 'unknown_result')
    worker('unsafe-cancel', 'unknown_result', 20)
    rejected = worker('missing-server-result', 'unknown_result', 20)
    assert rejected['reason'] == 'article_vault_operation_plan_receipt_missing', rejected
    worker('recovery', 'unknown_result')
    read = worker('read-recovery', 'unknown_result')
    assert read['count'] == 4 and read['baseUnchanged']


def permissions():
    database('permission_failure')
    worker('planned', 'permission_failure')
    sql('permission_failure', f"CREATE ROLE qa_writer LOGIN PASSWORD '{PASSWORD}'; GRANT CONNECT ON DATABASE permission_failure TO qa_writer; GRANT USAGE ON SCHEMA public TO qa_writer; GRANT SELECT,INSERT,UPDATE ON article_vault_operation_identity TO qa_writer; GRANT SELECT ON article_vault_operation_checkpoint TO qa_writer;")
    denied = worker('validating', 'permission_failure', 20, 'qa_writer')
    assert denied['sqlState'] == '42501', denied
    assert worker('read-planned', 'permission_failure')['count'] == 1
    worker('validating', 'permission_failure')
    worker('expired-executing', 'permission_failure', 20)
    assert worker('read-validating', 'permission_failure')['count'] == 2


def ready():
    for _ in range(100):
        result = subprocess.run(['docker', 'exec', NAME, 'pg_isready', '-U', 'postgres'], capture_output=True)
        if result.returncode == 0:
            return
        time.sleep(0.1)
    raise AssertionError('isolated PostgreSQL did not become ready')


assert shell(['git', '-C', str(SOURCE), 'rev-parse', 'HEAD']) == EXPECTED_SOURCE
assert not shell(['git', '-C', str(SOURCE), 'status', '--porcelain']), 'published source worktree is dirty'
if '--preflight-only' in sys.argv:
    print('exact published source binding verified')
    sys.exit(0)
for assembly, project in [('FsusBlog.Server.dll', 'backend'), ('FsusBlog.Shared.dll', 'shared')]:
    published = SOURCE / 'src' / project / 'bin/Debug/net10.0' / assembly
    copied = ROOT / 'bin/Debug/net10.0' / assembly
    assert hashlib.sha256(published.read_bytes()).digest() == hashlib.sha256(copied.read_bytes()).digest(), 'worker assembly does not match the source build'
EVIDENCE.mkdir(parents=True)

try:
    shell(['docker', 'run', '-d', '--name', NAME, '-e', 'POSTGRES_PASSWORD=' + PASSWORD, '-p', '127.0.0.1:' + PORT + ':5432', 'postgres:17-alpine'])
    ready()
    records.append(dict(host=NAME, port=PORT, version=sql('postgres', 'SHOW server_version;'), systemIdentifier=sql('postgres', 'SELECT system_identifier FROM pg_control_system();')))
    if '--after-insert-only' in sys.argv:
        case('uncommitted-append-after-insert-rollback-and-replay', lambda: interrupted_append(True))
    else:
        case('committed-process-and-postgres-crash-restart', committed_kill)
        case('uncommitted-append-rollback-and-replay', interrupted_append)
        case('independent-process-duplicate-idempotency', duplicate_race)
        case('competing-execute-cancel', cancel_race)
        case('unknown-outcome-cannot-cancel-or-claim-accepted', unknown_result)
        case('writer-permission-failure-and-restart-expiry', permissions)
finally:
    subprocess.run(['docker', 'rm', '-fv', NAME], capture_output=True)
    (EVIDENCE / 'process-traces.json').write_text(json.dumps(records, indent=4) + '\n')
    print(str(EVIDENCE / 'process-traces.json'), flush=True)
