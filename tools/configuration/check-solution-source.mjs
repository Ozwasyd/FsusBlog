#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const xmlParser = String.raw`
import json, sys
from xml.parsers import expat
document = json.load(sys.stdin)
if "&" in document["source"]:
    raise ValueError("solution XML refuses source entity references and attribute aliases")
projects = []
depth = 0
roots = 0
def refuse(*arguments):
    raise ValueError("solution XML refuses declarations, entities, or processing instructions")
def start(name, attributes):
    global depth, roots
    if depth == 0:
        if name != "Solution" or attributes or roots:
            raise ValueError("expected one flat Solution root without attributes")
        roots += 1
    elif depth == 1:
        if name != "Project" or set(attributes) != {"Path"} or not attributes["Path"]:
            raise ValueError("expected only Project elements with one Path attribute")
        projects.append(attributes["Path"])
    else:
        raise ValueError("nested solution structures are unsupported")
    depth += 1
def end(name):
    global depth
    depth -= 1
def text(value):
    if value.strip():
        raise ValueError("solution XML refuses element text")
parser = expat.ParserCreate()
parser.StartElementHandler = start
parser.EndElementHandler = end
parser.CharacterDataHandler = text
parser.StartDoctypeDeclHandler = refuse
parser.EntityDeclHandler = refuse
parser.ExternalEntityRefHandler = refuse
parser.ProcessingInstructionHandler = refuse
parser.Parse(document["source"], True)
if roots != 1 or depth or not projects:
    raise ValueError("solution must declare at least one project")
