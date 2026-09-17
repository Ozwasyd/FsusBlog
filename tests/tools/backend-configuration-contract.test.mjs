import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    checkBackendConfigurationContract,
    renderBackendConfigurationReference
} from '../../tools/configuration/check-backend-configuration-contract.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const contractRelative = 'config/application/backend-configuration-contract.json';

function readContract(root = repositoryRoot)
{
    return JSON.parse(fs.readFileSync(path.join(root, contractRelative), 'utf8'));
}

function write(root, relative, source)
{
    const destination = path.join(root, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, source);
}

function copy(root, relative)
{
    const source = path.join(repositoryRoot, relative);
    const destination = path.join(root, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, { recursive: true });
}

function createFixture(context)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-backend-configuration-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const contract = readContract();
    copy(root, contractRelative);
    for (const relative of [
        ...contract.sourceInventory.appsettings,
        ...contract.sourceInventory.environmentExamples,
        ...contract.sourceInventory.compose,
        ...contract.sourceInventory.deploymentScriptRoots,
        contract.authorities.generatedReference
    ])
    {
        copy(root, relative);
    }
    for (const owner of Object.values(contract.owners))
    {
        for (const relative of [owner.documentation, owner.consumer])
        {
            const source = path.join(repositoryRoot, relative);
            const destination = path.join(root, relative);
            if (fs.statSync(source).isDirectory())
            {
                fs.mkdirSync(destination, { recursive: true });
            }
            else
            {
                write(root, relative, '');
            }
        }
    }
    for (const entry of contract.applicationSettings ?? [])
    {
        for (const relative of [entry.documentation, entry.consumer].filter(Boolean))
        {
            const source = path.join(repositoryRoot, relative);
            const destination = path.join(root, relative);
            if (!fs.existsSync(source))
            {
                write(root, relative, '');
                continue;
            }
            if (fs.statSync(source).isDirectory())
            {
                fs.mkdirSync(destination, { recursive: true });
            }
            else
            {
                write(root, relative, '');
            }
        }
    }
    return { root, contract };
}

function saveContract(root, contract)
{
    write(root, contractRelative, `${JSON.stringify(contract, null, 2)}\n`);
}

test('canonical contract inventories settings, environment inputs, mounted files, and emits a JSON report', (context) =>
{
    const canonical = checkBackendConfigurationContract({ root: repositoryRoot });
    assert.deepEqual(canonical.errors, []);
    assert.equal(canonical.report.status, 'ok');
    assert.equal(canonical.report.counts.applicationSettings, 228);
    assert.equal(canonical.report.counts.environmentVariables, 242);
    assert.equal(canonical.report.counts.mountedFiles, 4);
    assert.match(canonical.generatedReference, /not an input template/u);

    const { root } = createFixture(context);
    const reportPath = '.tmp/configuration/focused-report.json';
    const execution = childProcess.spawnSync(
        process.execPath,
        [
            path.join(repositoryRoot, 'tools/configuration/check-backend-configuration-contract.mjs'),
            '--root',
            root,
            '--report-json',
            reportPath
        ],
        { encoding: 'utf8' });
    assert.equal(execution.status, 0, `${execution.stdout}\n${execution.stderr}`);
    const report = JSON.parse(fs.readFileSync(path.join(root, reportPath), 'utf8'));
    assert.equal(report.schema, 'fsusblog.backend-configuration-drift-report.v1');
    assert.equal(report.status, 'ok');
    assert.deepEqual(report.errors, []);
});

