import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { runPhysicalExecution } = await import(new URL('../test/physical-execution-process-tree.mjs', import.meta.url));

const toolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const checker = path.join(toolRoot, 'tools/docker/backend-input-closure.mjs');
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export function createBackendIdentity(uid, gid)
{
    if (![uid, gid].every(value => Number.isSafeInteger(value) && value >= 0))
    {
        throw new Error('backend evaluation requires a valid numeric UID and GID');
    }
    return {
        passwd: `root:x:0:0:root:/tmp/root:/bin/sh\n${uid === 0 ? '' : `fsusprobe:x:${uid}:${gid}:isolated backend evaluation:/tmp/backend-home:/bin/sh\n`}`,
        group: `root:x:0:\n${gid === 0 ? '' : `fsusprobe:x:${gid}:\n`}`,
        'nsswitch.conf': 'passwd: files\ngroup: files\nhosts: files\n'
    };
}

function executable(name)
{
    for (const directory of String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean))
    {
        const candidate = path.join(directory, name);
        try
        {
            fs.accessSync(candidate, fs.constants.X_OK);
            const resolved = fs.realpathSync(candidate);
            if (fs.statSync(resolved).isFile())
            {
                return resolved;
            }
        }
        catch (error)
        {
            if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code))
            {
                throw error;
            }
        }
    }
    throw new Error(`backend evaluation requires ${name}; no host-evaluation fallback is permitted`);
}

function snapshotInputs(root, inventory)
{
    const projectRoots = inventory.projects.map(project => path.dirname(project.path));
    const excluded = new Set(projectRoots.flatMap(directory => ['bin', 'obj'].map(name => path.join(directory, name))));
    const values = {};
    const visit = relativePath =>
    {
        if (excluded.has(relativePath))
        {
            return;
        }
        const file = path.resolve(root, relativePath);
        if (file === root || !file.startsWith(`${root}${path.sep}`))
        {
            throw new Error('backend input snapshot escapes the repository');
        }
        let stat;
        try
        {
            stat = fs.lstatSync(file);
        }
        catch (error)
        {
            if (error.code !== 'ENOENT')
            {
                throw error;
            }
            values[relativePath] = null;
            return;
        }
        if (stat.isSymbolicLink())
        {
            values[relativePath] = { symlink: fs.readlinkSync(file) };
            return;
        }
        if (!fs.realpathSync(file).startsWith(`${root}${path.sep}`))
        {
            throw new Error('backend input snapshot traverses an external symlink');
        }
        if (stat.isDirectory())
        {
            for (const name of fs.readdirSync(file).sort())
            {
                visit(path.join(relativePath, name));
            }
        }
        else if (stat.isFile())
        {
            values[relativePath] = hash(fs.readFileSync(file));
        }
        else
        {
            throw new Error('backend input snapshot contains an unsupported file type');
        }
    };
    for (const input of [...new Set(['config/build/backend-docker-inputs.json', ...projectRoots,
        ...inventory.imports, ...inventory.restoreFiles, ...inventory.allowedExternalItemRoots,
        ...inventory.allowedExternalItemFiles, ...inventory.optionalPublishRoots])].sort())
    {
        visit(input);
    }
    return values;
}

export function backendEnvironmentCommand({ root, directory, node, dotnet, bwrap })
{
    const args = [bwrap, '--unshare-user', '--unshare-pid', '--unshare-net', '--die-with-parent', '--new-session', '--clearenv',
        '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib',
        '--symlink', 'usr/lib64', '/lib64', '--dir', '/etc', '--ro-bind', '/etc/ld.so.cache', '/etc/ld.so.cache',
        '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--ro-bind', root, '/src',
        '--ro-bind', path.dirname(dotnet), '/dotnet', '--ro-bind', node, '/runtime/node',
        '--ro-bind', checker, '/runner/backend-input-closure.mjs',
        '--ro-bind', path.join(directory, 'request.json'), '/request.json'];
    for (const name of ['passwd', 'group', 'nsswitch.conf'])
    {
        args.push('--ro-bind', path.join(directory, name), `/etc/${name}`);
    }
    const environment = {
        PATH: '/dotnet:/runtime:/usr/bin:/bin', DOTNET_ROOT: '/dotnet',
        DOTNET_CLI_HOME: '/tmp/backend-dotnet-home', NUGET_PACKAGES: '/tmp/backend-nuget-packages',
        DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
        MSBUILDDISABLENODEREUSE: '1', TMPDIR: '/tmp'
    };
    for (const [name, value] of Object.entries(environment))
    {
        args.push('--setenv', name, value);
    }
    const worker = `import fs from 'node:fs';
import { evaluateClosure } from '/runner/backend-input-closure.mjs';
const request = JSON.parse(fs.readFileSync('/request.json', 'utf8'));
const ancestors = request.ancestorFiles.map(path => {
    try { fs.lstatSync(path); return { path, absent: false }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; return { path, absent: true }; }
});
process.stderr.write(JSON.stringify({ kind: 'backend-evaluation-ancestor-absence', ancestors }) + '\\n');
if (ancestors.some(entry => !entry.absent)) throw new Error('backend evaluation ancestor configuration is present');
process.stdout.write(JSON.stringify({ closure: evaluateClosure('/src', request.inventory), ancestors }));`;
    args.push('--chdir', '/src', '--', '/runtime/node', '--input-type=module', '-e', worker);
    return args;
}

