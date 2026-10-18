#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { devNull } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

// SOURCE inspection only. These are the original central-package and standalone
// Migration conventions at 066ae14a5, plus #4640's two reviewed dependency edits.
// No .props/.csproj extension-wide support, SDK evaluation or import execution.
export const msbuildSourceFiles = Object.freeze([
    'Directory.Packages.props', 'src/migration/FsusBlog.Migration.csproj'
]);
export const msbuildSourceLimits = Object.freeze({ fileBytes: 64 * 1024, batchBytes: 512 * 1024,
    fileCount: 7, elements: 128, depth: 4, addressSpaceBytes: 128 * 1024 * 1024,
    cpuSeconds: 2, timeoutMs: 10_000, outputBytes: 64 * 1024 });

const packageVersions = Object.freeze({
    "AngleSharp": "1.5.0",
    "BCrypt.Net-Next": "4.1.0",
    "BenchmarkDotNet": "0.15.8",
    "BouncyCastle.Cryptography": "2.6.2",
    "coverlet.collector": "6.0.4",
    "Fido2": "4.0.1",
    "Jint": "4.13.0",
    "Konscious.Security.Cryptography.Argon2": "1.3.1",
    "Markdig": "1.3.2",
    "MessagePack": "2.5.301",
    "Microsoft.AspNetCore.Authentication.JwtBearer": "10.0.7",
    "Microsoft.AspNetCore.OpenApi": "10.0.9",
    "Microsoft.AspNetCore.TestHost": "10.0.7",
    "Microsoft.CodeAnalysis.Analyzers": "3.11.0",
    "Microsoft.CodeAnalysis.CSharp": "4.14.0",
    "Microsoft.Data.Sqlite": "10.0.4",
    "Microsoft.Extensions.ApiDescription.Server": "10.0.7",
    "Microsoft.Extensions.Configuration.Abstractions": "10.0.7",
    "Microsoft.Extensions.DependencyInjection.Abstractions": "10.0.7",
    "Microsoft.IdentityModel.Protocols": "8.2.0",
    "Microsoft.IdentityModel.Protocols.OpenIdConnect": "8.2.0",
    "Microsoft.NET.Test.Sdk": "18.5.1",
    "Microsoft.OpenApi": "2.7.5",
    "Microsoft.VisualStudio.Azure.Containers.Tools.Targets": "1.23.0",
    "MySqlConnector": "2.6.2",
    "Nethermind.MclBindings": "1.0.5",
    "Npgsql": "10.0.3",
    "Npgsql.OpenTelemetry": "10.0.2",
    "NSubstitute": "5.3.0",
    "OpenTelemetry.Exporter.OpenTelemetryProtocol": "1.15.3",
    "OpenTelemetry.Extensions.Hosting": "1.15.3",
    "OpenTelemetry.Instrumentation.AspNetCore": "1.15.2",
    "OpenTelemetry.Instrumentation.Http": "1.15.1",
    "OpenTelemetry.Instrumentation.Runtime": "1.15.1",
    "Serilog": "4.3.1",
    "Serilog.AspNetCore": "10.0.0",
    "Serilog.Sinks.Async": "2.1.0",
    "Serilog.Sinks.Console": "6.1.1",
    "Serilog.Sinks.File": "7.0.0",
    "SQLitePCLRaw.lib.e_sqlite3": "3.53.3",
    "SqlSugarCoreNoDrive": "5.1.4.213",
    "StackExchange.Redis": "2.7.27",
    "System.IdentityModel.Tokens.Jwt": "8.2.0",
    "xunit": "2.9.3",
    "xunit.extensibility.execution": "2.9.3",
    "xunit.runner.visualstudio": "3.1.5",
    "xunit.v3.runner.utility": "3.2.2"
});
const resourcePaths = Object.freeze([
    'tools/ci/migration-retained-inputs.mjs', 'tools/ci/production-build-artifacts.mjs',
    'tools/fact-extractors/identity.mjs', 'tools/fact-extractors/lib/canonicalize.mjs'
]);
const projectPath = msbuildSourceFiles[1];
const sharedPath = 'src/shared/FsusBlog.Shared.csproj';

