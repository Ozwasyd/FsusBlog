import errno, hashlib, http.client, json, os, pathlib, random, select, socket, subprocess, time, uuid, tempfile, shutil

FIXTURES = pathlib.Path(__file__).resolve().parent
REPO = FIXTURES.parents[3]
ROOT = pathlib.Path(os.environ.get('FSUSBLOG_NATIVE_LISTENER_EVIDENCE', tempfile.mkdtemp(prefix='fsus-native-listener-')))
DOTNET = os.environ.get('FSUSBLOG_NATIVE_LISTENER_DOTNET', 'dotnet')
FRONTEND = pathlib.Path(os.environ.get('FSUSBLOG_NATIVE_LISTENER_FRONTEND', str(REPO/'src/frontend')))
ROOT.mkdir(parents=True, exist_ok=True)
(ROOT/'site/dist').mkdir(parents=True, exist_ok=True)
(ROOT/'site/package.json').write_text('{}')
if not (ROOT/'site/node_modules').exists(): (ROOT/'site/node_modules').symlink_to(FRONTEND/'node_modules', target_is_directory=True)
(ROOT/'kestrel').mkdir(exist_ok=True)
shutil.copyfile(FIXTURES/'Program.cs', ROOT/'kestrel/Program.cs')
(ROOT/'kestrel/Prototype.csproj').write_text('<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net10.0</TargetFramework><Nullable>enable</Nullable><ImplicitUsings>enable</ImplicitUsings></PropertyGroup><ItemGroup><Compile Include="'+str(REPO/'src/backend/Infrastructure/Bootstrap/FsusManagedTestListener.cs')+'" Link="FsusManagedTestListener.cs" /></ItemGroup></Project>')
BUILD_ENV = dict(os.environ, DOTNET_CLI_HOME=str(ROOT/'dotnet-home'), DOTNET_CLI_TELEMETRY_OPTOUT='1')
with open(ROOT/'build.log','w') as build_log:
    build = subprocess.run([DOTNET,'build','-c','Release','--nologo'], cwd=ROOT/'kestrel', env=BUILD_ENV, stdout=build_log, stderr=subprocess.STDOUT)
assert build.returncode == 0, 'Kestrel adapter fixture build failed; see '+str(ROOT/'build.log')
VITE = json.loads((FRONTEND/'node_modules/vite/package.json').read_text())['version']
assert VITE == '8.0.16', 'Requalify Vite adapter against changed locked version'

RESULTS = []
class Child:
    def __init__(self, role, v4, port, token, stage=''):
        self.buffer = b''
        self.fd = v4.fileno()
        self.log = open(ROOT / f'{token}.stderr.log', 'wb')
        env = dict(os.environ, RESERVED_FD=str(v4.fileno()), RESERVED_PORT=str(port),
                   RESERVED_INODE=os.readlink(f'/proc/self/fd/{v4.fileno()}'), ROLE=role,
                   FAIL_STAGE=stage, CANARY=token, FSUSBLOG_ADAPTER_REPO=str(REPO), FSUSBLOG_ADAPTER_SITE=str(ROOT/'site'))
        env.update(FSUSBLOG_MANAGED_TEST_LISTENER='1', FSUSBLOG_RUNTIME_LISTEN_FD=str(v4.fileno()),
                   FSUSBLOG_RUNTIME_LISTEN_SOCKET=env['RESERVED_INODE'], FSUSBLOG_RUNTIME_LISTEN_PORT=str(port),
                   FSUSBLOG_RUNTIME_PORT_LEASE_ID=token, FSUSBLOG_RUNTIME_LISTEN_ATTEMPT_ID=token,
                   FSUSBLOG_TEST_RUN_ID=token, FSUSBLOG_TEST_NAMESPACE=token, ASPNETCORE_URLS=f'http://127.0.0.1:{port}')
        missing = {'missing-flag':'FSUSBLOG_MANAGED_TEST_LISTENER', 'missing-run':'FSUSBLOG_TEST_RUN_ID',
                   'missing-namespace':'FSUSBLOG_TEST_NAMESPACE', 'missing-lease':'FSUSBLOG_RUNTIME_PORT_LEASE_ID',
                   'missing-attempt':'FSUSBLOG_RUNTIME_LISTEN_ATTEMPT_ID'}
        if stage in missing: env.pop(missing[stage])
        if stage == 'aliases-only':
            env.pop('FSUSBLOG_TEST_RUN_ID'); env.pop('FSUSBLOG_TEST_NAMESPACE')
            env.update(FSUS_TEST_RUN_ID=token, TEST_NAMESPACE=token)
        if stage == 'wrong-inode': env['FSUSBLOG_RUNTIME_LISTEN_SOCKET'] = 'socket:[1]'
        if stage == 'wrong-port': env['FSUSBLOG_RUNTIME_LISTEN_PORT'] = str(port+1)
        if stage == 'invalid-fd': env['FSUSBLOG_RUNTIME_LISTEN_FD'] = '99999'
        if stage == 'wrong-url': env['ASPNETCORE_URLS'] = f'http://127.0.0.1:{port+1}'
        if stage == 'extra-endpoint': env['Kestrel__Endpoints__Other__Url'] = f'http://127.0.0.1:{port+1}'
        command = ['node', str(FIXTURES / 'vite-child.mjs')] if role.startswith('vite') else [
            DOTNET, str(ROOT / 'kestrel/bin/Release/net10.0/Prototype.dll')]
        self.p = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=self.log, pass_fds=(v4.fileno(),), env=env)
        self.command = command
    def event(self):
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if b'\n' in self.buffer:
                line, self.buffer = self.buffer.split(b'\n', 1)
                try: return json.loads(line)
                except json.JSONDecodeError: continue
            if select.select([self.p.stdout], [], [], min(1, deadline-time.monotonic()))[0]:
                data = os.read(self.p.stdout.fileno(), 65536)
                if not data: raise RuntimeError(f'child exited {self.p.poll()} before event')
                self.buffer += data
        raise RuntimeError('child event deadline exceeded')
    def activate(self):
        self.p.stdin.write(b'activate\n'); self.p.stdin.flush()
    def stop(self):
        if self.p.poll() is None:
            self.p.terminate()
            try: self.p.wait(timeout=8)
            except subprocess.TimeoutExpired: self.p.kill(); self.p.wait(timeout=3)
        self.log.close()
        self.p.stdin.close(); self.p.stdout.close()
        return self.p.returncode

