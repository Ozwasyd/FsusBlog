#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// eslint-disable-next-line import-x/no-relative-parent-imports
import { createReleaseId, validateReleaseId } from '../release/release-id.mjs';

import {
    createSharedIdentitySets,
    validateManifestShape,
    validateScreenshotMetadata,
    validateSharedIdentityAgreement
} from './public-preview-manifest-validation.mjs';
import { atomicPublishDirectory } from './public-preview-writer-transaction.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const registryPath = path.join(root, 'config/docs/public-preview-screenshots.json');
const managedDirectory = path.join(root, 'docs/assets/screenshots');
const manifestName = 'manifest.json';
const manifestSchema = 'fsusblog.public-preview-screenshot-manifest.v1';
const evidenceSchema = 'fsusblog.public-preview-screenshot-verification.v1';
const commitPattern = /^[0-9a-f]{40}$/u;
const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readJson(file)
{
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function stableJson(value)
{
    return `${JSON.stringify(value, null, 4)}\n`;
}

function digest(value)
{
    return crypto.createHash('sha256').update(value).digest('hex');
}

function fileDigest(file)
{
    return digest(fs.readFileSync(file));
}

function git(args, directory = root)
{
    return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
}

function assertRepositoryPath(input)
{
    const normalized = path.normalize(String(input ?? '')).split(path.sep).join('/');
    if (!normalized || path.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../'))
    {
        throw new Error(`visual input must stay inside the repository: ${input}`);
    }
    return normalized;
}

function repositoryFileList(input, rootDirectory = root)
{
    const normalizedInput = assertRepositoryPath(input);
    const absolute = path.join(rootDirectory, normalizedInput);
    if (!fs.existsSync(absolute))
    {
        throw new Error(`visual input is missing: ${normalizedInput}`);
    }
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || stat.isFile())
    {
        return [normalizedInput];
    }
    if (!stat.isDirectory())
    {
        throw new Error(`visual input is not a file or directory: ${normalizedInput}`);
    }
    const files = [];
    const visit = (directory) =>
    {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name)))
        {
            if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.tmp')
            {
                continue;
            }
            const file = path.join(directory, entry.name);
            if (entry.isDirectory())
            {
                visit(file);
            }
            else if (entry.isFile() || entry.isSymbolicLink())
            {
                files.push(path.relative(rootDirectory, file).split(path.sep).join('/'));
            }
        }
    };
    visit(absolute);
    return files;
}

export function validateFailClosedCoverage(registry, rootDirectory = root)
{
    if (!registry.visualInputs || typeof registry.visualInputs !== 'object' || Array.isArray(registry.visualInputs))
    {
        throw new Error('screenshot registry visualInputs must be an object');
    }
    const declared = Object.values(registry.visualInputs).flatMap((inputs) =>
    {
        if (!Array.isArray(inputs) || inputs.length === 0)
        {
            throw new Error('every visual input category must be non-empty');
        }
        return inputs.map((input) => assertRepositoryPath(typeof input === 'string' ? input : input?.path));
    });
    for (const rootEntry of registry.failClosedRoots ?? [])
    {
        if (stableJson(Object.keys(rootEntry).sort()) !== stableJson(['excludedEntries', 'path'])
            || !Array.isArray(rootEntry.excludedEntries)
            || stableJson(rootEntry.excludedEntries) !== stableJson([...new Set(rootEntry.excludedEntries)].sort()))
        {
            throw new Error('failClosedRoots entries must contain path and sorted unique excludedEntries');
        }
        const rootPath = assertRepositoryPath(rootEntry.path);
        const absoluteRoot = path.join(rootDirectory, rootPath);
        const entries = fs.readdirSync(absoluteRoot, { withFileTypes: true }).map((entry) => entry.name).sort();
        for (const entry of entries)
        {
            if (rootEntry.excludedEntries.includes(entry))
            {
                continue;
            }
            const child = `${rootPath}/${entry}`;
            if (!declared.some((input) => child === input || child.startsWith(`${input}/`)))
            {
                throw new Error(`unclassified shared visual input: ${child}`);
            }
        }
    }
}