export async function evaluateBackendEnvironment(root, inventory, ancestorFiles)
{
    if (process.platform !== 'linux')
    {
        throw new Error('backend input evaluation requires Linux bubblewrap isolation');
    }
    const bwrap = executable('bwrap');
    const dotnet = executable('dotnet');
    const node = fs.realpathSync(process.execPath);
    const directory = path.join(root, '.tmp', 'backend-input-evaluations', randomUUID());
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const identity = createBackendIdentity(process.getuid(), process.getgid());
    for (const [name, content] of Object.entries(identity))
    {
        fs.writeFileSync(path.join(directory, name), content, { mode: 0o600 });
    }
    const request = { inventory, ancestorFiles };
    fs.writeFileSync(path.join(directory, 'request.json'), JSON.stringify(request), { mode: 0o600 });
    const command = backendEnvironmentCommand({ root, directory, node, dotnet, bwrap });
    const sources = [checker, fileURLToPath(import.meta.url),
        ...['physical-execution-process-tree.mjs', 'physical-execution-linux-systemd-adapter.mjs',
            'physical-execution-linux-systemd-bootstrap.mjs', 'physical-execution-linux-preexec.py',
            'process-identity.mjs'].map(name => path.join(toolRoot, 'tools/test', name)),
        path.join(toolRoot, 'config/testing/physical-execution-process-policy.json')];
    const snapshot = () => Object.fromEntries(sources.map(file => [file, hash(fs.readFileSync(file))]));
    const before = snapshot();
    const inputsBefore = snapshotInputs(root, inventory);
    const started = { schema: 'fsusblog.backend-input-evaluation.v1', start: new Date().toISOString(), root,
        command, request, identity, sources: before, inputs: inputsBefore,
        executables: Object.fromEntries([node, dotnet, bwrap].map(file => [file, hash(fs.readFileSync(file))])) };
    fs.writeFileSync(path.join(directory, 'started.json'), JSON.stringify(started, null, 2), { mode: 0o600 });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('backend input evaluation exceeded 180 seconds')), 180000);
    let outputBytes = 0;
    const sink = { write(chunk)
    {
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > 4 * 1024 * 1024)
        {
            controller.abort(new Error('backend input evaluation exceeded 4 MiB of output'));
        }
    } };
    let result;
    let failure;
    try
    {
        result = await runPhysicalExecution({ command, cwd: root, signal: controller.signal,
            stdout: sink, stderr: sink, residualRoot: path.join(directory, 'residuals') });
    }
    catch (error)
    {
        failure = error;
        result = error.physicalExecution ?? { postObservation: 'unverifiable' };
    }
    finally
    {
        clearTimeout(timer);
    }
    const after = snapshot();
    const changed = sources.filter(file => before[file] !== after[file]);
    const inputsAfter = snapshotInputs(root, inventory);
    const inputsUnchanged = JSON.stringify(inputsBefore) === JSON.stringify(inputsAfter);
    const logs = {};
    for (const stream of ['stdout', 'stderr'])
    {
        const bytes = result[stream] ?? '';
        const file = path.join(directory, `${stream}.log`);
        fs.writeFileSync(file, bytes, { mode: 0o600 });
        logs[stream] = { path: file, sha256: hash(bytes) };
    }
    const receipt = { ...started, end: new Date().toISOString(), error: failure?.message ?? null,
        after, changed, inputsAfter, inputsUnchanged, logs, physicalExecution: result };
    const receiptPath = path.join(directory, 'execution.json');
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), { mode: 0o600 });
    if (failure || changed.length || !inputsUnchanged || result.postObservation !== 'zero-members' || result.logComplete !== true)
    {
        throw new Error(`backend isolated evaluation failed; receipt=${receiptPath}: ${failure?.message ?? 'source or process-tree verification failed'}\n${result.stderr ?? ''}`);
    }
    const response = JSON.parse(result.stdout);
    if (JSON.stringify(response.ancestors) !== JSON.stringify(ancestorFiles.map(path => ({ path, absent: true }))))
    {
        throw new Error(`backend ancestor observation is not exact; receipt=${receiptPath}`);
    }
    return { closure: response.closure, evidence: { path: receiptPath, sha256: hash(fs.readFileSync(receiptPath)) } };
}