print(json.dumps({"projects": projects}))
`;

function sha256(bytes)
{
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sameEpoch(before, after)
{
    return ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(key => before[key] === after[key]);
}

function normalizedPath(file, extension)
{
    if (typeof file !== 'string' || !file.endsWith(extension) || path.posix.isAbsolute(file)
        || /[\\\0\r\n:*?$%]/u.test(file) || file.split('/').some(part => !part || part === '.' || part === '..'))
    {
        throw new Error(`solution source requires a normalized relative ${extension} path`);
    }
    return file;
}

function git(root, argumentsList, input)
{
    return execFileSync('git', ['-C', root, ...argumentsList],
        { input, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, maxBuffer: 32 * 1024 * 1024 });
}

function bindFile(root, file)
{
    const absolute = path.join(root, file);
    const ancestors = [{ path: root, stat: fs.lstatSync(root, { bigint: true }) }];
    let current = root;
    for (const part of file.split('/').slice(0, -1))
    {
        current = path.join(current, part);
        const stat = fs.lstatSync(current, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink())
        {
            throw new Error(`solution path refuses a linked or non-directory ancestor: ${file}`);
        }
        ancestors.push({ path: current, stat });
    }
    const descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try
    {
        const before = fs.fstatSync(descriptor, { bigint: true });
        const named = fs.lstatSync(absolute, { bigint: true });
        if (!before.isFile() || before.nlink !== 1n || !sameEpoch(before, named))
        {
            throw new Error(`solution path requires one regular single-link file: ${file}`);
        }
        const bytes = fs.readFileSync(descriptor);
        const index = git(root, ['ls-files', '--stage', '-z', '--', `:(literal)${file}`]).toString('utf8');
        const match = index.match(/^(100644|100755) ([a-f0-9]{40}) 0\t([^\0]+)\0$/u);
        if (!match || match[3] !== file || !git(root, ['cat-file', 'blob', match[2]]).equals(bytes)
            || git(root, ['rev-parse', `HEAD:${file}`]).toString('utf8').trim() !== match[2]
            || Boolean(before.mode & 0o111n) !== (match[1] === '100755'))
        {
            throw new Error(`solution source HEAD/index/physical bytes or mode disagree: ${file}`);
        }
        return { descriptor, absolute, before, ancestors, bytes,
            binding: { file, mode: match[1], blob: match[2], sha256: sha256(bytes), bytes: bytes.length,
                epoch: Object.fromEntries(['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs']
                    .map(key => [key, before[key].toString()])) } };
    }
    catch (error)
    {
        fs.closeSync(descriptor);
        throw error;
    }
}

function verifyFile(held)
{
    if (!sameEpoch(held.before, fs.fstatSync(held.descriptor, { bigint: true }))
        || !sameEpoch(held.before, fs.lstatSync(held.absolute, { bigint: true }))
        || held.ancestors.some(value => !sameEpoch(value.stat, fs.lstatSync(value.path, { bigint: true }))))
    {
        throw new Error(`solution source identity changed during inspection: ${held.binding.file}`);
    }
}

function pythonIdentity()
{
    for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean))
    {
        const candidate = path.join(directory, 'python3');
        try
        {
            fs.accessSync(candidate, fs.constants.X_OK);
            const executable = fs.realpathSync(candidate);
            const descriptor = fs.openSync(executable, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            try
            {
                const stat = fs.fstatSync(descriptor, { bigint: true });
                if (!stat.isFile() || stat.nlink !== 1n)
                {
                    throw new Error('Python parser executable must be regular and single-link');
                }
                return { executable, descriptor, stat, sha256: sha256(fs.readFileSync(descriptor)) };
            }
            catch (error)
            {
                fs.closeSync(descriptor);
                throw error;
            }
        }
        catch (error)
        {
            if (error.code !== 'ENOENT' && error.code !== 'EACCES')
            {
                throw error;
            }
        }
    }
    throw new Error('solution XML parser requires an actual python3 executable');
}

export function inspectSolutionSource({ repositoryRoot, files })
{
    if (['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].some(key => process.env[key]))
    {
        throw new Error('solution inspection refuses an ambient alternate Git repository or index');
    }
    const root = path.resolve(repositoryRoot);
    if (fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory())
    {
        throw new Error('solution inspection requires the actual repository directory');
    }
    if (!Array.isArray(files) || !files.length || new Set(files).size !== files.length)
    {
        throw new Error('solution inspection requires distinct explicit files');
    }
    files.forEach(file => normalizedPath(file, '.slnx'));
    const head = git(root, ['rev-parse', 'HEAD']).toString('utf8').trim();
    const indexDigest = sha256(git(root, ['ls-files', '--stage', '-z']));
    const held = [];
    const parser = pythonIdentity();
    const solutions = [];
    try
    {
        for (const file of files)
        {
            const solution = bindFile(root, file);
            held.push(solution);
            const source = solution.bytes.toString('utf8');
            if (!Buffer.from(source).equals(solution.bytes))
            {
                throw new Error(`solution source is not exact UTF-8: ${file}`);
            }
            const result = spawnSync(parser.executable, ['-I', '-B', '-S', '-c', xmlParser],
                { input: JSON.stringify({ source }), encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 10_000 });
            if (result.error || result.status !== 0)
            {
                throw new Error(`solution XML refused: ${result.error?.message ?? result.stderr}`);
            }
            const parsed = JSON.parse(result.stdout);
            if (!Array.isArray(parsed.projects) || !parsed.projects.length)
            {
                throw new Error('solution XML parser did not return explicit projects');
            }
            const projectPaths = parsed.projects.map(value =>
                path.posix.join(path.posix.dirname(file), normalizedPath(value, '.csproj')));
            if (new Set(projectPaths).size !== projectPaths.length)
            {
                throw new Error('solution XML refuses duplicate project paths');
            }
            const projects = projectPaths.map(project =>
            {
                const existing = held.find(value => value.binding.file === project);
                if (existing)
                {
                    return existing.binding;
                }
                const input = bindFile(root, project);
                held.push(input);
                return input.binding;
            });
            solutions.push({ ...solution.binding, projects });
        }
        held.forEach(verifyFile);
        if (head !== git(root, ['rev-parse', 'HEAD']).toString('utf8').trim()
            || indexDigest !== sha256(git(root, ['ls-files', '--stage', '-z']))
            || !sameEpoch(parser.stat, fs.fstatSync(parser.descriptor, { bigint: true }))
            || !sameEpoch(parser.stat, fs.lstatSync(parser.executable, { bigint: true })))
        {
            throw new Error('solution inspection HEAD/index or parser identity changed');
        }
        held.forEach(verifyFile);
        return { schema: 'fsusblog.solution-source-check.v1', head, indexDigest,
            parser: { executable: parser.executable, sha256: parser.sha256, sourceSha256: sha256(xmlParser) },
            solutions, status: 'success', qualificationEligible: false };
    }
    finally
    {
        held.forEach(value => fs.closeSync(value.descriptor));
        fs.closeSync(parser.descriptor);
    }
}

export function validateSolutionSourceReceipt({ repositoryRoot, files, expectedHead, receipt })
{
    if (typeof expectedHead !== 'string' || !/^[a-f0-9]{40}$/u.test(expectedHead))
    {
        throw new Error('solution receipt requires the independent candidate HEAD');
    }
    // Reopen the actual source through the original XML/FD owner. This projects
    // every current project and the closed receipt shape without trusting a
    // caller-provided project list, a stale summary, or extra artifact fields.
    const expected = inspectSolutionSource({ repositoryRoot, files });
    if (expected.head !== expectedHead || !isDeepStrictEqual(receipt, expected))
    {
        throw new Error('solution receipt does not exactly bind the independent current source projection');
    }
    return expected;
}

function main(argv)
{
    let repositoryRoot;
    const files = [];
    for (let index = 0; index < argv.length; index += 2)
    {
        const value = argv[index + 1];
        if (!value || !['--root', '--file'].includes(argv[index]))
        {
            throw new Error('solution checker accepts only --root and explicit --file pairs');
        }
        if (argv[index] === '--root')
        {
            if (repositoryRoot)
            {
                throw new Error('solution checker requires one repository root');
            }
            repositoryRoot = value;
        }
        else
        {
            files.push(value);
        }
    }
    if (!repositoryRoot)
    {
        throw new Error('solution checker requires explicit --root');
    }
    console.log(JSON.stringify(inspectSolutionSource({ repositoryRoot, files })));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        main(process.argv.slice(2));
    }
    catch (error)
    {
        console.error(`[solution-source] ${error.message}`);
        process.exitCode = 1;
    }
}