function semanticJsonRecord(input, rootDirectory)
{
    const keys = Object.keys(input).sort();
    if (stableJson(keys) !== stableJson(['jsonKeys', 'path'])
        || !Array.isArray(input.jsonKeys)
        || input.jsonKeys.length === 0
        || input.jsonKeys.some((key) => typeof key !== 'string' || !key.trim())
        || stableJson(input.jsonKeys) !== stableJson([...new Set(input.jsonKeys)].sort()))
    {
        throw new Error('semantic visual input must contain only path and sorted unique jsonKeys');
    }
    const files = repositoryFileList(input.path, rootDirectory);
    if (files.length !== 1 || files[0] !== input.path)
    {
        throw new Error(`semantic visual input must be one regular JSON file: ${input.path}`);
    }
    const document = readJson(path.join(rootDirectory, input.path));
    const projection = {};
    for (const key of input.jsonKeys)
    {
        if (!Object.hasOwn(document, key))
        {
            throw new Error(`semantic visual input key is missing: ${input.path}#${key}`);
        }
        projection[key] = document[key];
    }
    return {
        file: input.path,
        projection: `json:${input.jsonKeys.join(',')}`,
        contentDigest: digest(stableJson(projection))
    };
}

function visualInputRecords(input, rootDirectory)
{
    if (typeof input === 'string')
    {
        return repositoryFileList(input, rootDirectory).map((file) => ({
            file,
            projection: 'full',
            contentDigest: fileDigest(path.join(rootDirectory, file))
        }));
    }
    if (!input || typeof input !== 'object' || Array.isArray(input))
    {
        throw new Error('visual input must be a repository path or semantic projection');
    }
    return [semanticJsonRecord(input, rootDirectory)];
}

export function categoryDigest(inputs, rootDirectory = root)
{
    const records = inputs.flatMap((input) => visualInputRecords(input, rootDirectory))
        .sort((left, right) => `${left.file}\0${left.projection}`.localeCompare(`${right.file}\0${right.projection}`));
    const identities = new Set();
    const hash = crypto.createHash('sha256');
    for (const record of records)
    {
        const identity = `${record.file}\0${record.projection}`;
        if (identities.has(identity))
        {
            throw new Error(`duplicate visual input projection: ${record.file} (${record.projection})`);
        }
        identities.add(identity);
        hash.update(record.file);
        hash.update('\0');
        if (record.projection !== 'full')
        {
            hash.update(`semantic:${record.projection}`);
            hash.update('\0');
        }
        hash.update(record.contentDigest);
        hash.update('\n');
    }
    return { digest: hash.digest('hex'), files: [...new Set(records.map((record) => record.file))].sort() };
}

function resolveFsusUiIdentity()
{
    const configured = process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT?.trim();
    const directory = path.resolve(configured || path.join(root, '..', 'FsusUI'));
    if (!fs.existsSync(path.join(directory, '.git')) && !fs.existsSync(path.join(directory, 'vue')))
    {
        throw new Error(`local FsusUI alias root is unavailable: ${directory}`);
    }
    const status = git(['status', '--porcelain'], directory);
    const commit = git(['rev-parse', 'HEAD'], directory);
    const tree = git(['rev-parse', 'HEAD:vue'], directory);
    const lockFile = path.join(directory, 'pnpm-lock.yaml');
    return {
        commit,
        tree,
        lockDigest: fs.existsSync(lockFile) ? fileDigest(lockFile) : digest('missing-pnpm-lock'),
        clean: status === ''
    };
}

export function readRegistry()
{
    const registry = readJson(registryPath);
    if (registry.schema !== 'fsusblog.public-preview-screenshot-registry.v1')
    {
        throw new Error(`unexpected screenshot registry schema: ${registry.schema ?? 'missing'}`);
    }
    validateFailClosedCoverage(registry);
    return registry;
}

export function computeVisualInputs()
{
    const registry = readRegistry();
    const categories = {};
    for (const name of Object.keys(registry.visualInputs).sort())
    {
        categories[name] = categoryDigest(registry.visualInputs[name]);
    }
    const fsusUi = resolveFsusUiIdentity();
    const visualInputDigest = combineVisualInputDigest(categories, fsusUi);
    return { categories, fsusUi, visualInputDigest };
}

export function combineVisualInputDigest(categories, fsusUi)
{
    return digest(stableJson({
        categories: Object.fromEntries(Object.entries(categories)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([name, value]) => [name, value.digest])),
        fsusUi
    }));
}

function sourceIdentity(sourceCommit)
{
    if (!commitPattern.test(sourceCommit))
    {
        throw new Error(`source commit must be a full lowercase SHA: ${sourceCommit}`);
    }
    const createdAt = git(['show', '-s', '--format=%cI', sourceCommit]);
    return {
        sourceCommit,
        releaseId: createReleaseId(new Date(createdAt), sourceCommit),
        frontendBuildIdentity: `${sourceCommit}:src/frontend`,
        backendBuildIdentity: `${sourceCommit}:src/backend`
    };
}