test('one scan reports a missing variable classification, stale alias, and usable tracked secret', (context) =>
{
    const { root } = createFixture(context);
    fs.appendFileSync(path.join(root, 'config/examples/.env.production.example'), '\nUNDECLARED_DEPLOYMENT_CONTROL=1\n');
    const composePath = path.join(root, 'ops/docker/docker-compose.production.yml');
    fs.writeFileSync(
        composePath,
        fs.readFileSync(composePath, 'utf8').replace(
            'RedisOptions__Configuration=',
            'Redis__Configuration='));
    const productionPath = path.join(root, 'src/backend/appsettings.Production.json');
    fs.writeFileSync(
        productionPath,
        fs.readFileSync(productionPath, 'utf8').replace(
            '"SecretKey": ""',
            '"SecretKey": "usable-production-secret-must-never-be-tracked"'));

    const result = checkBackendConfigurationContract({ root });
    assert.ok(result.errors.some(error => error.includes('unclassified tracked environment variable UNDECLARED_DEPLOYMENT_CONTROL')));
    assert.ok(result.errors.some(error => error.includes('retired configuration alias Redis:Configuration')));
    assert.ok(result.errors.some(error => error.includes('usable tracked secret value is forbidden for Jwt:SecretKey')));
});

test('environment scope and duplicate authority drift are rejected together', (context) =>
{
    const { root, contract } = createFixture(context);
    const development = contract.applicationSettings.find(entry => entry.key === 'fsus:allowLocalAuthFixture');
    development.environments = ['Production'];
    contract.applicationSettings.push({ ...contract.applicationSettings.find(entry => entry.key === 'Jwt:Issuer') });
    saveContract(root, contract);

    const result = checkBackendConfigurationContract({ root });
    assert.ok(result.errors.some(error => error.includes('wrong environment scope') && error.includes('fsus:allowLocalAuthFixture')));
    assert.ok(result.errors.some(error => error.includes('duplicate configuration authority for Jwt:Issuer')));
});

test('required production settings cannot lose startup validation or become optional', (context) =>
{
    const { root, contract } = createFixture(context);
    const jwtSecret = contract.applicationSettings.find(entry => entry.key === 'Jwt:SecretKey');
    jwtSecret.requiredStatus = 'conditional';
    jwtSecret.requiredWhen = 'optional';
    jwtSecret.validation = { kind: 'consumer', owner: 'authentication runtime validator' };
    saveContract(root, contract);

    const result = checkBackendConfigurationContract({ root });
    assert.ok(result.errors.some(error => error.includes('contradictory requiredness') && error.includes('Jwt:SecretKey')));
});

test('environment aliases and retired replacements remain bidirectional contract edges', (context) =>
{
    const { root, contract } = createFixture(context);
    const jwtSecret = contract.applicationSettings.find(entry => entry.key === 'Jwt:SecretKey');
    jwtSecret.environmentVariables = ['RedisOptions__Configuration'];
    contract.retiredAliases.find(entry => entry.key === 'Redis:Configuration').replacement = 'RedisOptions:Missing';
    saveContract(root, contract);

    const result = checkBackendConfigurationContract({ root });
    assert.ok(result.errors.some(error => error.includes('Jwt:SecretKey and environment variable RedisOptions__Configuration have asymmetric mapping')));
    assert.ok(result.errors.some(error => error.includes('retired alias Redis:Configuration has unknown replacement RedisOptions:Missing')));
});

test('new tracked configuration sources cannot bypass the contract inventory', (context) =>
{
    const { root } = createFixture(context);
    write(root, 'ops/docker/docker-compose.shadow.yml', 'services: {}\n');

    const result = checkBackendConfigurationContract({ root });
    assert.ok(result.errors.some(error => error.includes('sourceInventory.compose must exactly match discovered tracked sources')));
});

test('tracked variable ownership and generated reference are deterministic contract outputs', (context) =>
{
    const { root, contract } = createFixture(context);
    assert.equal(
        fs.readFileSync(path.join(root, contract.authorities.generatedReference), 'utf8'),
        renderBackendConfigurationReference(contract));

    const envPath = path.join(root, 'config/examples/.env.production.example');
    fs.writeFileSync(
        envPath,
        fs.readFileSync(envPath, 'utf8').replace('FSUSBLOG_BLUE_PORT=8081\n', ''));
    fs.appendFileSync(path.join(root, contract.authorities.generatedReference), '\nhand-edited\n');

    const result = checkBackendConfigurationContract({ root });
    assert.ok(result.errors.some(error => error.includes('environment variable FSUSBLOG_BLUE_PORT source ownership drifted')));
    assert.ok(result.errors.some(error => error.includes('generated configuration reference is stale')));
});
