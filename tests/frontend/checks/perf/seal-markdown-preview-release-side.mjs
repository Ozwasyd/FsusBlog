#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { verifyProductionBuildReceipt } from '../../../../tools/ci/production-build-artifacts.mjs';
import { resolveWorktreeFingerprint } from '../../../../tools/fact-extractors/identity.mjs';
import { parseReleaseId, validateReleaseId } from '../../../../tools/release/release-id.mjs';

import {
    contentDigest,
    currentMachineIdentity,
    fileDigest,
    loadCorpus,
    loadSideManifest,
    sideManifestSchema
} from './markdown-preview-release-performance.mjs';

export const sideDeclarationSchema =
    'fsusblog.markdown-preview-release-performance-side-declaration.v1';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../..');
const frontendRoot = path.join(root, 'src/frontend');
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const gitObjectPattern = /^[a-f0-9]{40}$/u;
const identityHeaderAllowlist = new Set([
    'x-fsus-build-identity',
    'x-fsus-release-id'
]);

function fail(message)
{
    throw new Error(`seal-markdown-preview-release-side: ${message}`);
}

function requiredString(value, label)
{
    const normalized = String(value ?? '').trim();
    if (!normalized)
    {
        fail(`${label} is required`);
    }
    return normalized;
}

function releaseAuthority(runtime, sourceCommit)
{
    const releaseId = requiredString(runtime.releaseId, 'runtime.releaseId');
    const errors = validateReleaseId(releaseId, { forPublication: true });
    if (errors.length > 0)
    {
        fail(`runtime.releaseId violates the canonical contract: ${errors.join(', ')}`);
    }
    const parsed = parseReleaseId(releaseId);
    if (!parsed || !sourceCommit.startsWith(parsed.commitShaPrefix))
    {
        fail('runtime.releaseId commit prefix does not match the side source commit');
    }
    if (requiredString(runtime.buildIdentity, 'runtime.buildIdentity') !== releaseId)
    {
        fail('runtime.buildIdentity must equal runtime.releaseId');
    }
    return releaseId;
}

function exactObject(value, keys, label)
{
    if (!value || typeof value !== 'object' || Array.isArray(value))
    {
        fail(`${label} must be an object`);
    }
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected))
    {
        fail(`${label} exact schema mismatch; expected ${expected.join(', ')}, received ${actual.join(', ')}`);
    }
}

function absoluteWithoutSymlinks(value, label, kind)
{
    const absolute = requiredString(value, label);
    if (!path.isAbsolute(absolute) || path.resolve(absolute) !== absolute)
    {
        fail(`${label} must be an explicit canonical absolute path`);
    }
    const parsed = path.parse(absolute);
    let current = parsed.root;
    for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean))
    {
        current = path.join(current, segment);
        if (!fs.existsSync(current))
        {
            fail(`${label} is missing: ${absolute}`);
        }
        if (fs.lstatSync(current).isSymbolicLink())
        {
            fail(`${label} contains a symlink: ${absolute}`);
        }
    }
    const stat = fs.lstatSync(absolute);
    if ((kind === 'file' && !stat.isFile()) || (kind === 'directory' && !stat.isDirectory()))
    {
        fail(`${label} must be a ${kind}`);
    }
    if (fs.realpathSync(absolute) !== absolute)
    {
        fail(`${label} realpath changed`);
    }
    return absolute;
}

function containedFile(container, relative, label)
{
    const normalized = requiredString(relative, label).replaceAll('\\', '/');
    if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../'))
    {
        fail(`${label} must be relative and contained`);
    }
    const absolute = path.resolve(container, normalized);
    if (!absolute.startsWith(`${container}${path.sep}`))
    {
        fail(`${label} escapes its container`);
    }
    return absoluteWithoutSymlinks(absolute, label, 'file');
}

function git(repositoryRoot, args, label)
{
    const result = spawnSync('git', ['-C', repositoryRoot, ...args], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024
    });
    if (result.status !== 0)
    {
        fail(`${label} failed: ${String(result.stderr ?? '').trim()}`);
    }
    return String(result.stdout ?? '').trim();
}

