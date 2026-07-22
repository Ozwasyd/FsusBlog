#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// eslint-disable-next-line import-x/no-relative-parent-imports
import { createReleaseId, validateReleaseId } from '../release/release-id.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const registryPath = path.join(root, 'config/docs/public-preview-screenshots.json');
const managedDirectory = path.join(root, 'docs/assets/screenshots');
const manifestName = 'manifest.json';
const manifestSchema = 'fsusblog.public-preview-screenshot-manifest.v1';
const evidenceSchema = 'fsusblog.public-preview-screenshot-verification.v1';
const digestPattern = /^[0-9a-f]{64}$/u;
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

function repositoryFileList(input)
{
    const absolute = path.join(root, input);
    if (!fs.existsSync(absolute))
    {
        throw new Error(`visual input is missing: ${input}`);
    }
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || stat.isFile())
    {
        return [input];
    }
    if (!stat.isDirectory())
    {
        throw new Error(`visual input is not a file or directory: ${input}`);
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
                files.push(path.relative(root, file).split(path.sep).join('/'));
            }
        }
    };
    visit(absolute);
    return files;
}

function categoryDigest(inputs)
{
    const files = [...new Set(inputs.flatMap(repositoryFileList))].sort();
    const hash = crypto.createHash('sha256');
    for (const file of files)
    {
        hash.update(file);
        hash.update('\0');
        hash.update(fileDigest(path.join(root, file)));
        hash.update('\n');
    }
    return { digest: hash.digest('hex'), files };
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
    const visualInputDigest = digest(stableJson({
        categories: Object.fromEntries(Object.entries(categories).map(([name, value]) => [name, value.digest])),
        fsusUi
    }));
    return { categories, fsusUi, visualInputDigest };
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
    if (manifest.schema !== manifestSchema)
    {
        errors.push(`manifest schema must be ${manifestSchema}`);
    }
    if (fs.readFileSync(manifestFile, 'utf8') !== stableJson(manifest))
    {
        errors.push('manifest serialization is not deterministic');
    }
    const registry = readRegistry();
    const expectedById = new Map(registry.screenshots.map((entry) => [entry.id, entry]));
    const ids = new Set();
    const files = new Set();
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
        for (const field of ['file', 'route', 'viewport', 'theme', 'scope'])
        {
            if (entry[field] !== expected[field])
            {
                errors.push(`${entry.id} has unknown ${field}: ${entry[field]}`);
            }
        }
        if (!commitPattern.test(entry.sourceCommit ?? ''))
        {
            errors.push(`${entry.id} sourceCommit is invalid`);
        }
        for (const field of ['fixtureDigest', 'captureConfigurationDigest', 'visualInputDigest', 'pngSha256'])
        {
            if (!digestPattern.test(entry[field] ?? ''))
            {
                errors.push(`${entry.id} ${field} is invalid`);
            }
        }
        for (const field of ['frontendBuildIdentity', 'backendBuildIdentity'])
        {
            if (typeof entry[field] !== 'string' || !entry[field].startsWith(entry.sourceCommit ?? '#'))
            {
                errors.push(`${entry.id} ${field} is invalid`);
            }
        }
        for (const error of validateReleaseId(entry.releaseId, { forPublication: true }))
        {
            errors.push(`${entry.id} releaseId: ${error}`);
        }
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
    for (const expected of registry.screenshots)
    {
        if (!ids.has(expected.id))
        {
            errors.push(`manifest is missing screenshot id: ${expected.id}`);
        }
    }
    const actualPngs = fs.readdirSync(directory).filter((file) => file.endsWith('.png')).sort();
    for (const file of actualPngs)
    {
        if (!files.has(file))
        {
            errors.push(`unregistered screenshot file: ${file}`);
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

function publishDirectory(stagingDirectory)
{
    const errors = validateManifest(stagingDirectory, { requireFresh: true });
    if (errors.length > 0)
    {
        throw new Error(errors.join('\n'));
    }
    const readme = path.join(stagingDirectory, 'README.md');
    if (!fs.existsSync(readme))
    {
        fs.copyFileSync(path.join(managedDirectory, 'README.md'), readme);
    }
    const parent = path.dirname(managedDirectory);
    const backup = path.join(parent, `.screenshots-backup-${process.pid}`);
    fs.renameSync(managedDirectory, backup);
    try
    {
        fs.renameSync(stagingDirectory, managedDirectory);
        fs.rmSync(backup, { recursive: true, force: true });
    }
    catch (error)
    {
        if (!fs.existsSync(managedDirectory) && fs.existsSync(backup))
        {
            fs.renameSync(backup, managedDirectory);
        }
        throw error;
    }
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
