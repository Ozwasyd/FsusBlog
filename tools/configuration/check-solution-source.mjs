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

// A finite declaration grammar, not an MSBuild evaluator. Only predefined XML
// escapes are decoded; custom/numeric entities and executable shapes refuse.
const projectXmlParser = String.raw`
import json, re, resource, sys
from xml.parsers import expat
resource.setrlimit(resource.RLIMIT_AS, (128 * 1024 * 1024, 128 * 1024 * 1024))
resource.setrlimit(resource.RLIMIT_CPU, (2, 2))
document = json.load(sys.stdin)
source = document["source"]
if re.search(r"&(?!amp;|lt;|gt;|apos;|quot;)", source):
    raise ValueError("project XML refuses custom or numeric entity aliases")
stack = []
root = None
nodes = 0
def refuse(*arguments):
    raise ValueError("project XML refuses DTD, entities, processing instructions, and CDATA")
def start(name, attributes):
    global root, nodes
    nodes += 1
    if nodes > 4096 or len(stack) >= 4:
        raise ValueError("project XML exceeds its bounded declaration structure")
    if ":" in name or any(":" in key or key == "xmlns" for key in attributes):
        raise ValueError("project XML namespaces are unsupported")
    node = {"name": name, "attributes": dict(attributes), "children": [], "text": ""}
    if stack:
        stack[-1]["children"].append(node)
    elif root is not None:
        raise ValueError("project XML requires one root")
    else:
        root = node
    stack.append(node)
def end(name):
    stack.pop()
def text(value):
    if stack:
        stack[-1]["text"] += value
    elif value.strip():
        raise ValueError("project XML refuses text outside the root")
def declaration(version, encoding, standalone):
    if version != "1.0" or encoding is not None and encoding.lower() != "utf-8":
        raise ValueError("project XML requires UTF-8 XML 1.0")
parser = expat.ParserCreate()
parser.StartElementHandler = start
parser.EndElementHandler = end
parser.CharacterDataHandler = text
parser.StartDoctypeDeclHandler = refuse
parser.EntityDeclHandler = refuse
parser.ExternalEntityRefHandler = refuse
parser.ProcessingInstructionHandler = refuse
parser.StartCdataSectionHandler = refuse
parser.XmlDeclHandler = declaration
parser.Parse(source, True)
if root is None or root["name"] != "Project" or set(root["attributes"]) != {"Sdk"}:
    raise ValueError("expected a Project root with one literal Sdk attribute")
if root["attributes"]["Sdk"] not in ("Microsoft.NET.Sdk", "Microsoft.NET.Sdk.Web"):
    raise ValueError("project XML requires a supported literal SDK name")
def container(node):
    if node["text"].strip():
        raise ValueError("project XML refuses container text")
def identifier(value):
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.-]*", value):
        raise ValueError("project XML requires literal declaration identifiers")
def opaque(value):
    if not value or re.search(r"[\x00-\x1f]", value):
        raise ValueError("project XML requires nonempty scalar declarations")
    literal = re.sub(r"\$\([A-Za-z_][A-Za-z0-9_]*\)", "", value)
    if any(token in literal for token in ("$(", "@(", "%(", "$[")):
        raise ValueError("project XML refuses property functions or item transforms")
container(root)
properties = []
packages = []
references = []
resources = []
metadata = []
property_names = {"TargetFramework", "RootNamespace", "AssemblyName", "OutputType", "ImplicitUsings",
    "Nullable", "AllowUnsafeBlocks", "IsPackable", "IsTestProject", "StartupObject",
    "GenerateDocumentationFile", "NoWarn", "IsRoslynComponent", "EnforceExtendedAnalyzerRules",
    "InvariantGlobalization"}
seen_properties = set()
seen_packages = set()
seen_metadata = set()
seen_resources = set()
for group in root["children"]:
    if group["name"] not in ("PropertyGroup", "ItemGroup") or group["attributes"]:
        raise ValueError("project XML supports only unconditional PropertyGroup and ItemGroup declarations")
    container(group)
    for item in group["children"]:
        name, attributes = item["name"], item["attributes"]
        if item["children"]:
            raise ValueError("project XML refuses nested item metadata or property structures")
        if group["name"] == "PropertyGroup":
            value = item["text"].strip()
            if name not in property_names or attributes or name in seen_properties:
                raise ValueError("project XML refuses unknown, attributed, or duplicate properties")
            opaque(value)
            if name == "TargetFramework" and not re.fullmatch(r"net[0-9]+\.[0-9]+", value):
                raise ValueError("project XML requires one literal TargetFramework")
            seen_properties.add(name)
            properties.append({"name": name, "value": value})
            continue
        container(item)
        if name == "PackageReference" and set(attributes) == {"Include"}:
            include = attributes["Include"]
            identifier(include)
            if include.lower() in seen_packages:
                raise ValueError("project XML refuses duplicate package declarations")
            seen_packages.add(include.lower())
            packages.append({"include": include})
        elif name == "ProjectReference" and set(attributes) == {"Include"}:
            references.append({"include": attributes["Include"]})
        elif name == "EmbeddedResource" and set(attributes) == {"Include", "LogicalName"}:
            identifier(attributes["LogicalName"])
            if attributes["LogicalName"] in seen_resources:
                raise ValueError("project XML refuses duplicate resource logical names")
            seen_resources.add(attributes["LogicalName"])
            resources.append({"include": attributes["Include"], "logicalName": attributes["LogicalName"]})
        elif name == "AssemblyMetadata" and set(attributes) == {"Include", "Value"}:
            identifier(attributes["Include"])
            opaque(attributes["Value"])
            if attributes["Include"] in seen_metadata:
                raise ValueError("project XML refuses duplicate assembly metadata")
            seen_metadata.add(attributes["Include"])
            metadata.append({"include": attributes["Include"], "value": attributes["Value"]})
        else:
            raise ValueError("project XML refuses unsupported items, attributes, or metadata")
if "TargetFramework" not in seen_properties:
    raise ValueError("project XML requires a literal TargetFramework declaration")
print(json.dumps({"status": "success", "executable": sys.executable, "version": sys.version,
    "project": {"sdk": root["attributes"]["Sdk"], "properties": properties, "packages": packages,
        "projectReferences": references, "embeddedResources": resources, "assemblyMetadata": metadata}}))
`;