def reserve():
    for attempt in range(100):
        port = random.SystemRandom().randrange(41000, 61000)
        v4, v6 = socket.socket(socket.AF_INET), socket.socket(socket.AF_INET6)
        try:
            v6.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
            v4.bind(('127.0.0.1', port)); v6.bind(('::1', port))
            assert v4.getsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR) == 0
            return v4, v6, port
        except OSError:
            v4.close(); v6.close()
    raise RuntimeError('no candidate reserved')

def competitors(port, held=True):
    result = {}
    for family, host, label in [(socket.AF_INET, '127.0.0.1', 'v4'), (socket.AF_INET6, '::1', 'v6')]:
        with socket.socket(family) as contender:
            contender.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            if family == socket.AF_INET6: contender.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
            try:
                contender.bind((host, port)); contender.listen()
                result[label] = 'bound'
            except OSError as error:
                result[label] = errno.errorcode.get(error.errno, str(error.errno))
    expected = {'v4': 'EADDRINUSE', 'v6': 'EADDRINUSE'} if held else {'v4': 'bound', 'v6': 'bound'}
    assert result == expected, (port, held, result)
    return result

def one(role, scenario, repeat):
    v4, v6, port = reserve()
    inode = os.readlink(f'/proc/self/fd/{v4.fileno()}')
    token = f'{role}-{scenario}-{repeat}-{uuid.uuid4().hex}'
    html = f'<!doctype html><html><body>{token}</body></html>\n'
    (ROOT / 'site/index.html').write_text(html)
    (ROOT / 'site/dist/index.html').write_text(html)
    child = None
    entry = dict(role=role, scenario=scenario, repeat=repeat, port=port, reservedInode=inode, canary=token)
    try:
        entry['beforeSpawnCompetitors'] = competitors(port)
        child = Child(role, v4, port, token, scenario if scenario in ('before','after') else '')
        prepared = child.event()
        assert prepared['event'] == 'prepared' and prepared['inode'] == inode
        assert os.readlink(f'/proc/{child.p.pid}/fd/{v4.fileno()}') == inode
        entry['prepared'] = prepared
        entry['preparedCompetitors'] = competitors(port)
        if scenario == 'cancel':
            entry['childExit'] = child.stop()
            entry['afterCancelledChildCompetitors'] = competitors(port)
        else:
            child.activate()
            if scenario == 'before':
                child.p.wait(timeout=20)
                assert child.p.returncode != 0
                entry['childExit'] = child.p.returncode
                entry['afterFailedChildCompetitors'] = competitors(port)
            else:
                listening = child.event()
                assert listening['event'] == 'listening' and listening['inode'] == inode
                entry['listening'] = listening
                entry['afterActivationCompetitors'] = competitors(port)
                if scenario == 'after':
                    child.p.wait(timeout=20); assert child.p.returncode == 42
                    entry['childExit'] = child.p.returncode
                    entry['afterFailedChildCompetitors'] = competitors(port)
                else:
                    # Drop the reservation-owner duplicate only AFTER application listening proof.
                    v4.close()
                    assert os.readlink(f'/proc/{child.p.pid}/fd/{child.fd}') == inode
                    entry['afterParentDuplicateCloseCompetitors'] = competitors(port)
                    path = '/canary' if role == 'kestrel' else '/'
                    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
                    try:
                        connection.request('GET', path)
                        response = connection.getresponse()
                        body = response.read(); assert response.status == 200 and token.encode() in body
                        if role == 'vite-preview': assert body == html.encode()
                        entry['canaryStatus'] = response.status
                        entry['canaryBodyDigest'] = hashlib.sha256(body).hexdigest()
                    finally: connection.close()
                    # Observe client FIN completion before shutting down the listener, avoiding
                    # server-side TIME_WAIT being confused with a leaked listening reservation.
                    deadline = time.monotonic() + 5
                    while True:
                        rows = pathlib.Path('/proc/net/tcp').read_text().splitlines()[1:]
                        live = [row for row in rows if row.split()[1].endswith(f':{port:04X}') and row.split()[3] != '0A']
                        if not live: break
                        if time.monotonic() >= deadline: raise RuntimeError(f'canary connection did not drain: {live}')
                        select.select([], [], [], 0.01)
                    entry['childExit'] = child.stop()
        assert child.p.poll() is not None
    finally:
        if child: child.stop()
        v4.close(); v6.close()
    entry['afterCleanupCompetitors'] = competitors(port, False)
    entry['passed'] = True
    RESULTS.append(entry)

