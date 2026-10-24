#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { devNull } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const { parseBlameIgnoreRevisions, validateRepositoryBlameIgnore } = await import(new URL('../governance/change-contract.mjs', import.meta.url));

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

// This fixed parser consumes held source bytes only; target imports and bodies
// never execute. Its resource limits apply only to this owned parser process.
const pythonAstParser = String.raw`
import ast, json, resource, sys
resource.setrlimit(resource.RLIMIT_AS, (128 * 1024 * 1024, 128 * 1024 * 1024))
resource.setrlimit(resource.RLIMIT_CPU, (2, 2))
document = json.load(sys.stdin)
try:
    ast.parse(document["source"].encode("utf-8"), filename=document["file"], mode="exec")
except (SyntaxError, ValueError, MemoryError, RecursionError) as error:
    print(json.dumps({"status": "failure", "errorType": type(error).__name__,
        "line": getattr(error, "lineno", None), "column": getattr(error, "offset", None)}))
    sys.exit(1)
print(json.dumps({"status": "success", "executable": sys.executable, "version": sys.version}))
`;

const pythonAstLimits = Object.freeze({ fileBytes: 1024 * 1024, batchBytes: 8 * 1024 * 1024,
    addressSpaceBytes: 128 * 1024 * 1024, cpuSeconds: 2, timeoutMs: 10_000, outputBytes: 16 * 1024 });

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

function git(root, argumentsList, input, unrewritten = false)
{
    return execFileSync('git', ['-C', root, ...argumentsList],
        { input, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0',
            ...(unrewritten ? { GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: devNull } : {}) },
        maxBuffer: 32 * 1024 * 1024 });
}

