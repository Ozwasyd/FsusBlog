#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { devNull } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { bindSourceFile, verifySourceFileBinding } from './check-solution-source.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const policyFile = 'config/development/opaque-source-fixture-policy.json';
const checkerFile = 'tools/configuration/check-opaque-fixture-source.mjs';
const reporterFile = 'tools/configuration/opaque-fixture-native-reporter.mjs';
const fixtureFile = 'tests/tools/fixtures/canonical-digest-edge/v3-contract.mjs';
const consumerFile = 'tests/tools/canonical-digest-edge.test.mjs';
const ownedInputs = [policyFile, checkerFile, reporterFile,
    'tools/configuration/check-solution-source.mjs', 'tests/matrix.yml', fixtureFile, consumerFile];
const environmentKeys = ['NODE_OPTIONS', 'NODE_PATH', 'NODE_TEST_CONTEXT', 'NODE_V8_COVERAGE'];

function sha256(bytes)
{
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function git(root, argv)
{
    return execFileSync('git', ['-C', root, ...argv], {
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: devNull },
        maxBuffer: 32 * 1024 * 1024
    });
}

function keys(value, expected)
{
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort());
}

function assertContext(root, files)
{
    if (root !== fs.realpathSync(root) || !fs.lstatSync(root).isDirectory()
        || !isDeepStrictEqual(files, [fixtureFile]))
    {
        throw new Error('opaque fixture source requires its one registered canonical input');
    }
    if (['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
        'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG_COUNT', 'GIT_REPLACE_REF_BASE', 'GIT_GRAFT_FILE']
        .some(key => Object.hasOwn(process.env, key))
        || environmentKeys.some(key => process.env[key]))
    {
        throw new Error('opaque fixture source refuses ambient Git or Node execution overrides');
    }
}

function readPolicy(bytes)
{
    const value = JSON.parse(bytes);
    if (!keys(value, ['schema', 'fixture', 'fixtureSha256', 'consumer', 'consumerSha256', 'caseNames'])
        || value.schema !== 'fsusblog.opaque-source-fixture-policy.v1'
        || value.fixture !== fixtureFile || value.consumer !== consumerFile
        || !/^[a-f0-9]{64}$/u.test(value.fixtureSha256)
        || !/^[a-f0-9]{64}$/u.test(value.consumerSha256)
        || !Array.isArray(value.caseNames) || value.caseNames.length !== 46
        || value.caseNames.some(name => typeof name !== 'string' || !name || /[\r\n\0]/u.test(name))
        || new Set(value.caseNames).size !== value.caseNames.length)
    {
        throw new Error('opaque fixture source policy is not its closed original consumer registration');
    }
    return value;
}