def partial_failure():
    reservations = [reserve() for _ in range(3)]
    children = []
    entry = {'scenario': 'partial-group-failure', 'ports': [r[2] for r in reservations]}
    try:
        for index, (v4, v6, port) in enumerate(reservations):
            token = 'partial-' + uuid.uuid4().hex
            child = Child('kestrel', v4, port, token, 'before' if index == 1 else '')
            children.append(child); child.event()
            if index == 0: child.activate(); child.event()
            if index == 1:
                child.activate(); child.p.wait(timeout=20); assert child.p.returncode != 0
                break
        entry['failureWhileAllReservationsHeld'] = [competitors(r[2]) for r in reservations]
    finally:
        entry['childExits'] = [child.stop() for child in children]
        for v4, v6, port in reservations: v4.close(); v6.close()
    entry['afterRollbackCompetitors'] = [competitors(r[2], False) for r in reservations]
    entry['passed'] = True; RESULTS.append(entry)

def admission_negative(role, stage):
    v4, v6, port = reserve()
    child = None
    entry = {'role': role, 'scenario': stage, 'port': port}
    try:
        child = Child(role, v4, port, 'guard-'+uuid.uuid4().hex, stage)
        child.event(); child.activate(); child.p.wait(timeout=20)
        assert child.p.returncode != 0, f'{role} admitted {stage}'
        entry['childExit'] = child.p.returncode
        entry['reservationStillHeld'] = competitors(port)
    finally:
        if child: child.stop()
        v4.close(); v6.close()
    entry['afterCleanupCompetitors'] = competitors(port, False)
    entry['passed'] = True; RESULTS.append(entry)

try:
    for role in ['vite-dev', 'vite-preview', 'kestrel']:
        for repeat in [1, 2]:
            for scenario in ['success', 'cancel', 'before', 'after']:
                one(role, scenario, repeat)
    partial_failure()
    for role in ['vite-dev', 'vite-preview', 'kestrel']:
        for stage in ['missing-flag','missing-run','missing-namespace','missing-lease','missing-attempt','wrong-inode','wrong-port','invalid-fd','aliases-only']:
            admission_negative(role, stage)
    for stage in ['wrong-url','extra-endpoint']:
        admission_negative('kestrel', stage)
    report = {'passed': True, 'node': subprocess.check_output(['node','--version'], text=True).strip(),
              'dotnet': subprocess.check_output([DOTNET,'--version'], text=True).strip(),
              'vite': VITE, 'cases': RESULTS, 'testedCommit': subprocess.check_output(['git','rev-parse','HEAD'],cwd=REPO,text=True).strip(),
              'limits': ['isolated native adapters only; no FsusBlog AEDS, candidate, image, lease qualification',
                         'v6 stays an exclusive nonlistening guard, matching existing canonical loopback reservation',
                         'per-case inode continuity at prepared/activation/parent-duplicate-close; no release/rebind path',
                         'fresh Vite dev and preview startup verified; Vite restart is deliberately unsupported by one-adoption contract']}
except BaseException as error:
    report = {'passed': False, 'error': repr(error), 'cases': RESULTS}
    raise
finally:
    (ROOT / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'passed': report['passed'], 'caseCount': len(RESULTS), 'report': str(ROOT/'report.json')}))