function bindFile(root, file, maximumBytes = null, unrewritten = false)
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
        if (maximumBytes !== null && before.size > BigInt(maximumBytes))
        {
            throw new Error(`source syntax input exceeds the bounded file size: ${file}`);
        }
        let bytes;
        if (maximumBytes === null)
        {
            bytes = fs.readFileSync(descriptor);
        }
        else
        {
            const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1));
            const chunks = [];
            let total = 0;
            while (total <= maximumBytes)
            {
                const length = Math.min(buffer.length, maximumBytes + 1 - total);
                const count = fs.readSync(descriptor, buffer, 0, length, null);
                if (count === 0)
                {
                    break;
                }
                total += count;
                if (total > maximumBytes)
                {
                    throw new Error(`source syntax input exceeds the bounded file size: ${file}`);
                }
                chunks.push(Buffer.from(buffer.subarray(0, count)));
            }
            bytes = Buffer.concat(chunks, total);
        }
        const index = git(root, ['ls-files', '--stage', '-z', '--', `:(literal)${file}`], undefined, unrewritten).toString('utf8');
        const match = index.match(/^(100644|100755) ([a-f0-9]{40}) 0\t([^\0]+)\0$/u);
        if (!match || match[3] !== file || !git(root, ['cat-file', 'blob', match[2]], undefined, unrewritten).equals(bytes)
            || git(root, ['rev-parse', `HEAD:${file}`], undefined, unrewritten).toString('utf8').trim() !== match[2]
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

function pythonIdentity(directories = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean))
{
    for (const directory of directories)
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

/** Inspect explicit committed Python source using a fixed isolated AST parser only. */
export function inspectPythonSource({ repositoryRoot, files })
{
    if (['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].some(key => process.env[key]))
    {
        throw new Error('Python source inspection refuses an ambient alternate Git repository or index');
    }
    const root = path.resolve(repositoryRoot);
    if (fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory())
    {
        throw new Error('Python source inspection requires the actual repository directory');
    }
    if (!Array.isArray(files) || !files.length || new Set(files).size !== files.length)
    {
        throw new Error('Python source inspection requires distinct explicit files');
    }
    files.forEach(file => normalizedPath(file, '.py'));
    const head = git(root, ['rev-parse', 'HEAD']).toString('utf8').trim();
    const indexDigest = sha256(git(root, ['ls-files', '--stage', '-z']));
    const held = [];
    // The SOURCE port uses the actual system interpreter, not a caller's PATH
    // program. Its identity is held and rechecked; this is no runtime support grant.
    const parser = pythonIdentity(['/usr/bin']);
    const sources = [];
    let totalBytes = 0;
    let version = null;
    try
    {
        for (const file of files)
        {
            const remainingBytes = pythonAstLimits.batchBytes - totalBytes;
            const input = bindFile(root, file, Math.min(pythonAstLimits.fileBytes, remainingBytes));
            held.push(input);
            totalBytes += input.bytes.length;
            if (totalBytes > pythonAstLimits.batchBytes)
            {
                throw new Error('Python source syntax inputs exceed the bounded batch size');
            }
            const source = input.bytes.toString('utf8');
            if (!Buffer.from(source).equals(input.bytes))
            {
                throw new Error(`Python source is not exact UTF-8: ${file}`);
            }
            const result = spawnSync(parser.executable, ['-I', '-B', '-S', '-c', pythonAstParser],
                { input: JSON.stringify({ file, source }), encoding: 'utf8',
                    maxBuffer: pythonAstLimits.outputBytes, timeout: pythonAstLimits.timeoutMs });
            if (result.error || result.status !== 0)
            {
                throw new Error(`Python AST source refused: ${result.error?.message ?? result.stdout}`);
            }
            const parsed = JSON.parse(result.stdout);
            if (JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify(['executable', 'status', 'version'])
                || parsed.status !== 'success' || parsed.executable !== parser.executable
                || typeof parsed.version !== 'string' || !/^3\.\d+\.\d+ /u.test(parsed.version)
                || (version !== null && version !== parsed.version))
            {
                throw new Error('Python AST worker output does not bind the actual isolated interpreter');
            }
            version = parsed.version;
            sources.push(input.binding);
        }
        held.forEach(verifyFile);
        if (head !== git(root, ['rev-parse', 'HEAD']).toString('utf8').trim()
            || indexDigest !== sha256(git(root, ['ls-files', '--stage', '-z']))
            || !sameEpoch(parser.stat, fs.fstatSync(parser.descriptor, { bigint: true }))
            || !sameEpoch(parser.stat, fs.lstatSync(parser.executable, { bigint: true })))
        {
            throw new Error('Python source inspection HEAD/index or parser identity changed');
        }
        held.forEach(verifyFile);
        return { schema: 'fsusblog.python-ast-source-check.v1', head, indexDigest,
            parser: { executable: parser.executable, sha256: parser.sha256,
                sourceSha256: sha256(pythonAstParser), version }, limits: { ...pythonAstLimits },
            sources, status: 'success', qualificationEligible: false };
    }
    finally
    {
        held.forEach(value => fs.closeSync(value.descriptor));
        fs.closeSync(parser.descriptor);
    }
}

/** Validate the whole AST receipt against independent current source and HEAD. */
export function validatePythonSourceReceipt({ repositoryRoot, files, expectedHead, receipt })
{
    if (typeof expectedHead !== 'string' || !/^[a-f0-9]{40}$/u.test(expectedHead))
    {
        throw new Error('Python source receipt requires the independent candidate HEAD');
    }
    const expected = inspectPythonSource({ repositoryRoot, files });
    if (expected.head !== expectedHead || !isDeepStrictEqual(receipt, expected))
    {
        throw new Error('Python receipt does not exactly bind the independent current source projection');
    }
    return expected;
}

function assertBlameHistoryContext(root)
{
    if (['GIT_REPLACE_REF_BASE', 'GIT_GRAFT_FILE'].some(key => Object.hasOwn(process.env, key)))
    {
        throw new Error('blame-ignore refuses an ambient Git history-rewrite replacement or graft context');
    }
    if (git(root, ['for-each-ref', '--format=%(refname)', 'refs/replace/'], undefined, true).toString('utf8').trim())
    {
        throw new Error('blame-ignore refuses active Git replacement refs');
    }
    const gitDirectory = path.resolve(root, git(root, ['rev-parse', '--git-common-dir'], undefined, true).toString('utf8').trim());
    const graft = path.join(gitDirectory, 'info/grafts');
    try
    {
        fs.lstatSync(graft);
    }
    catch (error)
    {
        if (error.code === 'ENOENT')
        {
            return;
        }
        throw error;
    }
    throw new Error('blame-ignore refuses repository Git history-rewrite info/grafts');
}

/** Inspect only canonical blame metadata; the independent range/PR contract still applies. */
export function inspectBlameIgnoreSource({ repositoryRoot, files })
{
    if (['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].some(key => process.env[key]))
    {
        throw new Error('blame-ignore inspection refuses an ambient alternate Git repository or index');
    }
    const root = path.resolve(repositoryRoot);
    if (fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory())
    {
        throw new Error('blame-ignore inspection requires the actual repository directory');
    }
    if (!Array.isArray(files) || files.length !== 1 || files[0] !== '.git-blame-ignore-revs')
    {
        throw new Error('blame-ignore inspection requires only the canonical .git-blame-ignore-revs input');
    }
    assertBlameHistoryContext(root);
    const head = git(root, ['rev-parse', 'HEAD'], undefined, true).toString('utf8').trim();
    const indexDigest = sha256(git(root, ['ls-files', '--stage', '-z'], undefined, true));
    const held = bindFile(root, files[0], null, true);
    try
    {
        const errors = validateRepositoryBlameIgnore(root);
        if (errors.length)
        {
            throw new Error('blame-ignore history refused: ' + errors.join('\n'));
        }
        if (head !== git(root, ['rev-parse', 'HEAD'], undefined, true).toString('utf8').trim()
            || indexDigest !== sha256(git(root, ['ls-files', '--stage', '-z'], undefined, true)))
        {
            throw new Error('blame-ignore source inspection HEAD or index changed');
        }
        verifyFile(held);
        assertBlameHistoryContext(root);
        return { schema: 'fsusblog.blame-ignore-source-check.v1', head, indexDigest,
            validator: 'tools/governance/change-contract.mjs#validateRepositoryBlameIgnore',
            sources: [held.binding], revisions: parseBlameIgnoreRevisions(held.bytes.toString('utf8')),
            status: 'success', qualificationEligible: false };
    }
    finally
    {
        fs.closeSync(held.descriptor);
    }
}

export function validateBlameIgnoreSourceReceipt({ repositoryRoot, files, expectedHead, receipt })
{
    if (typeof expectedHead !== 'string' || !/^[a-f0-9]{40}$/u.test(expectedHead))
    {
        throw new Error('blame-ignore receipt requires the independent candidate HEAD');
    }
    const expected = inspectBlameIgnoreSource({ repositoryRoot, files });
    if (expected.head !== expectedHead || !isDeepStrictEqual(receipt, expected))
    {
        throw new Error('blame-ignore receipt does not exactly bind the independent current source projection');
    }
    return expected;
}

function main(argv)
{
    let repositoryRoot;
    let language;
    const files = [];
    for (let index = 0; index < argv.length; index += 2)
    {
        const value = argv[index + 1];
        if (!value || !['--root', '--file', '--language'].includes(argv[index]))
        {
            throw new Error('solution checker accepts only --root and explicit --file pairs');
        }
        if (argv[index] === '--language')
        {
            if (language || !['python-ast', 'git-blame-ignore'].includes(value))
            {
                throw new Error('source checker accepts only one fixed python-ast or git-blame-ignore language mode');
            }
            language = value;
        }
        else if (argv[index] === '--root')
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
    console.log(JSON.stringify(language === 'git-blame-ignore'
        ? inspectBlameIgnoreSource({ repositoryRoot, files })
        : language === 'python-ast' ? inspectPythonSource({ repositoryRoot, files })
            : inspectSolutionSource({ repositoryRoot, files })));
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

export { bindFile as bindSourceFile, verifyFile as verifySourceFileBinding };
