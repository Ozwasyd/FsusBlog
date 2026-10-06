"""Task-owned kernel controls only; no systemd grant, managed runtime or DB is started."""
import array
import ast
import fcntl
import hashlib
import json
import os
from pathlib import Path
import select
import shutil
import signal
import socket
import stat
import sys
import tempfile
import time
import types
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'tools/test/physical-execution-linux-preexec.py'
BROKER = ROOT / 'tools/test/physical-execution-nested-socket.py'
helper = types.ModuleType('original_preexec_under_test')
exec(compile(SOURCE.read_bytes(), str(SOURCE), 'exec'), helper.__dict__)


def expected_file(file, role, descriptor):
    metadata = os.stat(file)
    parents = []
    current = Path(file).parent
    while True:
        parents.insert(0, helper.native_directory(current.stat()))
        if current == current.parent:
            break
        current = current.parent
    epoch = {'path': str(file), 'leaf': helper.native_leaf(metadata), 'ancestors': parents}
    return {'role': role, 'targetDescriptor': descriptor, 'path': str(file),
            'artifactSha256': hashlib.sha256(file.read_bytes()).hexdigest(),
            'epochSha256': hashlib.sha256(helper.native_epoch_bytes(epoch)).hexdigest()}


def read_line(descriptor, timeout=5):
    deadline = time.monotonic() + timeout
    data = bytearray()
    while time.monotonic() < deadline:
        if not select.select([descriptor], [], [], max(0, deadline-time.monotonic()))[0]:
            break
        value = os.read(descriptor, 1)
        if not value:
            raise RuntimeError('owned child closed its output: '+data.decode(errors='replace'))
        if value == b'\n':
            return json.loads(data)
        data += value
        if len(data) > 262144:
            raise RuntimeError('owned child output exceeds bound')
    raise RuntimeError('owned child output deadline exceeded')


def wait_child(pid):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        result, status = os.waitpid(pid, os.WNOHANG)
        if result:
            return os.waitstatus_to_exitcode(status)
        time.sleep(.01)
    os.kill(pid, signal.SIGKILL)
    os.waitpid(pid, 0)
    raise RuntimeError('owned child did not terminate')