// Expat is a real XML parser; all document-provided capabilities are denied before
// parsing. The one original source-commit macro is compared as inert text only.
// The isolated worker gets held UTF-8 bytes, never a source pathname or task code.
const xmlParser = String.raw`
import json, resource, sys
from xml.parsers import expat
resource.setrlimit(resource.RLIMIT_AS, (128 * 1024 * 1024, 128 * 1024 * 1024))
resource.setrlimit(resource.RLIMIT_CPU, (2, 2))
document = json.load(sys.stdin)
source = document["source"]
if "&" in source:
    raise ValueError("entity references and expansion are unsupported")
stack = []
roots = []
count = 0
def refuse(*arguments):
    raise ValueError("DTD, entities, CDATA and processing instructions are unsupported")
def start(name, attributes):
    global count
    count += 1
    if count > 128 or len(stack) >= 4:
        raise ValueError("XML structure exceeds bounds")
    node = {"name": name, "attributes": attributes, "children": [], "text": ""}
    if stack:
        stack[-1]["children"].append(node)
    else:
        roots.append(node)
    stack.append(node)
def end(name):
    stack.pop()
def text(value):
    if stack:
        stack[-1]["text"] += value
    elif value.strip(" \t\r\n"):
        raise ValueError("text outside root")
parser = expat.ParserCreate()
parser.StartElementHandler = start
parser.EndElementHandler = end
parser.CharacterDataHandler = text
parser.StartDoctypeDeclHandler = refuse
parser.EntityDeclHandler = refuse
parser.ExternalEntityRefHandler = refuse
parser.ProcessingInstructionHandler = refuse
parser.StartCdataSectionHandler = refuse
parser.XmlDeclHandler = refuse
parser.Parse(source, True)
if len(roots) != 1 or stack:
    raise ValueError("expected exactly one XML root")
print(json.dumps(roots[0]))
`;

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const epochKeys = ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
const sameEpoch = (before, after) => epochKeys.every(key => before[key] === after[key]);

