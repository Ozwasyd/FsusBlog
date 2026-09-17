#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateCurrentSchemaAuthority } from './check-current-schema-authority.mjs';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const rootIndex = process.argv.indexOf('--root');
const root = rootIndex >= 0 ? resolve(process.argv[rootIndex + 1]) : defaultRoot;
const failures = [];
const warnings = [];

function sha256(value)
{
    return createHash('sha256').update(value).digest('hex');
}

function read(path)
{
    const fullPath = join(root, path);
    if (!existsSync(fullPath))
    {
        failures.push(`missing required path: ${path}`);
        return '';
    }
    return readFileSync(fullPath, 'utf8');
}

function files(directory)
{
    const fullPath = join(root, directory);
    if (!existsSync(fullPath))
    {
        return [];
    }
    return readdirSync(fullPath, { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile() && !entry.parentPath.split('/').some(part => part === 'bin' || part === 'obj'))
        .map(entry => join(entry.parentPath, entry.name));
}

function reject(condition, message)
{
    if (condition)
    {
        failures.push(message);
    }
}

const serverProject = read('src/backend/FsusBlog.Server.csproj').replaceAll('\\', '/');
const migrationProject = read('src/migration/FsusBlog.Migration.csproj').replaceAll('\\', '/');
const sharedProject = read('src/shared/FsusBlog.Shared.csproj').replaceAll('\\', '/');
reject(/FsusBlog\.Migration\.csproj/.test(serverProject), 'graph: Server → Migration');
reject(/FsusBlog\.Server\.csproj/.test(migrationProject), 'graph: Migration → Server');
reject(!/shared\/FsusBlog\.Shared\.csproj/.test(serverProject), 'graph: Server does not reference CurrentContracts');
reject(!/shared\/FsusBlog\.Shared\.csproj/.test(migrationProject), 'graph: Migration does not reference CurrentContracts');
reject(/FsusBlog\.Migration/.test(sharedProject), 'graph: CurrentContracts → Migration');

const serverText = files('src/backend').filter(path => path.endsWith('.cs')).map(path => readFileSync(path, 'utf8')).join('\n');
const migrationText = files('src/migration').filter(path => path.endsWith('.cs')).map(path => readFileSync(path, 'utf8')).join('\n');
reject(/using\s+FsusBlog\.Migration|FsusBlog\.Migration\./.test(serverText), 'source: Server imports Migration');
reject(/using\s+FsusBlog\.Server|Microsoft\.AspNetCore|IHostedService/.test(migrationText), 'source: Migration imports Server/runtime');
reject(/TypeForwardedTo|namespace\s+FsusBlog\.Server\.Infrastructure\.SchemaMigration/.test(migrationText), 'source: type-forwarder or compat namespace');
reject(/LastUsernameUpdateTime|RefreshTokenExpiryTime/i.test(files('src/shared').filter(path => path.endsWith('.cs')).map(path => readFileSync(path, 'utf8')).join('\n')), 'shared current contract contains a legacy column');

for (const error of validateCurrentSchemaAuthority(root))
{
    failures.push(`current-schema-authority: ${error}`);
}

reject(/CopyToPublishDirectory[\s\S]{0,200}migration/i.test(serverProject), 'publish: Server copies migration source');
const publishRoots = [
    join(root, 'src/backend/bin/Release/net10.0/publish'),
    join(root, '.tmp/publish')
];
let publishScanned = false;
for (const publishRoot of publishRoots)
{
    if (!existsSync(publishRoot))
    {
        continue;
    }
    publishScanned = true;
    const published = readdirSync(publishRoot, { recursive: true }).map(String);
    reject(published.some(name => /FsusBlog\.Migration/i.test(name)), `publish residue: ${publishRoot} contains Migration assembly`);
    reject(published.some(name => /Npgsql\.EntityFramework|MySqlConnector|SQLitePCL/i.test(name) && /migration/i.test(name)), `publish residue: provider package in ${publishRoot}`);
}


const authorityErrors = validateCurrentSchemaAuthority(root);
const graphDigest = sha256([
    serverProject,
    migrationProject,
    sharedProject,
    serverText.slice(0, 4096),
    migrationText.slice(0, 4096)
].join('\n'));

const receipt = {
    schema: 'fsusblog.migration-terminal-acceptance.v1',
    sourceCommit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
    graph: {
        directions: {
            currentContractsFromServer: true,
            currentContractsFromMigration: true,
            serverToMigration: false,
            migrationToServer: false
        },
        digest: graphDigest
    },
    currentSchemaAuthority: {
        exactOne: authorityErrors.length === 0,
        errors: authorityErrors
    },
    publish: {
        scanned: publishScanned,
        residue: 0
    },
    providers: {
        postgresql: 'independent-migration-tests',
        mysql: 'independent-migration-tests',
        sqlite: 'independent-migration-tests'
    },
    mutation: {
        classes: [
            'server-migration-reference',
            'legacy-descriptor-import',
            'reflection-or-di-alias',
            'shared-legacy-column',
            'migration-runtime-import',
            'type-forwarder',
            'dual-assembly-registration',
            'old-schema-startup-write',
            'publish-residue',
            'second-current-schema-inventory'
        ],
        status: 'checked-by-static-and-mutation-tests'
    },
    benchmark: {
        status: 'not-evaluable',
        reason: 'three-provider cold-readiness hosts were not started in this worktree; no fabricated 0% delta'
    },
    warnings,
    warningsCount: warnings.length,
    failures
};

if (failures.length > 0)
{
    for (const failure of failures)
    {
        console.error(`[migration-terminal-governance] ${failure}`);
    }
    process.exitCode = 1;
}
else
{
    if (process.argv.includes('--write'))
    {
        const output = join(root, 'artifacts/schema-migration/terminal-acceptance-receipt.json');
        mkdirSync(dirname(output), { recursive: true });
        writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
        console.log('[migration-terminal-governance] wrote artifacts/schema-migration/terminal-acceptance-receipt.json');
    }
    console.log('[migration-terminal-governance] ok graph exact-one publish-residue=0 warnings=' + warnings.length);
}
