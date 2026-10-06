#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const {
    readAndValidatePostRuntimeAcceptedClaimsReceipt,
    writePostRuntimeAcceptedClaimsReceipt
} = await import(new URL('../../docs/post-runtime-accepted-claims.mjs', import.meta.url));

import {
    explicitJson,
    produceAcceptedClaims,
    produceCandidateContext,
    produceCandidatePlan,
    produceClassReceipt,
    validateCandidatePlan,
    validateClassReceipt,
    writeReceipt
} from './adapter.mjs';

function fail(message)
{
    throw new Error(`[post-runtime-current-run] ${message}`);
}

function parse(argv)
{
    const [command, ...args] = argv;
    const options = { observations: {} };
    const seen = new Set();
    for (let index = 0; index < args.length; index += 2)
    {
        const key = args[index];
        const value = args[index + 1];
        if (!value || value.startsWith('--'))
        {
            fail(`${key} requires a value`);
        }
        if (key !== '--observation' && seen.has(key))
        {
            fail(`duplicate option ${key}`);
        }
        seen.add(key);
        if (key === '--terminal')
        {
            options.terminalReceipt = value;
        }
        else if (key === '--pre-runtime')
        {
            options.preRuntimeReceipt = value;
        }
        else if (key === '--accepted-claims')
        {
            options.acceptedClaimsReceipt = value;
        }
        else if (key === '--build')
        {
            options.buildReceipt = value;
        }
        else if (key === '--context')
        {
            options.context = value;
        }
        else if (key === '--class')
        {
            options.classId = value;
        }
        else if (key === '--result')
        {
            options.result = value;
        }
        else if (key === '--receipt')
        {
            options.receipt = value;
        }
        else if (key === '--out')
        {
            options.out = value;
        }
        else if (key === '--run-id')
        {
            options.runId = value;
        }
        else if (key === '--attempt-id')
        {
            options.attemptId = value;
        }
        else if (key === '--release-id')
        {
            options.releaseId = value;
        }
        else if (key === '--rollout-id')
        {
            options.rolloutId = value;
        }
        else if (key === '--observation')
        {
            const separator = value.indexOf('=');
            if (separator < 1)
            {
                fail('--observation must use class=path');
            }
            const classId = value.slice(0, separator);
            if (!value.slice(separator + 1) || Object.hasOwn(options.observations, classId))
            {
                fail('--observation must bind each class exactly once');
            }
            options.observations[classId] = value.slice(separator + 1);
        }
        else
        {
            fail(`unknown option ${key}`);
        }
    }
    return { command, options };
}

export function runCurrentRunCli(argv, repositoryRoot)
{
    const { command, options } = parse(argv);
    let receipt;
    let currentParentInput = null;
    const candidateCommands = new Set(['candidate-context', 'candidate-plan', 'class-receipt', 'verify-candidate-plan', 'verify-class-receipt']);
    if (candidateCommands.has(command))
    {
        if (!options.runId || !options.attemptId)
        {
            fail(`${command} requires explicit --run-id and --attempt-id`);
        }
        if (command !== 'candidate-context')
        {
            currentParentInput = explicitJson(command === 'candidate-plan' ? options.context : options.receipt, 'current parent candidate input', repositoryRoot);
            const input = currentParentInput;
            if (input.value.candidate?.runId !== options.runId || input.value.candidate?.attemptId !== options.attemptId)
            {
                fail('candidate input differs from the explicit current parent run/attempt');
            }
        }
    }
    if (['accepted-claims', 'verify-accepted-claims', 'candidate-context'].includes(command) && !options.runId)
    {
        fail(`${command} requires an explicit --run-id`);
    }
    if (command === 'candidate-context' && !options.attemptId)
    {
        fail('candidate-context requires an explicit --attempt-id');
    }
    if (command === 'accepted-claims')
    {
        receipt = produceAcceptedClaims({ terminalReceipt: options.terminalReceipt, expectedRunId: options.runId, repositoryRoot });
    }
    else if (command === 'candidate-context')
    {
        receipt = produceCandidateContext({
            preRuntimeReceipt: options.preRuntimeReceipt,
            runId: options.runId,
            attemptId: options.attemptId,
            candidate: {
                ...(options.releaseId ? { releaseId: options.releaseId } : {}),
                ...(options.rolloutId ? { rolloutId: options.rolloutId } : {})
            },
            repositoryRoot
        });
    }
    else if (command === 'candidate-plan')
    {
        if (!options.out)
        {
            fail('candidate-plan requires --out so typed identity authorities have a canonical location');
        }
        receipt = produceCandidatePlan({
            preRuntimeReceipt: options.preRuntimeReceipt,
            acceptedClaimsReceipt: options.acceptedClaimsReceipt,
            buildReceipt: options.buildReceipt,
            context: options.context,
            identityAuthorityDirectory: path.posix.join(path.posix.dirname(options.out.replaceAll(path.sep, '/')), 'identity-authorities'),
            observationPaths: options.observations,
            expectedRunId: options.runId,
            expectedAttemptId: options.attemptId,
            repositoryRoot
        });
    }
    else if (command === 'class-receipt')
    {
        receipt = produceClassReceipt({
            candidatePlan: options.receipt,
            classId: options.classId,
            result: options.result,
            expectedRunId: options.runId,
            expectedAttemptId: options.attemptId,
            repositoryRoot
        });
    }
    else if (command === 'verify-accepted-claims')
    {
        receipt = readAndValidatePostRuntimeAcceptedClaimsReceipt({
            receiptPath: options.receipt, expectedRunId: options.runId, repositoryRoot
        });
    }
    else if (command === 'verify-candidate-plan')
    {
        receipt = validateCandidatePlan(currentParentInput.value, { repositoryRoot });
    }
    else if (command === 'verify-class-receipt')
    {
        receipt = validateClassReceipt(currentParentInput.value, { repositoryRoot, expectedRunId: options.runId, expectedAttemptId: options.attemptId });
    }
    else
    {
        fail('command must be accepted-claims, candidate-context, candidate-plan, class-receipt, verify-accepted-claims, verify-candidate-plan, or verify-class-receipt');
    }

    if (options.out)
    {
        if (command === 'accepted-claims' || command === 'verify-accepted-claims')
        {
            writePostRuntimeAcceptedClaimsReceipt({ outputPath: options.out, receipt,
                expectedRunId: options.runId, repositoryRoot });
        }
        else
        {
            writeReceipt(options.out, receipt, repositoryRoot);
        }
    }
    console.log(`[post-runtime-current-run] ${command} status=${receipt.status} digest=${receipt.contentDigest}`);
    return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        runCurrentRunCli(process.argv.slice(2), path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'));
    }
    catch (error)
    {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
