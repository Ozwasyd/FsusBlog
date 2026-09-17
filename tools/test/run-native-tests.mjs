#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { fileSetDigest, nativeSha256 } from './native-test-digest.mjs';
import { listNativeFiles } from './native-test-files.mjs';
import { loadNativeGovernance, validateNativeReceipt } from './native-test-governance.mjs';
import {
    commandPath,
    commandVersion,
    runNativeCommand,
    sourceCommit,
    writeNativeReceipt
} from './native-test-runtime-support.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parsePositiveInteger(value, label)
{
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0)
    {
        throw new Error(`${label} must be a positive integer`);
    }
    return parsed;
}

function parseArgs(argv)
{
    const options = {
        profile: null,
        runs: parsePositiveInteger(process.env.FSUSBLOG_NATIVE_FUZZ_RUNS ?? '1000', 'FSUSBLOG_NATIVE_FUZZ_RUNS'),
        jobs: parsePositiveInteger(process.env.FSUSBLOG_NATIVE_JOBS ?? '1', 'FSUSBLOG_NATIVE_JOBS'),
        out: null
    };
    for (let index = 0; index < argv.length; index += 1)
    {
        const argument = argv[index];
        if (argument === '--profile')
        {
            options.profile = argv[++index];
        }
        else if (argument === '--runs')
        {
            options.runs = parsePositiveInteger(argv[++index], '--runs');
        }
        else if (argument === '--jobs')
        {
            options.jobs = parsePositiveInteger(argv[++index], '--jobs');
        }
        else if (argument === '--out')
        {
            options.out = path.resolve(root, argv[++index]);
        }
        else
        {
            throw new Error(`unknown argument: ${argument}`);
        }
    }
    if (!options.profile)
    {
        throw new Error('--profile is required');
    }
    return options;
}