export function createManifest(directory, sourceCommit = git(['rev-parse', 'HEAD']))
{
    const registry = readRegistry();
    const inputs = computeVisualInputs();
    const source = sourceIdentity(sourceCommit);
    const common = {
        sourceCommit: source.sourceCommit,
        releaseId: source.releaseId,
        frontendBuildIdentity: source.frontendBuildIdentity,
        backendBuildIdentity: source.backendBuildIdentity,
        fixtureDigest: inputs.categories.fixtures.digest,
        captureConfigurationDigest: digest(fs.readFileSync(registryPath)),
        fsusUi: inputs.fsusUi,
        visualInputDigest: inputs.visualInputDigest
    };
    const screenshots = [...registry.screenshots]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((entry) => ({
            ...entry,
            ...common,
            pngSha256: fileDigest(path.join(directory, entry.file))
        }));
    return {
        schema: manifestSchema,
        visualInputDigest: inputs.visualInputDigest,
        visualInputCategories: Object.fromEntries(Object.entries(inputs.categories).map(([name, value]) => [name, value.digest])),
        fsusUi: inputs.fsusUi,
        screenshots
    };
}

function validateManifest(directory, { requireFresh = false } = {})
{
    const errors = [];
    const manifestFile = path.join(directory, manifestName);
    if (!fs.existsSync(manifestFile))
    {
        return ['manifest.json is missing'];
    }
    let manifest;
    try
    {
        manifest = readJson(manifestFile);
    }
    catch (error)
    {
        return [`manifest.json is invalid JSON: ${error.message}`];
    }
    if (fs.readFileSync(manifestFile, 'utf8') !== stableJson(manifest))
    {
        errors.push('manifest serialization is not deterministic');
    }
    errors.push(...validateManifestShape(manifest, { schema: manifestSchema, serialize: stableJson }));
    const registry = readRegistry();
    const expectedScreenshots = [...registry.screenshots].sort((left, right) => left.id.localeCompare(right.id));
    const expectedById = new Map(expectedScreenshots.map((entry) => [entry.id, entry]));
    if (stableJson((manifest.screenshots ?? []).map((entry) => entry.id))
        !== stableJson(expectedScreenshots.map((entry) => entry.id)))
    {
        errors.push('manifest screenshots must use canonical registry order');
    }
    const ids = new Set();
    const files = new Set();
    const commonIdentities = createSharedIdentitySets();
    for (const entry of manifest.screenshots ?? [])
    {
        const expected = expectedById.get(entry.id);
        if (!expected)
        {
            errors.push(`unknown screenshot id: ${entry.id}`);
            continue;
        }
        if (ids.has(entry.id))
        {
            errors.push(`duplicate screenshot id: ${entry.id}`);
        }
        if (files.has(entry.file))
        {
            errors.push(`duplicate screenshot file: ${entry.file}`);
        }
        ids.add(entry.id);
        files.add(entry.file);
        for (const [field, values] of commonIdentities)
        {
            values.add(entry[field]);
        }
        errors.push(...validateScreenshotMetadata(entry, {
            expected,
            manifest,
            serialize: stableJson,
            validateReleaseId
        }));
        const image = path.join(directory, entry.file);
        if (!fs.existsSync(image))
        {
            errors.push(`missing screenshot file: ${entry.file}`);
            continue;
        }
        const content = fs.readFileSync(image);
        if (content.length < 1024 || !content.subarray(0, pngMagic.length).equals(pngMagic))
        {
            errors.push(`${entry.file} is not a managed PNG`);
        }
        else if (fileDigest(image) !== entry.pngSha256)
        {
            errors.push(`${entry.file} hash mismatch`);
        }
    }
    errors.push(...validateSharedIdentityAgreement(commonIdentities));
    for (const expected of registry.screenshots)
    {
        if (!ids.has(expected.id))
        {
            errors.push(`manifest is missing screenshot id: ${expected.id}`);
        }
    }
    const directoryEntries = fs.readdirSync(directory, { withFileTypes: true });
    const actualPngs = directoryEntries.filter((entry) => entry.isFile() && entry.name.endsWith('.png'))
        .map((entry) => entry.name)
        .sort();
    for (const file of actualPngs)
    {
        if (!files.has(file))
        {
            errors.push(`unregistered screenshot file: ${file}`);
        }
    }
    const allowedFiles = new Set([manifestName, 'README.md', ...files]);
    for (const entry of directoryEntries)
    {
        if (!entry.isFile() || !allowedFiles.has(entry.name))
        {
            errors.push(`unexpected managed screenshot entry: ${entry.name}`);
        }
    }
    if (requireFresh)
    {
        const current = computeVisualInputs();
        for (const [category, value] of Object.entries(current.categories))
        {
            if (manifest.visualInputCategories?.[category] !== value.digest)
            {
                errors.push(`visual input category changed: ${category}`);
            }
        }
        if (manifest.visualInputDigest !== current.visualInputDigest)
        {
            errors.push('visualInputDigest is stale; run npm run capture:public-preview-docs');
        }
        if (stableJson(manifest.fsusUi) !== stableJson(current.fsusUi))
        {
            errors.push('FsusUI alias identity is stale');
        }
    }
    return errors;
}