class KernelInputs(unittest.TestCase):
    def setUp(self):
        directory = ROOT / '.tmp/native-input-syscall-controls'
        directory.mkdir(parents=True, exist_ok=True)
        self.base = Path(tempfile.mkdtemp(prefix='owned-', dir=directory))
        self.base.chmod(0o700)
        self.attempt = self.base / 'attempt-1'
        self.attempt.mkdir(mode=0o700)
        for name in ('inputs', 'published'):
            (self.attempt/name).mkdir(mode=0o700)
        self.files = [self.attempt/'inputs/primary.env', self.attempt/'published/current-schema-receipt.bin']
        for file, data in zip(self.files, (b'ConnectionStrings__Default=owned\n', b'owned-binary-receipt\x00')):
            file.write_bytes(data)
            file.chmod(0o600)
        self.expected = [expected_file(file, *role) for file, role in zip(self.files, helper.NATIVE_ROLES)]
        self.fds = [os.open(file, os.O_RDONLY|os.O_CLOEXEC) for file in self.files]
        self.children = set()

    def tearDown(self):
        for pid in self.children:
            try:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
            except ProcessLookupError:
                pass
            except ChildProcessError:
                pass
        for descriptor in self.fds:
            os.close(descriptor)
        shutil.rmtree(self.base)

    def test_shared_epoch_vectors(self):
        fixture = json.loads((ROOT/'tests/tools/fixtures/original-native-file-epoch-v1.json').read_text())
        leaf_fields = ("deviceMajor","deviceMinor","inode","mode","links","uid","gid","size",
                       "modifiedSeconds","modifiedNanoseconds","changedSeconds","changedNanoseconds")
        directory_fields = ("deviceMajor","deviceMinor","inode","mode")
        for vector in fixture:
            observation = {'path':vector['path'],'leaf':dict(zip(leaf_fields,vector['leaf'])),
                           'ancestors':[dict(zip(directory_fields,row)) for row in vector['ancestors']]}
            actual = helper.native_epoch_bytes(observation)
            self.assertEqual(actual.decode(), vector['canonical'])
            self.assertEqual(hashlib.sha256(actual).hexdigest(), vector['sha256'])

    def test_pread_preserves_offset_and_rejects_changed_bytes(self):
        os.lseek(self.fds[0], 7, os.SEEK_SET)
        observed = helper.observe_native_input(self.fds[0], str(self.files[0]), self.expected[0])
        self.assertEqual(observed['epochSha256'], self.expected[0]['epochSha256'])
        self.assertEqual(os.lseek(self.fds[0], 0, os.SEEK_CUR), 7)
        self.files[0].write_bytes(b'changed byte configuration\n')
        with self.assertRaisesRegex(RuntimeError, 'epoch expectation differs'):
            helper.observe_native_input(self.fds[0], str(self.files[0]), self.expected[0])

    def test_readonly_path_hardlink_policy(self):
        for flags in (os.O_WRONLY, os.O_RDWR, os.O_PATH):
            descriptor = os.open(self.files[0], flags|os.O_CLOEXEC)
            try:
                with self.assertRaisesRegex(RuntimeError, 'RO regular FD'):
                    helper.observe_native_input(descriptor, str(self.files[0]), self.expected[0])
            finally:
                os.close(descriptor)
        os.link(self.files[0], self.attempt/'inputs/alias')
        with self.assertRaisesRegex(RuntimeError, 'RO regular FD'):
            helper.observe_native_input(self.fds[0], str(self.files[0]), self.expected[0])

    def receive_in_child(self, descriptors, payload, expected, oversized=False):
        left, right = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        read_result, write_result = os.pipe()
        pid = os.fork()
        if pid == 0:
            try:
                left.close()
                high_socket = fcntl.fcntl(right.fileno(), fcntl.F_DUPFD_CLOEXEC, 10)
                high_result = fcntl.fcntl(write_result, fcntl.F_DUPFD_CLOEXEC, 10)
                # Vacate targets so recvmsg actually allocates4/5. Keep the result/socket high.
                for fd in range(3, high_result+1):
                    if fd not in (high_socket, high_result):
                        try: os.close(fd)
                        except OSError: pass
                reservation = os.open('/dev/null', os.O_RDONLY|os.O_CLOEXEC)
                assert reservation == 3
                with socket.socket(fileno=high_socket) as connection:
                    class RecordedReceive:
                        def __init__(self): self.sources = []
                        def recvmsg(self,*args):
                            packet,ancillary,flags,address = connection.recvmsg(*args)
                            for level,kind,data in ancillary:
                                if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                                    values=array.array('i');values.frombytes(data[:len(data)-len(data)%values.itemsize])
                                    self.sources.extend(values)
                            return packet,ancillary,flags,address
                    recording=RecordedReceive()
                    installed = []
                    try:
                        installed = helper.install_native_descriptors(recording, expected)
                        for index, fd in enumerate(installed):
                            helper.observe_native_input(fd, str(self.files[index]), self.expected[index])
                        result = {'accepted': True, 'targets': installed, 'bytes': [os.pread(fd, 100, 0).hex() for fd in installed],
                                  'cloexec': [bool(fcntl.fcntl(fd, fcntl.F_GETFD)&fcntl.FD_CLOEXEC) for fd in installed]}
                    except (RuntimeError, ValueError):
                        result = {'accepted': False}
                    finally:
                        for fd in installed: os.close(fd)
                    result['receivedSources'] = recording.sources
                    os.close(reservation)
                    result['leakedTargets'] = []
                    for fd in range(3,high_result+8):
                        if fd in (high_socket,high_result): continue
                        try: os.fstat(fd); result['leakedTargets'].append(fd)
                        except OSError: pass
                    os.write(high_result, (json.dumps(result)+'\n').encode())
                os._exit(0)
            except BaseException:
                os._exit(125)
        self.children.add(pid)
        right.close()
        os.close(write_result)
        rights = array.array('i', descriptors)
        left.sendmsg([payload if oversized else json.dumps(payload).encode()], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, rights)])
        left.close()
        result = read_line(read_result)
        os.close(read_result)
        self.assertEqual(wait_child(pid), 0)
        self.children.remove(pid)
        return result

    def test_actual_crossprocess_scm_collision_and_offset(self):
        for fd in self.fds: os.lseek(fd, 3, os.SEEK_SET)
        packet = {'kind':'original-collector-inputs','nonce':'b'*64,'authorityId':'owned-control',
                  'roles':['collector-environment','collector-receipt']}
        result = self.receive_in_child(self.fds, packet, packet)
        self.assertTrue(result['accepted'])
        self.assertEqual(result['targets'], [4, 5])
        self.assertEqual(result['receivedSources'], [4, 5])
        self.assertEqual(result['bytes'], [file.read_bytes().hex() for file in self.files])
        self.assertEqual(result['cloexec'], [True, True])
        self.assertEqual(result['leakedTargets'], [])
        self.assertEqual([os.lseek(fd, 0, os.SEEK_CUR) for fd in self.fds], [3,3])

    def test_extra_missing_truncated_and_foreign_packet_close_all(self):
        expected = {'fixed':'packet'}
        for descriptors, packet, oversized in ((self.fds+[self.fds[0]], expected,False),
                    (self.fds[:1],expected,False),(self.fds,b'x'*5000,True),
                    (self.fds,{'foreign':'packet'},False)):
            result = self.receive_in_child(descriptors, packet, expected, oversized)
            self.assertFalse(result['accepted'])
            self.assertEqual(result['leakedTargets'], [])

    def test_original_noinput_preexec_fd3_and_exec(self):
        parent, child = socket.socketpair()
        marker = self.base/'ordinary-exec.txt'
        command = [sys.executable,'-I','-S','-c',
                   "import os; from pathlib import Path; "
                   "assert not Path('/proc/self/fd/3').exists(); "
                   "Path(%r).write_text('ordinary original exec')" % str(marker)]
        pid = os.fork()
        if pid == 0:
            parent.close()
            high = fcntl.fcntl(child.fileno(),fcntl.F_DUPFD_CLOEXEC,10)
            os.dup2(high,3,inheritable=True)
            for fd in range(4,high+1):
                try: os.close(fd)
                except OSError: pass
            os.execv(sys.executable,[sys.executable,'-I','-S',str(SOURCE)])
        self.children.add(pid); child.close()
        request={'command':command,'environmentJson':json.dumps({'PATH':'/usr/bin:/bin','LC_ALL':'C'}),
                 'authorityId':'ordinary-owned-control','privateTmpPlan':None}
        parent.sendall((json.dumps(request)+'\n').encode())
        registration=read_line(parent.fileno())['registration']
        self.assertNotIn('requiredNativeInputs',json.loads(registration))
        self.assertNotIn('nativeInputs',json.loads(registration))
        self.assertFalse(marker.exists())
        parent.sendall((json.dumps({'release':registration})+'\n').encode())
        self.assertEqual(wait_child(pid),0);self.children.remove(pid);parent.close()
        self.assertEqual(marker.read_text(),'ordinary original exec')

    def test_actual_dead_parent_closes_native_authorization(self):
        # A task-owned subreaper permits explicit reaping of the short-lived orphan test child.
        import ctypes
        self.assertEqual(ctypes.CDLL(None).prctl(36,1,0,0,0),0)
        module=types.ModuleType('original_broker_under_test');module.__file__=str(BROKER)
        exec(compile(BROKER.read_bytes(),str(BROKER),'exec'),module.__dict__)
        result_read,result_write=os.pipe()
        admission_read,admission_write=os.pipe()
        controller=os.fork()
        if controller==0:
            identity={'pid':os.getpid(),'processStartIdentity':helper.process_start(os.getpid())}
            recipient=os.fork()
            if recipient==0:
                os.dup2(admission_read,0)
                listener=object.__new__(module.NativeInputListener)
                listener.manifest={'controllerIdentity':identity};listener.helper=helper;listener.closed=False
                listener.ensure_parent()
                os.write(result_write,(json.dumps({'recipient':os.getpid()})+'\n').encode())
                time.sleep(.15)
                try:
                    listener.ensure_parent()
                    os.write(result_write,b'{"refused":false}\n')
                except RuntimeError:
                    os.write(result_write,b'{"refused":true}\n')
                os._exit(0)
            time.sleep(.05);os._exit(0)
        self.children.add(controller);os.close(result_write)
        recipient=read_line(result_read)['recipient'];self.children.add(recipient)
        self.assertEqual(wait_child(controller),0);self.children.remove(controller)
        self.assertTrue(read_line(result_read)['refused'])
        self.assertEqual(wait_child(recipient),0);self.children.remove(recipient);os.close(result_read);os.close(admission_read);os.close(admission_write)

    def test_received_writable_and_path_descriptors_refuse_before_use(self):
        packet = {'owned':'fixed packet'}
        for flags in (os.O_RDWR,os.O_WRONLY,os.O_PATH):
            descriptor=os.open(self.files[0],flags|os.O_CLOEXEC)
            try:
                result=self.receive_in_child([descriptor,self.fds[1]],packet,packet)
                self.assertFalse(result['accepted']);self.assertEqual(result['leakedTargets'],[])
            finally: os.close(descriptor)

    def start_broker(self, manifest, directory, expect_ready=True):
        stdin_read, stdin_write = os.pipe()
        stdout_read, stdout_write = os.pipe()
        dirfd = os.open(directory, os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC)
        pid = os.fork()
        if pid == 0:
            try:
                # Relocate all input/control sources before fixed mappings, exactly as Node stdio does.
                sources = [fcntl.fcntl(fd, fcntl.F_DUPFD_CLOEXEC, 10)
                           for fd in (stdin_read,stdout_write,*self.fds,dirfd)]
                for source, target in zip(sources,(0,1,4,5,6)): os.dup2(source,target,inheritable=True)
                for fd in range(3,max(sources)+1):
                    if fd not in (4,5,6):
                        try: os.close(fd)
                        except OSError: pass
                if not expect_ready:
                    diagnostic = os.open('startup-refusal.stderr',os.O_WRONLY|os.O_CREAT|os.O_CLOEXEC,0o600)
                    os.dup2(diagnostic,2,inheritable=True);os.close(diagnostic)
                os.execv(sys.executable,[sys.executable,'-I','-S',str(BROKER),str(directory/'owner.sock'),
                    '65536','2','2']+([json.dumps(manifest)] if manifest is not None else []))
            except BaseException:
                os._exit(125)
        self.children.add(pid)
        os.close(stdin_read);os.close(stdout_write);os.close(dirfd)
        if not expect_ready:
            return pid,stdin_write,stdout_read
        ready=read_line(stdout_read)
        if manifest is None:
            self.assertEqual(ready, {'kind':'ready','pid':pid})
        else:
            self.assertEqual(set(ready), {'kind','pid','nativeInputSocket'})
            actual=os.lstat(str(directory/'inputs.sock'))
            self.assertEqual(ready['nativeInputSocket'], {'path':str(Path(manifest['directory']['path'])/'inputs.sock'),
                'device':str(actual.st_dev),'inode':str(actual.st_ino),'mode':str(actual.st_mode),'uid':str(actual.st_uid)})
        return pid,stdin_write,stdout_read

    def test_required_initial_release_cannot_execute_and_control_is_high(self):
        parent, child=socket.socketpair()
        marker=self.base/'must-not-exec.txt'
        command=[sys.executable,'-I','-S','-c',"from pathlib import Path;Path(%r).write_text('bad')" % str(marker)]
        stderr=os.open(self.base/'required-refusal.stderr',os.O_WRONLY|os.O_CREAT|os.O_CLOEXEC,0o600)
        pid=os.fork()
        if pid==0:
            parent.close()
            high=fcntl.fcntl(child.fileno(),fcntl.F_DUPFD_CLOEXEC,10)
            os.dup2(stderr,2,inheritable=True);os.dup2(high,3,inheritable=True)
            for fd in range(4,high+1):
                try:os.close(fd)
                except OSError:pass
            os.execv(sys.executable,[sys.executable,'-I','-S',str(SOURCE)])
        self.children.add(pid);child.close();os.close(stderr)
        parent.sendall((json.dumps({'command':command,'environmentJson':json.dumps({'PATH':'/usr/bin:/bin'}),
            'authorityId':'owned-input-negative','privateTmpPlan':None,'nativeInputCarrier':{}})+'\n').encode())
        registration=read_line(parent.fileno())['registration']
        self.assertIn('requiredNativeInputs',json.loads(registration))
        self.assertFalse(Path('/proc/%d/fd/3'%pid).exists())
        parent.sendall((json.dumps({'release':registration})+'\n').encode())
        self.assertNotEqual(wait_child(pid),0);self.children.remove(pid);parent.close()
        self.assertFalse(marker.exists())

    def broker_manifest(self,directory):
        metadata=directory.stat()
        return {'directory':{'path':str(directory),'device':str(metadata.st_dev),'inode':str(metadata.st_ino)},
            'controllerIdentity':{'pid':os.getpid(),'processStartIdentity':helper.process_start(os.getpid())},
            'files':self.expected,'preexecSha256':hashlib.sha256(SOURCE.read_bytes()).hexdigest()}

    def test_original_ordinary_broker_protocol_and_cancellation(self):
        previous=os.getcwd();os.chdir(self.base)
        try:
            pid,stdin,stdout=self.start_broker(None,Path('.'))
            peer=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);peer.connect('owner.sock')
            request={'original':'ordinary-owner-request'};peer.sendall((json.dumps(request)+'\n').encode())
            event=read_line(stdout)
            self.assertEqual(event['kind'],'request');self.assertEqual(event['request'],request)
            self.assertEqual(event['peer']['pid'],os.getpid())
            response={'kind':'result','ordinary':'unchanged'}
            os.write(stdin,(json.dumps({'id':event['id'],'message':response})+'\n').encode())
            self.assertEqual(read_line(peer.fileno()),response)
            peer.sendall(b'{"kind":"cancel"}\n')
            self.assertEqual(read_line(stdout),{'kind':'cancel','id':event['id']})
            peer.close();self.assertEqual(read_line(stdout),{'kind':'disconnect','id':event['id']})
            os.close(stdin);self.assertEqual(wait_child(pid),0);self.children.remove(pid);os.close(stdout)
            self.assertFalse((self.base/'inputs.sock').exists())
        finally:os.chdir(previous)

    def test_pending_raw_receive_is_closed_by_parent_pipe_eof(self):
        directory=self.base/'pending';directory.mkdir(mode=0o700)
        manifest=self.broker_manifest(directory)
        previous=os.getcwd();os.chdir(directory)
        try:
            pid,stdin,stdout=self.start_broker(manifest,Path('.'))
            peer=socket.socket(socket.AF_UNIX,socket.SOCK_SEQPACKET);peer.settimeout(3);peer.connect('inputs.sock')
            peer.send(json.dumps({'kind':'receive-original-collector-inputs','nonce':'c'*64,
                'authorityId':'owned-cancel-control','registrationSha256':'d'*64}).encode())
            self.assertEqual(read_line(stdout)['kind'],'native-input-request')
            # No parent authorization is sent. EOF revokes before any SCM_RIGHTS delivery.
            os.close(stdin)
            packet,ancillary,_,_=peer.recvmsg(4096,socket.CMSG_SPACE(8),socket.MSG_CMSG_CLOEXEC)
            self.assertEqual(packet,b'');self.assertEqual(ancillary,[])
            peer.close();self.assertEqual(wait_child(pid),0);self.children.remove(pid);os.close(stdout)
        finally:os.chdir(previous)

    def test_startup_collision_retains_unknown_socket_incarnation(self):
        directory=self.base/'collision';directory.mkdir(mode=0o700)
        manifest=self.broker_manifest(directory)
        previous=os.getcwd();os.chdir(directory)
        original=socket.socket(socket.AF_UNIX,socket.SOCK_SEQPACKET)
        try:
            original.bind('inputs.sock');os.chmod('inputs.sock',0o600);original.listen(1)
            before=os.lstat('inputs.sock')
            pid,stdin,stdout=self.start_broker(manifest,Path('.'),expect_ready=False)
            self.assertNotEqual(wait_child(pid),0);self.children.remove(pid)
            self.assertEqual(os.read(stdout,4096),b'')
            os.close(stdin);os.close(stdout)
            after=os.lstat('inputs.sock')
            self.assertEqual((before.st_dev,before.st_ino,before.st_mode),(after.st_dev,after.st_ino,after.st_mode))
            original.settimeout(1)
            peer=socket.socket(socket.AF_UNIX,socket.SOCK_SEQPACKET);peer.connect('inputs.sock')
            accepted,_=original.accept();accepted.close();peer.close()
        finally:original.close();os.chdir(previous)

    def test_original_broker_raw_carrier_relative_bind_single_use_and_eof(self):
        # Host path exceeds sockaddr_un; only the separate fixed-role relative bind is short.
        directory = self.base / ('a'*60)
        directory.mkdir(mode=0o700)
        manifest = self.broker_manifest(directory)
        # Ordinary owner.sock must remain short; test uses task-owned relative cwd for BOTH test locators.
        previous = os.getcwd()
        os.chdir(directory)
        try:
            pid,stdin,stdout = self.start_broker(manifest,Path('.'))
            connection = socket.socket(socket.AF_UNIX,socket.SOCK_SEQPACKET)
            connection.connect('inputs.sock')
            request={'kind':'receive-original-collector-inputs','nonce':'a'*64,'authorityId':'owned-control',
                     'registrationSha256':'b'*64}
            connection.send(json.dumps(request).encode())
            event=read_line(stdout)
            self.assertEqual(event['kind'],'native-input-request')
            with open('/proc/self/cgroup') as source: cgroup=source.read()
            authorization={'kind':'authorize-native-inputs','id':event['id'],'request':request,
                           'peer':{'pid':os.getpid(),'uid':os.getuid(),'startIdentity':helper.process_start(os.getpid())},
                           'cgroup':cgroup}
            os.write(stdin,(json.dumps(authorization)+'\n').encode())
            packet,ancillary,flags,_=connection.recvmsg(4096,socket.CMSG_SPACE(8),socket.MSG_CMSG_CLOEXEC)
            self.assertEqual(flags & (socket.MSG_TRUNC|socket.MSG_CTRUNC),0)
            received=array.array('i'); received.frombytes(ancillary[0][2])
            try:
                self.assertEqual(len(received),2)
                self.assertEqual([os.pread(fd,100,0) for fd in received],[file.read_bytes() for file in self.files])
                self.assertTrue(all(fcntl.fcntl(fd,fcntl.F_GETFD)&fcntl.FD_CLOEXEC for fd in received))
            finally:
                for fd in received: os.close(fd)
            self.assertEqual(read_line(stdout),{'kind':'native-input-delivered','id':event['id']})
            connection.close()
            replay=socket.socket(socket.AF_UNIX,socket.SOCK_SEQPACKET);replay.settimeout(3);replay.connect('inputs.sock')
            replay.send(json.dumps(request).encode()); self.assertEqual(replay.recv(4096),b'');replay.close()
            # EOF closes admission and all retained input FDs; parent waits for actual process exit.
            os.close(stdin)
            self.assertEqual(wait_child(pid),0);self.children.remove(pid);os.close(stdout)
        finally:
            os.chdir(previous)


if __name__ == '__main__':
    unittest.main()