function sourceAuthority(repositoryRoot)
{
    const sourceRoot = absoluteWithoutSymlinks(repositoryRoot, 'sourceRoot', 'directory');
    const commit = git(sourceRoot, ['rev-parse', 'HEAD'], 'source commit resolution');
    const tree = git(sourceRoot, ['rev-parse', 'HEAD^{tree}'], 'source tree resolution');
    if (!gitObjectPattern.test(commit) || !gitObjectPattern.test(tree))
    {
        fail('source commit/tree must be full lowercase Git object identities');
    }
    if (git(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all'], 'source clean check'))
    {
        fail('source checkout must be clean');
    }
    return {
        repositoryRoot: sourceRoot,
        commit,
        tree,
        canonicalWorktreeFingerprint: resolveWorktreeFingerprint(sourceRoot)
    };
}

function validateBaseUrl(value, label)
{
    const raw = requiredString(value, label);
    let url;
    try
    {
        url = new URL(raw);
    }
    catch
    {
        fail(`${label} must be an absolute URL`);
    }
    if (!['http:', 'https:'].includes(url.protocol)
      || url.username || url.password || url.search || url.hash
      || url.pathname !== '/' || raw !== url.origin)
    {
        fail(`${label} must be a canonical credential-free HTTP(S) origin`);
    }
    return url.origin;
}

function validateRoute(value, baseUrl, label)
{
    const route = requiredString(value, label);
    if (!route.startsWith('/') || route.startsWith('//') || route.includes('?') || route.includes('#'))
    {
        fail(`${label} must be a query-free root-relative route`);
    }
    const resolved = new URL(route, `${baseUrl}/`);
    if (resolved.origin !== baseUrl || resolved.pathname !== route)
    {
        fail(`${label} must remain on the static origin and use a canonical path`);
    }
    return route;
}

function validateProbeUrl(value, backendBaseUrl)
{
    const raw = requiredString(value, 'runtime.identityProbe.url');
    let url;
    try
    {
        url = new URL(raw);
    }
    catch
    {
        fail('runtime.identityProbe.url must be absolute');
    }
    if (url.origin !== backendBaseUrl || url.pathname === '/' || url.search || url.hash
      || url.username || url.password || raw !== `${url.origin}${url.pathname}`)
    {
        fail('runtime.identityProbe.url must be canonical, credential-free, and on the backend origin');
    }
    return raw;
}

function validateDeclaration(value)
{
    exactObject(value, [
        'fixture',
        'productionBuild',
        'runtime',
        'schema',
        'side',
        'sourceRoot'
    ], 'side declaration');
    exactObject(
        value.productionBuild,
        ['artifactRoot', 'receiptContentDigest', 'receiptPath'],
        'side declaration.productionBuild'
    );
    exactObject(value.runtime, [
        'backendBaseUrl',
        'backendKind',
        'buildIdentity',
        'identityProbe',
        'mode',
        'releaseId',
        'routes',
        'staticBaseUrl',
        'staticServerKind'
    ], 'side declaration.runtime');
    exactObject(value.runtime.routes, ['about', 'adminWrite', 'article'], 'side declaration.runtime.routes');
    exactObject(
        value.runtime.identityProbe,
        ['headerNames', 'status', 'url'],
        'side declaration.runtime.identityProbe'
    );
    exactObject(value.fixture, [
        'adminStorageStatePath',
        'contentDigest',
        'identity',
        'namespace',
        'profile',
        'root',
        'topology'
    ], 'side declaration.fixture');
    if (value.schema !== sideDeclarationSchema)
    {
        fail('side declaration schema mismatch');
    }
    if (!['base', 'candidate'].includes(value.side))
    {
        fail('side declaration side must be base or candidate');
    }
}

function domainDigest(receipt, name)
{
    const domain = receipt.domains.find((entry) => entry.name === name);
    if (!domain)
    {
        fail(`production receipt is missing ${name} domain`);
    }
    const records = receipt.artifacts
        .filter((entry) => entry.path === domain.path || entry.path.startsWith(`${domain.path}/`))
        .map((entry) => ({ path: entry.path, size: entry.size, sha256: entry.sha256 }))
        .sort((left, right) => left.path.localeCompare(right.path));
    if (records.length !== domain.fileCount)
    {
        fail(`${name} domain artifact count mismatch`);
    }
    return {
        path: domain.path,
        digest: `sha256:${createHash('sha256').update(JSON.stringify(records)).digest('hex')}`
    };
}

function artifact(receipt, artifactPath, label)
{
    const record = receipt.artifacts.find((entry) => entry.path === artifactPath);
    if (!record)
    {
        fail(`${label} is not owned by the production receipt`);
    }
    return { path: record.path, digest: record.sha256 };
}

async function managedBrowserVersion()
{
    const require = createRequire(import.meta.url);
    const playwrightModule = require.resolve('@playwright/test', { paths: [frontendRoot] });
    const playwright = require(playwrightModule);
    const browser = await playwright.chromium.launch({ headless: true });
    try
    {
        return browser.version();
    }
    finally
    {
        await browser.close();
    }
}

function readDeclaration(file)
{
    const absolute = absoluteWithoutSymlinks(file, 'side declaration', 'file');
    let value;
    try
    {
        value = JSON.parse(fs.readFileSync(absolute, 'utf8'));
    }
    catch (error)
    {
        fail(`side declaration is not valid JSON: ${error.message}`);
    }
    validateDeclaration(value);
    return value;
}

function prepareOutput(outputFile)
{
    const output = requiredString(outputFile, 'output');
    if (!path.isAbsolute(output) || path.resolve(output) !== output)
    {
        fail('output must be an explicit canonical absolute path');
    }
    if (fs.existsSync(output) || fs.lstatSync(path.dirname(output)).isSymbolicLink())
    {
        fail('output already exists or its parent is a symlink');
    }
    absoluteWithoutSymlinks(path.dirname(output), 'output parent', 'directory');
    return output;
}

export async function sealSideManifest({
    declarationFile,
    outputFile,
    fetchImpl = fetch,
    resolveBrowserVersion = managedBrowserVersion
})
{
    const declaration = readDeclaration(declarationFile);
    const output = prepareOutput(outputFile);
    const source = sourceAuthority(declaration.sourceRoot);
    const artifactRoot = absoluteWithoutSymlinks(
        declaration.productionBuild.artifactRoot,
        'productionBuild.artifactRoot',
        'directory'
    );
    const receiptFile = containedFile(
        artifactRoot,
        declaration.productionBuild.receiptPath,
        'productionBuild.receiptPath'
    );
    const expectedReceiptDigest = requiredString(
        declaration.productionBuild.receiptContentDigest,
        'productionBuild.receiptContentDigest'
    );
    if (!digestPattern.test(expectedReceiptDigest))
    {
        fail('productionBuild.receiptContentDigest must be a sha256 digest');
    }
    const receiptValue = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    const receiptFingerprint = requiredString(
        receiptValue.sourceState?.worktreeFingerprint,
        'production receipt worktree fingerprint'
    );
    if (receiptFingerprint.replace(/^sha256:/u, '') !== source.canonicalWorktreeFingerprint)
    {
        fail('production receipt worktree fingerprint does not match the canonical clean checkout');
    }
    const verified = verifyProductionBuildReceipt({
        artifactRoot,
        receiptFile: path.relative(artifactRoot, receiptFile).replaceAll(path.sep, '/'),
        expectedSourceState: {
            commit: source.commit,
            worktreeFingerprint: receiptFingerprint
        },
        expectedReceiptDigest,
        repairReadOnlySeal: false
    });
    if (verified.receipt.build?.profile !== 'production-release-fresh')
    {
        fail('production receipt is not production-release-fresh');
    }

    const frontendDist = domainDigest(verified.receipt, 'frontend-dist');
    const ssrEntry = artifact(
        verified.receipt,
        `${frontendDist.path}/server/public-ssr.mjs`,
        'SSR entry'
    );
    const clientEntry = artifact(
        verified.receipt,
        `${frontendDist.path}/index.html`,
        'client entry'
    );

    const runtime = declaration.runtime;
    const staticBaseUrl = validateBaseUrl(runtime.staticBaseUrl, 'runtime.staticBaseUrl');
    const backendBaseUrl = validateBaseUrl(runtime.backendBaseUrl, 'runtime.backendBaseUrl');
    const releaseId = releaseAuthority(runtime, source.commit);
    for (const route of ['article', 'about', 'adminWrite'])
    {
        validateRoute(runtime.routes[route], staticBaseUrl, `runtime.routes.${route}`);
    }
    const probeUrl = validateProbeUrl(runtime.identityProbe.url, backendBaseUrl);
    if (!Number.isInteger(runtime.identityProbe.status)
      || runtime.identityProbe.status < 100 || runtime.identityProbe.status > 599)
    {
        fail('runtime.identityProbe.status is invalid');
    }
    if (!Array.isArray(runtime.identityProbe.headerNames)
      || runtime.identityProbe.headerNames.length === 0
      || new Set(runtime.identityProbe.headerNames).size !== runtime.identityProbe.headerNames.length)
    {
        fail('runtime.identityProbe.headerNames must be a non-empty unique array');
    }
    for (const name of runtime.identityProbe.headerNames)
    {
        if (name !== String(name).toLowerCase() || !identityHeaderAllowlist.has(name))
        {
            fail(`runtime.identityProbe.headerNames contains non-identity header ${String(name)}`);
        }
    }
    if (!runtime.identityProbe.headerNames.includes('x-fsus-release-id'))
    {
        fail('runtime.identityProbe.headerNames must include x-fsus-release-id');
    }
    const response = await fetchImpl(probeUrl, {
        method: 'GET',
        cache: 'no-store',
        redirect: 'error'
    });
    if (response.status !== runtime.identityProbe.status)
    {
        fail(`runtime identity probe status mismatch: ${response.status}`);
    }
    const responseBody = Buffer.from(await response.arrayBuffer());
    const identityHeaders = Object.fromEntries(runtime.identityProbe.headerNames.map((name) =>
    {
        const value = requiredString(response.headers.get(name), `runtime identity response header ${name}`);
        if (/[\r\n]/u.test(value))
        {
            fail(`runtime identity response header ${name} contains a line break`);
        }
        return [name, value];
    }));
    if (identityHeaders['x-fsus-release-id'] !== releaseId)
    {
        fail('runtime identity response x-fsus-release-id does not match runtime.releaseId');
    }

    const fixture = declaration.fixture;
    if (fixture.profile !== 'acceptance-representative')
    {
        fail('fixture.profile must be acceptance-representative');
    }
    const corpus = loadCorpus();
    if (fixture.contentDigest !== corpus.contentDigest)
    {
        fail('fixture.contentDigest does not bind the canonical performance corpus');
    }
    const fixtureRoot = absoluteWithoutSymlinks(fixture.root, 'fixture.root', 'directory');
    const storageState = containedFile(
        fixtureRoot,
        fixture.adminStorageStatePath,
        'fixture.adminStorageStatePath'
    );
    const browserVersion = requiredString(await resolveBrowserVersion(), 'managed browser version');

    const manifest = {
        schema: sideManifestSchema,
        side: declaration.side,
        source: {
            repositoryRoot: source.repositoryRoot,
            commit: source.commit,
            tree: source.tree,
            worktreeFingerprint: receiptFingerprint,
            clean: true
        },
        productionBuild: {
            artifactRoot,
            receiptPath: path.relative(artifactRoot, receiptFile).replaceAll(path.sep, '/'),
            receiptContentDigest: verified.receipt.contentDigest
        },
        artifacts: {
            frontendDist,
            ssrEntry,
            clientEntry
        },
        runtime: {
            mode: runtime.mode,
            staticServerKind: runtime.staticServerKind,
            backendKind: runtime.backendKind,
            staticBaseUrl,
            backendBaseUrl,
            releaseId,
            buildIdentity: releaseId,
            routes: runtime.routes,
            identityProbe: {
                url: probeUrl,
                method: 'GET',
                status: response.status,
                responseDigest: `sha256:${createHash('sha256').update(responseBody).digest('hex')}`,
                headers: identityHeaders
            }
        },
        fixture: {
            profile: fixture.profile,
            identity: requiredString(fixture.identity, 'fixture.identity'),
            namespace: requiredString(fixture.namespace, 'fixture.namespace'),
            topology: requiredString(fixture.topology, 'fixture.topology'),
            contentDigest: fixture.contentDigest,
            root: fixtureRoot,
            adminStorageState: {
                path: path.relative(fixtureRoot, storageState).replaceAll(path.sep, '/'),
                digest: fileDigest(storageState)
            }
        },
        machine: currentMachineIdentity(),
        toolchain: {
            node: requiredString(verified.receipt.toolchain.node, 'receipt toolchain.node'),
            playwright: requiredString(verified.receipt.toolchain.playwright, 'receipt toolchain.playwright'),
            dotnet: requiredString(verified.receipt.toolchain.dotnet, 'receipt toolchain.dotnet'),
            browser: browserVersion
        },
        contentDigest: null
    };
    manifest.contentDigest = contentDigest(manifest);

    const temporary = `${output}.next-${process.pid}`;
    try
    {
        fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o444 });
        fs.renameSync(temporary, output);
        fs.chmodSync(output, 0o444);
        loadSideManifest(output, declaration.side);
    }
    catch (error)
    {
        if (fs.existsSync(temporary))
        {
            fs.unlinkSync(temporary);
        }
        if (fs.existsSync(output))
        {
            fs.chmodSync(output, 0o600);
            fs.unlinkSync(output);
        }
        throw error;
    }
    return { manifest, output, manifestDigest: fileDigest(output) };
}

function parseOptions(args)
{
    if (args.length !== 4 || args[0] !== '--declaration' || args[2] !== '--output')
    {
        fail('usage: --declaration ABSOLUTE_JSON --output ABSOLUTE_SIDE_MANIFEST');
    }
    return { declarationFile: args[1], outputFile: args[3] };
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain)
{
    try
    {
        const result = await sealSideManifest(parseOptions(process.argv.slice(2)));
        console.log(`[seal-markdown-preview-release-side] wrote ${result.output} digest=${result.manifestDigest}`);
    }
    catch (error)
    {
        console.error(`[seal-markdown-preview-release-side] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}