function main()
{
    const options = parseArgs(process.argv.slice(2));
    const { catalog } = loadNativeGovernance(root);
    const profile = catalog.profiles.find((entry) => entry.id === options.profile);
    const target = catalog.targets.find((entry) => entry.profile === options.profile);
    if (!profile || !target)
    {
        throw new Error(`unknown native profile: ${options.profile}`);
    }
    const corpus = target.corpusId ? catalog.corpora.find((entry) => entry.id === target.corpusId) : null;
    const corpusFiles = corpus ? listNativeFiles(root, corpus.path) : [];
    const sourceInputs = [target.source, ...catalog.supportAssets.map((entry) => entry.path), ...corpusFiles];
    const compilerName = options.profile === 'fuzz-sanitizer'
        ? (process.env.FSUSBLOG_NATIVE_FUZZ_CXX ?? 'clang++')
        : (process.env.CXX ?? 'c++');
    const compilerPath = commandPath(compilerName);
    const cmakePath = commandPath('cmake');
    const ctestPath = commandPath('ctest');
    const missing = [
    !compilerPath ? `compiler:${compilerName}` : null,
    !cmakePath ? 'tool:cmake' : null,
    options.profile === 'smoke' && !ctestPath ? 'tool:ctest' : null
    ].filter(Boolean);
    const crashDirectory = `.tmp/native-tests/${options.profile}/crashes`;
    const runtimeCorpusDirectory = `.tmp/native-tests/${options.profile}/corpus`;
    const buildDirectory = path.join(root, '.tmp/native-tests', options.profile, 'build');
    const receiptPath = options.out ?? path.join(root, profile.receipt);
    const receipt = {
        schema: 'fsusblog.native-test-receipt.v1',
        profile: profile.id,
        testId: target.testId,
        target: target.cmakeTarget,
        source: {
            commit: sourceCommit(root),
            inputDigest: fileSetDigest(root, sourceInputs)
        },
        toolchain: {
            compilerPath: compilerPath ?? compilerName,
            compilerVersion: compilerPath ? commandVersion(compilerPath) : 'unavailable',
            cmakeVersion: cmakePath ? commandVersion(cmakePath) : 'unavailable'
        },
        flags: {
            sanitizers: profile.sanitizers,
            fuzzer: options.profile === 'fuzz-sanitizer' ? [`-runs=${options.runs}`, `-jobs=${options.jobs}`] : []
        },
        corpus: {
            id: corpus?.id ?? 'empty-smoke-corpus',
            files: corpusFiles,
            identity: fileSetDigest(root, corpusFiles)
        },
        crashArtifacts: {
            path: crashDirectory,
            count: 0,
            digest: nativeSha256('')
        },
        resources: {
            runs: options.profile === 'fuzz-sanitizer' ? options.runs : null,
            jobs: options.jobs,
            fixedTimeGate: false
        },
        preflight: {
            status: missing.length === 0 ? 'ready' : 'blocked',
            missing,
            missingReason: missing.length === 0 ? null : `native capability unavailable: ${missing.join(', ')}`
        },
        outcome: missing.length === 0 ? 'failed' : 'blocked'
    };

    if (missing.length > 0)
    {
        writeNativeReceipt(receiptPath, receipt);
        console.error(receipt.preflight.missingReason);
        process.exitCode = 2;
        return;
    }

    fs.rmSync(buildDirectory, { recursive: true, force: true });
    fs.mkdirSync(buildDirectory, { recursive: true });
    fs.rmSync(path.join(root, crashDirectory), { recursive: true, force: true });
    fs.mkdirSync(path.join(root, crashDirectory), { recursive: true });
    if (corpus)
    {
        fs.rmSync(path.join(root, runtimeCorpusDirectory), { recursive: true, force: true });
        fs.mkdirSync(path.join(root, runtimeCorpusDirectory), { recursive: true });
        fs.cpSync(path.join(root, corpus.path), path.join(root, runtimeCorpusDirectory), { recursive: true });
    }
    const configureArgs = [
        '-S', root,
        '-B', buildDirectory,
        '-DCMAKE_BUILD_TYPE=RelWithDebInfo',
        `-DCMAKE_CXX_COMPILER=${compilerPath}`,
        `-DFSUSBLOG_ENABLE_FUZZING=${options.profile === 'fuzz-sanitizer' ? 'ON' : 'OFF'}`,
        `-DFSUSBLOG_ENABLE_SANITIZERS=${options.profile === 'fuzz-sanitizer' ? 'ON' : 'OFF'}`
    ];
    let status = runNativeCommand(root, cmakePath, configureArgs);
    if (status === 0)
    {
        status = runNativeCommand(root, cmakePath, ['--build', buildDirectory, '--target', target.cmakeTarget, '--parallel', String(options.jobs)]);
    }
    if (status === 0 && options.profile === 'smoke')
    {
        status = runNativeCommand(root, ctestPath, ['--test-dir', buildDirectory, '--output-on-failure', '-R', `^${target.ctestName}$`]);
    }
    else if (status === 0)
    {
        const executable = path.join(buildDirectory, 'tests/native', target.cmakeTarget);
        status = runNativeCommand(root, executable, [
            `-runs=${options.runs}`,
            `-jobs=${options.jobs}`,
            `-artifact_prefix=${path.join(root, crashDirectory)}/`,
            path.join(root, runtimeCorpusDirectory)
        ]);
    }

    const crashes = listNativeFiles(root, crashDirectory);
    receipt.crashArtifacts.count = crashes.length;
    receipt.crashArtifacts.digest = fileSetDigest(root, crashes);
    receipt.outcome = status === 0 ? 'passed' : 'failed';
    writeNativeReceipt(receiptPath, receipt);
    const receiptErrors = validateNativeReceipt(receipt, profile, target);
    if (receiptErrors.length > 0)
    {
        throw new Error(`native receipt is invalid:\n${receiptErrors.join('\n')}`);
    }
    if (status !== 0)
    {
        process.exitCode = status;
    }
}

main();
