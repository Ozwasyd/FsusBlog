import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { isNodeTestFile } = await import(pathToFileURL(path.join(root, 'tools/test-lifecycle/lifecycle.mjs')).href);
const { loadCanonicalInventory } = await import(pathToFileURL(path.join(root, 'tools/test-inventory/api.mjs')).href);
const { extractTestRecords } = await import(pathToFileURL(path.join(root, 'tools/test-retention/audit.mjs')).href);
const inventoryPath = 'tests/test-asset-semantic-renames.json';
const issuePrefix = /(?:^|[/_.-])issue[-_]?[0-9]+(?:[-_][0-9]+)?(?:[/_.-]|$)|Issue[0-9]+/u;

function filesBelow(relativeDirectory)
{
    const files = [];
    const visit = (directory) =>
    {
        for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true }))
        {
            const relative = path.posix.join(directory, entry.name);
            if (entry.isDirectory())
            {
                visit(relative);
            }
            else
            {
                files.push(relative);
            }
        }
    };
    visit(relativeDirectory);
    return files.sort();
}

function identityViolations(value, location = '$')
{
    if (Array.isArray(value))
    {
        return value.flatMap((entry, index) => identityViolations(entry, `${location}[${index}]`));
    }
    if (!value || typeof value !== 'object')
    {
        return [];
    }
    return Object.entries(value).flatMap(([key, entry]) =>
    {
        const child = `${location}.${key}`;
        const own = /(?:schema|id)$/iu.test(key) && typeof entry === 'string' && issuePrefix.test(entry)
            ? [`${child}=${entry}`]
            : [];
        return [...own, ...identityViolations(entry, child)];
    });
}

test('semantic rename inventory resolves every historical test asset to one live path', () =>
{
    const inventory = JSON.parse(fs.readFileSync(path.join(root, inventoryPath), 'utf8'));
    assert.equal(inventory.schema, 'fsusblog.test-asset-semantic-renames.v1');
    assert.ok(inventory.renames.length > 0);
    assert.equal(new Set(inventory.renames.map(({ from }) => from)).size, inventory.renames.length);
    assert.equal(new Set(inventory.renames.map(({ to }) => to)).size, inventory.renames.length);
    for (const { from, to } of inventory.renames)
    {
        assert.match(from, issuePrefix);
        assert.doesNotMatch(to, issuePrefix);
        assert.equal(fs.existsSync(path.join(root, from)), false, `${from} must not remain as an alias`);
        assert.equal(fs.existsSync(path.join(root, to)), true, `${to} must resolve to a live asset`);
    }
});

test('active test paths and executable test IDs use domain semantics', () =>
{
    const files = filesBelow('tests');
    const inventory = loadCanonicalInventory(root);
    const activePaths = files.filter((file) => ![
        'tests/test-asset-semantic-renames.json',
        'tests/test-asset-lifecycle-retirement-baseline.json',
        'tests/test-governance-modernization-baseline.json',
        'tests/test-retention-before.json',
        'tests/test-retention-replacements.json'
    ].includes(file));
    assert.deepEqual(activePaths.filter((file) => issuePrefix.test(file)), []);

    const records = activePaths
        .filter(isNodeTestFile)
        .flatMap((file) => extractTestRecords(
            file,
            fs.readFileSync(path.join(root, file), 'utf8'),
            inventory
        ));
    assert.deepEqual(records.filter(({ id }) => issuePrefix.test(id)).map(({ id }) => id), []);
});

test('current repository references resolve renamed test assets without aliases', () =>
{
    const inventory = JSON.parse(fs.readFileSync(path.join(root, inventoryPath), 'utf8'));
    const excluded = new Set([
        inventoryPath,
        'tests/test-asset-lifecycle-retirement-baseline.json',
        'tests/test-retention-before.json',
        'tests/test-retention-replacements.json'
    ]);
    const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], {
        cwd: root,
        encoding: 'utf8'
    }).split(/\r?\n/u).filter(Boolean)
        .filter((file) => !excluded.has(file) && !file.startsWith('docs/archive/'))
        .filter((file) => fs.existsSync(path.join(root, file)));
    const oldPaths = new Set(inventory.renames.map(({ from }) => from));
    const violations = [];
    for (const file of files)
    {
        const bytes = fs.readFileSync(path.join(root, file));
        if (bytes.includes(0))
        {
            continue;
        }
        const source = bytes.toString('utf8');
        for (const oldPath of oldPaths)
        {
            if (source.includes(oldPath))
            {
                violations.push(`${file}: ${oldPath}`);
            }
        }
    }
    assert.deepEqual(violations, []);
});

test('renamed JSON schemas and evidence identities use domain semantics', () =>
{
    const inventory = JSON.parse(fs.readFileSync(path.join(root, inventoryPath), 'utf8'));
    const violations = inventory.renames
        .map(({ to }) => to)
        .filter((file) => file.endsWith('.json'))
        .flatMap((file) => identityViolations(JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')))
            .map((violation) => `${file}:${violation}`));
    assert.deepEqual(violations, []);
});