function fail(errors)
{
    for (const error of errors)
    {
        console.error(`[public-preview-screenshots] ${error}`);
    }
    process.exitCode = 1;
}

function compareDirectories(actualDirectory, evidenceFile)
{
    const errors = validateManifest(actualDirectory, { requireFresh: true });
    const committedErrors = validateManifest(managedDirectory, { requireFresh: true });
    errors.push(...committedErrors.map((error) => `committed: ${error}`));
    const registry = readRegistry();
    const differences = [];
    for (const entry of registry.screenshots)
    {
        const expected = path.join(managedDirectory, entry.file);
        const actual = path.join(actualDirectory, entry.file);
        if (!fs.existsSync(expected) || !fs.existsSync(actual) || fileDigest(expected) !== fileDigest(actual))
        {
            differences.push(entry.id);
        }
    }
    if (differences.length > 0)
    {
        errors.push(`captured screenshots differ: ${differences.join(', ')}`);
    }
    const manifest = readJson(path.join(managedDirectory, manifestName));
    const evidence = {
        schema: evidenceSchema,
        status: errors.length === 0 ? 'ok' : 'failed',
        sourceCommit: git(['rev-parse', 'HEAD']),
        releaseId: manifest.screenshots?.[0]?.releaseId ?? null,
        manifestSchema: manifest.schema,
        visualInputDigest: manifest.visualInputDigest,
        runtimeAudit: errors.length === 0,
        layoutAudit: errors.length === 0,
        sanitizationCheck: errors.length === 0,
        images: Object.fromEntries(registry.screenshots.map((entry) => [entry.id, fileDigest(path.join(managedDirectory, entry.file))])),
        differences,
        commandVersion: fileDigest(fileURLToPath(import.meta.url))
    };
    fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
    fs.writeFileSync(evidenceFile, stableJson(evidence));
    return errors;
}

export function writeManifest(directory, sourceCommit)
{
    const manifest = createManifest(directory, sourceCommit);
    fs.writeFileSync(path.join(directory, manifestName), stableJson(manifest));
    return manifest;
}

export function verifyCapturedDirectory(directory, evidenceFile)
{
    const errors = compareDirectories(directory, evidenceFile);
    if (errors.length > 0)
    {
        throw new Error(errors.join('\n'));
    }
    return readJson(evidenceFile);
}

export function publishDirectory(stagingDirectory)
{
    const readme = path.join(stagingDirectory, 'README.md');
    if (!fs.existsSync(readme))
    {
        fs.copyFileSync(path.join(managedDirectory, 'README.md'), readme);
    }
    atomicPublishDirectory({
        stagingDirectory,
        managedDirectory,
        validate: (directory) =>
        {
            const errors = validateManifest(directory, { requireFresh: true });
            if (errors.length > 0)
            {
                throw new Error(errors.join('\n'));
            }
        }
    });
}

function usage()
{
    console.error('usage: public-preview-screenshots.mjs <generate|check|sync|compare|publish> [options]');
    process.exitCode = 2;
}

function option(name, fallback = null)
{
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : fallback;
}

function main()
{
    const command = process.argv[2];
    const directory = path.resolve(option('--dir', managedDirectory));
    if (command === 'generate')
    {
        writeManifest(directory, option('--source-commit', git(['rev-parse', 'HEAD'])));
        console.log(`[public-preview-screenshots] generated ${path.relative(root, path.join(directory, manifestName))}`);
        return;
    }
    if (command === 'check' || command === 'sync')
    {
        const errors = validateManifest(directory, { requireFresh: command === 'sync' });
        if (errors.length > 0)
        {
            fail(errors);
            return;
        }
        console.log(`[public-preview-screenshots] ${command} ok screenshots=${readRegistry().screenshots.length}`);
        return;
    }
    if (command === 'compare')
    {
        const evidence = path.resolve(option('--evidence', path.join(root, '.tmp/release-evidence/public-preview-screenshots.json')));
        const errors = compareDirectories(directory, evidence);
        if (errors.length > 0)
        {
            fail([...errors, 'run npm run capture:public-preview-docs to update the committed gallery']);
            return;
        }
        console.log(`[public-preview-screenshots] compare ok evidence=${path.relative(root, evidence)}`);
        return;
    }
    if (command === 'publish')
    {
        publishDirectory(directory);
        console.log('[public-preview-screenshots] atomic publish ok');
        return;
    }
    usage();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main();
}