function bindNode()
{
    const executable = fs.realpathSync(process.execPath);
    const descriptor = fs.openSync(executable, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try
    {
        const before = fs.fstatSync(descriptor, { bigint: true });
        if (!before.isFile() || before.nlink !== 1n || !(before.mode & 0o111n))
        {
            throw new Error('opaque fixture source requires a regular single-link native Node executable');
        }
        const held = { descriptor, absolute: executable, before, ancestors: [], binding: { file: executable } };
        const bytes = fs.readFileSync(descriptor);
        verifySourceFileBinding(held);
        return { held, identity: { executable, version: process.version, sha256: sha256(bytes), bytes: bytes.length,
            epoch: Object.fromEntries(['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs']
                .map(key => [key, before[key].toString()])) } };
    }
    catch (error)
    {
        fs.closeSync(descriptor);
        throw error;
    }
}

function withInputs(repositoryRoot, files, action)
{
    const root = path.resolve(repositoryRoot);
    assertContext(root, files);
    const head = git(root, ['rev-parse', 'HEAD']).toString('utf8').trim();
    const indexDigest = sha256(git(root, ['ls-files', '--stage', '-z']));
    const held = [];
    let node;
    try
    {
        for (const file of ownedInputs)
        {
            const input = bindSourceFile(root, file, file === 'tests/matrix.yml' ? 4 * 1024 * 1024 : 1024 * 1024, true);
            held.push(input);
            if (input.binding.mode !== '100644')
            {
                throw new Error(`opaque fixture source requires non-executable registered inputs: ${file}`);
            }
        }
        const policy = readPolicy(held[0].bytes);
        if (held.find(input => input.binding.file === fixtureFile).binding.sha256 !== policy.fixtureSha256
            || held.find(input => input.binding.file === consumerFile).binding.sha256 !== policy.consumerSha256)
        {
            throw new Error('opaque fixture or complete original consumer differs from its reviewed source registration');
        }
        node = bindNode();
        const inputs = { head, indexDigest, bindings: held.map(input => input.binding), node: node.identity };
        const matrixBytes = held.find(input => input.binding.file === 'tests/matrix.yml').bytes;
        const matrixSource = matrixBytes.toString('utf8');
        if (!Buffer.from(matrixSource).equals(matrixBytes))
        {
            throw new Error('opaque fixture matrix requires exact UTF-8 source bytes');
        }
        const value = action({ root, inputs, policy, matrixSource });
        for (const input of held)
        {
            verifySourceFileBinding(input);
        }
        verifySourceFileBinding(node.held);
        if (git(root, ['rev-parse', 'HEAD']).toString('utf8').trim() !== head
            || sha256(git(root, ['ls-files', '--stage', '-z'])) !== indexDigest)
        {
            throw new Error('opaque fixture source HEAD or index changed during collection');
        }
        return value;
    }
    finally
    {
        for (const input of held)
        {
            fs.closeSync(input.descriptor);
        }
        if (node)
        {
            fs.closeSync(node.held.descriptor);
        }
    }
}

export function inspectOpaqueFixtureInputs({ repositoryRoot, files })
{
    return withInputs(repositoryRoot, files, ({ inputs }) => inputs);
}

export function validateOpaqueConsumerEvents(source, { entry, expectedNames })
{
    const events = source.trim().split('\n').map(line => JSON.parse(line));
    if (!source.endsWith('\n') || events.some(event => !keys(event, ['type', 'data']) || typeof event.type !== 'string'))
    {
        throw new Error('opaque fixture consumer requires closed native Node events');
    }
    const summaries = events.filter(event => event.type === 'test:summary' && !event.data.file);
    const fileSummaries = events.filter(event => event.type === 'test:summary' && event.data.file);
    const passes = events.filter(event => event.type === 'test:pass');
    if (summaries.length !== 1 || fileSummaries.length !== 1 || fileSummaries[0].data.file !== entry
        || !keys(summaries[0].data, ['success', 'counts', 'duration_ms'])
        || !keys(fileSummaries[0].data, ['success', 'counts', 'duration_ms', 'file'])
        || fileSummaries[0].data.success !== true
        || !isDeepStrictEqual(fileSummaries[0].data.counts, summaries[0].data.counts)
        || summaries[0].data.success !== true
        || !isDeepStrictEqual(summaries[0].data.counts, { tests: expectedNames.length, failed: 0,
            passed: expectedNames.length, cancelled: 0, skipped: 0, todo: 0, topLevel: expectedNames.length, suites: 0 })
        || events.some(event => event.type === 'test:fail')
        || passes.some(event => event.data.file !== entry || event.data.nesting !== 0
            || event.data.skip || event.data.todo || event.data.details?.type !== 'test')
        || !isDeepStrictEqual(passes.map(event => event.data.name).sort(), [...expectedNames].sort()))
    {
        throw new Error('opaque fixture consumer requires every original case with no failure, skip, todo or cancellation');
    }
    return { caseNames: passes.map(event => event.data.name).sort(), counts: summaries[0].data.counts };
}

function nativeArguments(root)
{
    return ['--test', '--test-reporter', path.join(root, reporterFile), path.join(root, consumerFile)];
}

export function collectOpaqueFixtureSource({ repositoryRoot, files, attemptToken })
{
    if (!/^[a-f0-9]{64}$/u.test(attemptToken ?? ''))
    {
        throw new Error('opaque fixture collection requires its independent caller attempt token');
    }
    return withInputs(repositoryRoot, files, ({ root, inputs, policy, matrixSource }) =>
    {
        const env = { ...process.env };
        for (const key of environmentKeys)
        {
            delete env[key];
        }
        const result = spawnSync(process.execPath, nativeArguments(root), { cwd: root, env, encoding: 'utf8',
            timeout: 15 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 });
        if (result.error || result.status !== 0 || result.signal)
        {
            throw new Error(`opaque fixture original consumer failed: exit=${result.status} signal=${result.signal} `
                + `${result.error?.message ?? ''}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
        }
        const consumer = validateOpaqueConsumerEvents(result.stdout,
            { entry: path.join(root, consumerFile), expectedNames: policy.caseNames });
        return { schema: 'fsusblog.opaque-fixture-source-evidence.v1', status: 'collected', qualificationEligible: false,
            files, inputs, matrixSource, attemptToken, consumer: { entry: consumerFile, arguments: nativeArguments(root),
                exitCode: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, ...consumer } };
    });
}

export function validateOpaqueFixtureSourceReceipt({ repositoryRoot, files, expectedHead, expectedAttemptToken, receipt })
{
    return withInputs(repositoryRoot, files, ({ root, inputs, policy, matrixSource }) =>
    {
        if (!keys(receipt, ['schema', 'status', 'qualificationEligible', 'files', 'inputs', 'matrixSource', 'attemptToken', 'consumer'])
            || receipt.schema !== 'fsusblog.opaque-fixture-source-evidence.v1' || receipt.status !== 'collected'
            || receipt.qualificationEligible !== false || !isDeepStrictEqual(receipt.files, files)
            || !/^[a-f0-9]{64}$/u.test(expectedAttemptToken ?? '') || receipt.attemptToken !== expectedAttemptToken
            || expectedHead !== inputs.head || !isDeepStrictEqual(receipt.inputs, inputs) || receipt.matrixSource !== matrixSource
            || !keys(receipt.consumer, ['entry', 'arguments', 'exitCode', 'signal', 'stdout', 'stderr', 'caseNames', 'counts'])
            || receipt.consumer.entry !== consumerFile || receipt.consumer.exitCode !== 0 || receipt.consumer.signal !== null
            || !isDeepStrictEqual(receipt.consumer.arguments, nativeArguments(root))
            || typeof receipt.consumer.stdout !== 'string' || typeof receipt.consumer.stderr !== 'string')
        {
            throw new Error('opaque fixture receipt does not match the live original command and source inputs');
        }
        const consumer = validateOpaqueConsumerEvents(receipt.consumer.stdout,
            { entry: path.join(root, consumerFile), expectedNames: policy.caseNames });
        if (!isDeepStrictEqual(consumer.caseNames, receipt.consumer.caseNames)
            || !isDeepStrictEqual(consumer.counts, receipt.consumer.counts))
        {
            throw new Error('opaque fixture native event projection differs from the collected consumer');
        }
        return { schema: 'fsusblog.opaque-fixture-source-verification.v1', status: 'verified',
            qualificationEligible: false, head: inputs.head, attemptToken: expectedAttemptToken, files };
    });
}

async function readReceipt()
{
    const chunks = [];
    let length = 0;
    for await (const chunk of process.stdin)
    {
        length += chunk.length;
        if (length > 16 * 1024 * 1024)
        {
            throw new Error('opaque fixture receipt exceeds its sixteen MiB transport limit');
        }
        chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    const source = bytes.toString('utf8');
    if (!Buffer.from(source).equals(bytes))
    {
        throw new Error('opaque fixture receipt transport requires exact UTF-8');
    }
    return JSON.parse(source);
}

async function main(argv)
{
    const options = { files: [], verify: false, expectedHead: null, attemptToken: null,
        expectedAttemptToken: null, root: defaultRoot };
    const seen = new Set();
    while (argv.length)
    {
        const option = argv.shift();
        if (option !== '--file' && seen.has(option))
        {
            throw new Error('opaque fixture source refuses duplicate command options');
        }
        seen.add(option);
        if (option === '--verify-receipt' && !options.verify)
        {
            options.verify = true;
        }
        else if (['--root', '--file', '--expected-head', '--attempt-token', '--expected-attempt-token'].includes(option) && argv.length)
        {
            const value = argv.shift();
            if (option === '--file')
            {
                options.files.push(value);
            }
            else if (option === '--root')
            {
                options.root = value;
            }
            else if (option === '--expected-head')
            {
                options.expectedHead = value;
            }
            else if (option === '--attempt-token')
            {
                options.attemptToken = value;
            }
            else
            {
                options.expectedAttemptToken = value;
            }
        }
        else
        {
            throw new Error('opaque fixture source accepts only its closed root, file and receipt-verification arguments');
        }
    }
    if ((options.verify && (!/^[a-f0-9]{40}$/u.test(options.expectedHead ?? '')
        || !/^[a-f0-9]{64}$/u.test(options.expectedAttemptToken ?? '') || options.attemptToken !== null))
        || (!options.verify && (options.expectedHead !== null || options.expectedAttemptToken !== null
            || !/^[a-f0-9]{64}$/u.test(options.attemptToken ?? ''))))
    {
        throw new Error('opaque fixture source requires the exact caller HEAD only for receipt verification');
    }
    const result = options.verify
        ? validateOpaqueFixtureSourceReceipt({ repositoryRoot: options.root, files: options.files,
            expectedHead: options.expectedHead, expectedAttemptToken: options.expectedAttemptToken,
            receipt: await readReceipt() })
        : collectOpaqueFixtureSource({ repositoryRoot: options.root, files: options.files, attemptToken: options.attemptToken });
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        await main(process.argv.slice(2));
    }
    catch (error)
    {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    }
}