function git(root, args)
{
    return execFileSync('git', ['--no-replace-objects', '-C', root, ...args], {
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: devNull },
        timeout: 10_000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function assertContext(root)
{
    if (['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
        'GIT_REPLACE_REF_BASE', 'GIT_GRAFT_FILE', 'GIT_CONFIG_COUNT'].some(key => Object.hasOwn(process.env, key)))
    {
        throw new Error('MSBuild source refuses an ambient alternate Git or history context');
    }
    if (fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory()
        || git(root, ['rev-parse', '--show-toplevel']).toString().trim() !== root
        || git(root, ['for-each-ref', '--format=%(refname)', 'refs/replace/']).toString().trim())
    {
        throw new Error('MSBuild source requires the actual repository without replacement refs');
    }
    const common = path.resolve(root, git(root, ['rev-parse', '--git-common-dir']).toString().trim());
    if (fs.existsSync(path.join(common, 'info/grafts')))
    {
        throw new Error('MSBuild source refuses repository graft history');
    }
}

function bindFile(root, file, remainingBytes)
{
    const absolute = path.join(root, file);
    let current = root;
    const ancestors = [{ path: root, stat: fs.lstatSync(root, { bigint: true }) }];
    for (const part of file.split('/').slice(0, -1))
    {
        current = path.join(current, part);
        const stat = fs.lstatSync(current, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink())
        {
            throw new Error(`MSBuild source refuses linked or non-directory ancestors: ${file}`);
        }
        ancestors.push({ path: current, stat });
    }
    // NONBLOCK ensures that a named FIFO cannot hang before fstat admission.
    const descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try
    {
        const before = fs.fstatSync(descriptor, { bigint: true });
        const maximum = Math.min(msbuildSourceLimits.fileBytes, remainingBytes);
        if (!before.isFile() || before.nlink !== 1n || !sameEpoch(before, fs.lstatSync(absolute, { bigint: true }))
            || before.size > BigInt(maximum))
        {
            throw new Error(`MSBuild source requires a bounded regular single-link file: ${file}`);
        }
        const buffer = Buffer.alloc(maximum + 1);
        let length = 0;
        while (length <= maximum)
        {
            const count = fs.readSync(descriptor, buffer, length, buffer.length - length, null);
            if (!count)
            {
                break;
            }
            length += count;
        }
        if (length > maximum || BigInt(length) !== before.size)
        {
            throw new Error(`MSBuild source input exceeds bounds or drifted: ${file}`);
        }
        const bytes = buffer.subarray(0, length);
        const index = git(root, ['ls-files', '--stage', '-z', '--', `:(literal)${file}`]).toString();
        const match = index.match(/^100644 ([a-f0-9]{40}) 0\t([^\0]+)\0$/u);
        if (!match || match[2] !== file || (before.mode & 0o111n) !== 0n
            || git(root, ['cat-file', '-s', match[1]]).toString().trim() !== String(length)
            || !git(root, ['cat-file', 'blob', match[1]]).equals(bytes)
            || git(root, ['ls-tree', '-z', 'HEAD', '--', file]).toString() !== `100644 blob ${match[1]}\t${file}\0`)
        {
            throw new Error(`MSBuild source HEAD/index/physical bytes or mode disagree: ${file}`);
        }
        return { descriptor, absolute, before, ancestors, bytes, binding: {
            file, mode: '100644', blob: match[1], bytes: length, sha256: sha256(bytes),
            epoch: Object.fromEntries(epochKeys.map(key => [key, before[key].toString()])) } };
    }
    catch (error)
    {
        fs.closeSync(descriptor);
        throw error;
    }
}

function verifyHeld(held)
{
    if (!sameEpoch(held.before, fs.fstatSync(held.descriptor, { bigint: true }))
        || !sameEpoch(held.before, fs.lstatSync(held.absolute, { bigint: true }))
        || held.ancestors.some(value => !sameEpoch(value.stat, fs.lstatSync(value.path, { bigint: true }))))
    {
        throw new Error(`MSBuild source physical identity changed: ${held.binding.file}`);
    }
}

function parseXml(held, parser)
{
    const source = held.bytes.toString('utf8');
    if (!Buffer.from(source).equals(held.bytes) || source.startsWith('\uFEFF'))
    {
        throw new Error('MSBuild source requires exact UTF-8 without encoding aliases');
    }
    const result = spawnSync(parser.absolute, ['-I', '-B', '-S', '-c', xmlParser], {
        input: JSON.stringify({ source }), encoding: 'utf8', timeout: msbuildSourceLimits.timeoutMs,
        maxBuffer: msbuildSourceLimits.outputBytes,
        env: { PATH: '/usr/bin:/bin', LC_ALL: 'C.UTF-8' }, cwd: '/' });
    if (result.error || result.status !== 0)
    {
        throw new Error(`MSBuild XML refused: ${result.error?.message ?? result.stderr}`);
    }
    return JSON.parse(result.stdout);
}

function element(node, name, attributes, text = '')
{
    // XML 1.0 S is only space, tab, CR and LF. JavaScript trim also erases
    // non-XML characters such as U+FEFF, hiding unsupported literal content.
    if (node?.name !== name || !isDeepStrictEqual(node.attributes, attributes)
        || node.text.replace(/^[\t\n\r ]+|[\t\n\r ]+$/gu, '') !== text)
    {
        throw new Error(`unsupported MSBuild construct or value: expected ${name}`);
    }
}

function leaf(node, name, attributes, text = '')
{
    element(node, name, attributes, text);
    if (node.children.length)
    {
        throw new Error(`unsupported nested MSBuild construct: ${name}`);
    }
}

function inspectPackages(tree)
{
    element(tree, 'Project', {});
    if (tree.children.length !== 2)
    {
        throw new Error('unsupported central package group boundary');
    }
    const [properties, items] = tree.children;
    element(properties, 'PropertyGroup', {});
    if (properties.children.length !== 1)
    {
        throw new Error('unsupported central package properties');
    }
    leaf(properties.children[0], 'ManagePackageVersionsCentrally', {}, 'true');
    element(items, 'ItemGroup', {});
    const seen = new Set();
    for (const item of items.children)
    {
        const { Include, Version } = item.attributes;
        const expected = Object.hasOwn(packageVersions, Include) ? packageVersions[Include] : null;
        if (!expected || seen.has(Include.toLowerCase())
            || !(Version === expected || (Include === 'MessagePack' && Version === '2.5.307')))
        {
            throw new Error('unsupported or duplicate central package identity/version');
        }
        leaf(item, 'PackageVersion', { Include, Version });
        seen.add(Include.toLowerCase());
    }
    if (seen.size !== Object.keys(packageVersions).length)
    {
        throw new Error('central package roster is incomplete');
    }
    return items.children.map(item => ({ id: item.attributes.Include, version: item.attributes.Version }));
}

function inspectProject(tree, packages)
{
    element(tree, 'Project', { Sdk: 'Microsoft.NET.Sdk' });
    if (tree.children.length !== 4)
    {
        throw new Error('unsupported Migration project group boundary');
    }
    const [properties, packageItems, references, metadata] = tree.children;
    element(properties, 'PropertyGroup', {});
    const expected = { TargetFramework: 'net10.0', RootNamespace: 'FsusBlog.Migration',
        AssemblyName: 'FsusBlog.Migration', OutputType: 'Exe', ImplicitUsings: 'enable' };
    if (properties.children.length !== Object.keys(expected).length)
    {
        throw new Error('unsupported Migration property roster');
    }
    const seenProperties = new Set();
    for (const property of properties.children)
    {
        if (!Object.hasOwn(expected, property.name) || seenProperties.has(property.name))
        {
            throw new Error('unsupported or duplicate Migration property');
        }
        leaf(property, property.name, {}, expected[property.name]);
        seenProperties.add(property.name);
    }
    element(packageItems, 'ItemGroup', {});
    const required = ['AngleSharp', 'Markdig', 'Microsoft.Data.Sqlite', 'MySqlConnector', 'Npgsql', 'SqlSugarCoreNoDrive'];
    const seen = new Set();
    const packageReferences = packageItems.children.map(item =>
    {
        const id = item.attributes.Include;
        if ((!required.includes(id) && id !== 'SQLitePCLRaw.lib.e_sqlite3') || seen.has(id)
            || !packages.some(value => value.id === id))
        {
            throw new Error('unsupported Migration package boundary');
        }
        leaf(item, 'PackageReference', { Include: id });
        seen.add(id);
        return id;
    });
    if (required.some(id => !seen.has(id)))
    {
        throw new Error('Migration package roster is incomplete');
    }
    element(references, 'ItemGroup', {});
    if (references.children.length !== 1)
    {
        throw new Error('unsupported Migration project reference boundary');
    }
    leaf(references.children[0], 'ProjectReference', { Include: '..\\shared\\FsusBlog.Shared.csproj' });
    element(metadata, 'ItemGroup', {});
    if (metadata.children.length !== 5)
    {
        throw new Error('unsupported Migration metadata/resource boundary');
    }
    leaf(metadata.children[0], 'AssemblyMetadata', { Include: 'FsusBlog.SourceCommit', Value: '$(FsusBlogCommitSha)' });
    resourcePaths.forEach((file, index) => leaf(metadata.children[index + 1], 'EmbeddedResource', {
        Include: `../../${file}`, LogicalName: `FsusBlog.Migration.RetainedReader.${file.replaceAll('/', '.')}` }));
    return { packageReferences, projectReferences: [sharedPath], embeddedResources: [...resourcePaths],
        inertSourceCommitMacro: '$(FsusBlogCommitSha)' };
}

/** Inspect only the original finite declarative contract; referenced bytes are witnesses, never executable inputs. */
export function inspectMsbuildSource({ repositoryRoot, files })
{
    const root = path.resolve(repositoryRoot);
    assertContext(root);
    if (!Array.isArray(files) || !files.length || files.length > 2 || new Set(files).size !== files.length
        || files.some(file => !msbuildSourceFiles.includes(file)))
    {
        throw new Error('MSBuild source requires distinct explicit original inputs');
    }
    const head = git(root, ['rev-parse', 'HEAD']).toString().trim();
    const indexDigest = sha256(git(root, ['ls-files', '--stage', '-z']));
    const held = [];
    const parserPath = fs.realpathSync('/usr/bin/python3');
    const descriptor = fs.openSync(parserPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const parser = { descriptor, absolute: parserPath, before: fs.fstatSync(descriptor, { bigint: true }), ancestors: [],
        binding: { file: parserPath } };
    try
    {
        if (!parser.before.isFile() || parser.before.nlink !== 1n)
        {
            throw new Error('MSBuild XML parser requires a regular single-link system interpreter');
        }
        const parserDigest = sha256(fs.readFileSync(descriptor));
        let totalBytes = 0;
        const bind = file =>
        {
            const input = bindFile(root, file, msbuildSourceLimits.batchBytes - totalBytes);
            held.push(input);
            totalBytes += input.bytes.length;
            return input;
        };
        // The central authority is inspected even when only the project changed.
        const central = bind(msbuildSourceFiles[0]);
        const packages = inspectPackages(parseXml(central, parser));
        const inspections = new Map([[msbuildSourceFiles[0], { ...central.binding, packages }]]);
        if (files.includes(projectPath))
        {
            const project = bind(projectPath);
            const projection = inspectProject(parseXml(project, parser), packages);
            for (const file of [sharedPath, ...resourcePaths])
            {
                bind(file);
            }
            inspections.set(projectPath, { ...project.binding, ...projection });
        }
        if (held.length > msbuildSourceLimits.fileCount)
        {
            throw new Error('MSBuild source witness count exceeds bounds');
        }
        held.forEach(verifyHeld);
        verifyHeld(parser);
        assertContext(root);
        if (head !== git(root, ['rev-parse', 'HEAD']).toString().trim()
            || indexDigest !== sha256(git(root, ['ls-files', '--stage', '-z'])))
        {
            throw new Error('MSBuild source HEAD or index drifted');
        }
        held.forEach(verifyHeld);
        return { schema: 'fsusblog.msbuild-source-check.v1', head, indexDigest,
            contract: 'original-central-packages-and-migration-v1', limits: { ...msbuildSourceLimits },
            parser: { executable: parserPath, sha256: parserDigest, sourceSha256: sha256(xmlParser) },
            sources: files.map(file => inspections.get(file)), witnesses: held.map(value => value.binding),
            status: 'success', qualificationEligible: false,
            boundary: 'declarations only; no import, SDK, restore, task, build, runtime or dependency qualification' };
    }
    finally
    {
        held.forEach(value => fs.closeSync(value.descriptor));
        fs.closeSync(descriptor);
    }
}

/** Reopen and reparse every original input and witness before dispatch can count it. */
export function validateMsbuildSourceReceipt({ repositoryRoot, files, expectedHead, receipt })
{
    if (typeof expectedHead !== 'string' || !/^[a-f0-9]{40}$/u.test(expectedHead))
    {
        throw new Error('MSBuild receipt requires the independent exact HEAD');
    }
    const expected = inspectMsbuildSource({ repositoryRoot, files });
    if (expected.head !== expectedHead || !isDeepStrictEqual(receipt, expected))
    {
        throw new Error('MSBuild receipt does not exactly bind independently reopened current inputs');
    }
    return expected;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        const args = process.argv.slice(2);
        if (args[0] !== '--root' || !args[1] || args.length < 4 || args.length % 2
            || args.slice(2).some((value, index) => index % 2 === 0 && value !== '--file'))
        {
            throw new Error('usage: msbuild-source-inspector.mjs --root ROOT --file ORIGINAL [--file ORIGINAL]');
        }
        console.log(JSON.stringify(inspectMsbuildSource({ repositoryRoot: args[1],
            files: args.slice(3).filter((value, index) => index % 2 === 0) })));
    }
    catch (error)
    {
        console.error(`[msbuild-source] ${error.message}`);
        process.exitCode = 1;
    }
}