const projectXmlLimits = Object.freeze({ ...pythonAstLimits, declarationNodes: 4096, declarationDepth: 4,
    outputBytes: 1024 * 1024 });

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

function bindFile(root, file, maximumBytes = null)
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

function projectInspectionContext(repositoryRoot, files)
{
    if (['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].some(key => process.env[key]))
    {
        throw new Error('project XML inspection refuses an ambient alternate Git repository or index');
    }
    const root = path.resolve(repositoryRoot);
    if (fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory())
    {
        throw new Error('project XML inspection requires the actual repository directory');
    }
    if (!Array.isArray(files) || !files.length || new Set(files).size !== files.length)
    {
        throw new Error('project XML inspection requires distinct explicit files');
    }
    files.forEach(file => normalizedPath(file, '.csproj'));
    return { root, head: git(root, ['rev-parse', 'HEAD']).toString('utf8').trim(),
        indexDigest: sha256(git(root, ['ls-files', '--stage', '-z'])), held: [], totalBytes: 0,
        parser: pythonIdentity(['/usr/bin']), version: null };
}

function bindProjectInput(context, file)
{
    const existing = context.held.find(value => value.binding.file === file);
    if (existing)
    {
        return existing;
    }
    const maximum = Math.min(projectXmlLimits.fileBytes, projectXmlLimits.batchBytes - context.totalBytes);
    const input = bindFile(context.root, file, maximum);
    context.held.push(input);
    context.totalBytes += input.bytes.length;
    return input;
}

function closedObject(value, keys)
{
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
}

function projectDeclarationShape(value)
{
    const lists = { properties: ['name', 'value'], packages: ['include'], projectReferences: ['include'],
        embeddedResources: ['include', 'logicalName'], assemblyMetadata: ['include', 'value'] };
    if (!closedObject(value, ['sdk', ...Object.keys(lists)])
        || !['Microsoft.NET.Sdk', 'Microsoft.NET.Sdk.Web'].includes(value.sdk))
    {
        return false;
    }
    return Object.entries(lists).every(([key, keys]) => Array.isArray(value[key])
        && value[key].length <= projectXmlLimits.declarationNodes
        && value[key].every(item => closedObject(item, keys)
            && keys.every(field => typeof item[field] === 'string' && item[field].length > 0)))
        && value.properties.some(item => item.name === 'TargetFramework' && /^net\d+\.\d+$/u.test(item.value));
}

function parseProjectDeclaration(context, input)
{
    const source = input.bytes.toString('utf8');
    if (!Buffer.from(source).equals(input.bytes))
    {
        throw new Error(`project XML source is not exact UTF-8: ${input.binding.file}`);
    }
    const result = spawnSync(context.parser.executable, ['-I', '-B', '-S', '-c', projectXmlParser],
        { input: JSON.stringify({ source }), encoding: 'utf8', maxBuffer: projectXmlLimits.outputBytes,
            timeout: projectXmlLimits.timeoutMs });
    if (result.error || result.status !== 0)
    {
        throw new Error(`project XML source refused: ${result.error?.message ?? result.stderr}`);
    }
    const parsed = JSON.parse(result.stdout);
    if (!closedObject(parsed, ['status', 'executable', 'version', 'project']) || parsed.status !== 'success'
        || parsed.executable !== context.parser.executable || typeof parsed.version !== 'string'
        || !/^3\.\d+\.\d+ /u.test(parsed.version) || !projectDeclarationShape(parsed.project)
        || (context.version !== null && context.version !== parsed.version))
    {
        throw new Error('project XML worker output does not bind the actual isolated declaration parser');
    }
    context.version = parsed.version;
    return parsed.project;
}

function literalProjectPath(projectFile, include, extension = '')
{
    const relative = include.replaceAll('\\', '/');
    if (relative.startsWith('/') || /[:*?$@%]/u.test(relative)
        || [...relative].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
        || relative.split('/').some(part => !part || part === '.'))
    {
        throw new Error('project XML input requires a literal relative source path');
    }
    const file = path.posix.normalize(path.posix.join(path.posix.dirname(projectFile), relative));
    if (file === '..' || file.startsWith('../') || file === projectFile)
    {
        throw new Error('project XML input path escapes the repository or references itself');
    }
    return normalizedPath(file, extension);
}

function bindProjectDeclarations(context, input, declaration)
{
    const paths = [...declaration.projectReferences.map(value => literalProjectPath(input.binding.file, value.include, '.csproj')),
        ...declaration.embeddedResources.map(value => literalProjectPath(input.binding.file, value.include))];
    if (new Set(paths).size !== paths.length)
    {
        throw new Error('project XML refuses duplicate or aliased source input paths');
    }
    const bindings = paths.map(file => bindProjectInput(context, file).binding);
    return { ...input.binding, declaration,
        projectReferences: bindings.slice(0, declaration.projectReferences.length),
        embeddedResources: bindings.slice(declaration.projectReferences.length) };
}

function verifyProjectContext(context)
{
    context.held.forEach(verifyFile);
    if (context.head !== git(context.root, ['rev-parse', 'HEAD']).toString('utf8').trim()
        || context.indexDigest !== sha256(git(context.root, ['ls-files', '--stage', '-z']))
        || !sameEpoch(context.parser.stat, fs.fstatSync(context.parser.descriptor, { bigint: true }))
        || !sameEpoch(context.parser.stat, fs.lstatSync(context.parser.executable, { bigint: true })))
    {
        throw new Error('project XML inspection HEAD/index or parser identity changed');
    }
    context.held.forEach(verifyFile);
}

/** Inspect finite SDK-style declarations and physical direct inputs; never evaluate MSBuild. */
export function inspectProjectSource({ repositoryRoot, files })
{
    const context = projectInspectionContext(repositoryRoot, files);
    try
    {
        const projects = files.map(file =>
        {
            const input = bindProjectInput(context, file);
            return bindProjectDeclarations(context, input, parseProjectDeclaration(context, input));
        });
        verifyProjectContext(context);
        return { schema: 'fsusblog.project-xml-source-check.v1', head: context.head, indexDigest: context.indexDigest,
            parser: { executable: context.parser.executable, sha256: context.parser.sha256,
                sourceSha256: sha256(projectXmlParser), version: context.version }, limits: { ...projectXmlLimits },
            projects, status: 'success', qualificationEligible: false };
    }
    finally
    {
        context.held.forEach(value => fs.closeSync(value.descriptor));
        fs.closeSync(context.parser.descriptor);
    }
}

/** Reopen every declared physical input before admitting the closed SOURCE receipt. */
export function validateProjectSourceReceipt({ repositoryRoot, files, expectedHead, receipt })
{
    if (typeof expectedHead !== 'string' || !/^[a-f0-9]{40}$/u.test(expectedHead))
    {
        throw new Error('project XML receipt requires the independent candidate HEAD');
    }
    const expected = inspectProjectSource({ repositoryRoot, files });
    if (expected.head !== expectedHead || !isDeepStrictEqual(receipt, expected))
    {
        throw new Error('project XML receipt does not exactly bind the independent current source projection');
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
            if (language || !['python-ast', 'project-xml'].includes(value))
            {
                throw new Error('source checker accepts only one fixed python-ast or project-xml language mode');
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
    const inspect = language === 'project-xml' ? inspectProjectSource
        : language === 'python-ast' ? inspectPythonSource : inspectSolutionSource;
    console.log(JSON.stringify(inspect({ repositoryRoot, files })));
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
