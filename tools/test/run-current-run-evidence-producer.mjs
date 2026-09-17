#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    EVIDENCE_TERMINAL_HANDOFF_PREFIX,
    beginCurrentRunEvidencePublication,
    finalizeCurrentRunEvidencePublication,
    recoverCurrentRunEvidencePublication
} from './current-run-evidence-publication.mjs';
import { validateEvidenceLocatorRegistry } from './evidence-location-contract.mjs';

const defaultRepositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function loadBinding({ environment = process.env, repositoryRoot = defaultRepositoryRoot } = {})
{
    const registry = JSON.parse(fs.readFileSync(path.join(repositoryRoot,
        'config/testing/evidence-locator-registry.json'), 'utf8'));
    validateEvidenceLocatorRegistry(registry);
    const consumerId = String(environment.FSUSBLOG_CURRENT_RUN_EVIDENCE_CONSUMER ?? '').trim();
    if (!consumerId)
    {
        throw new Error('FSUSBLOG_CURRENT_RUN_EVIDENCE_CONSUMER is required');
    }
    const entry = registry.entries.find((candidate) => candidate.consumerId === consumerId);
    if (!entry)
    {
        throw new Error(`unknown evidence locator consumer: ${consumerId}`);
    }
    if (entry.publicationMode !== 'hooked')
    {
        throw new Error(`evidence locator consumer is not producer-hooked: ${consumerId}`);
    }
    const contextPath = String(environment.FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT ?? '').trim();
    const outputPath = String(environment[entry.outputBindingKey] ?? '').trim();
    const payloadPath = String(environment[entry.payloadBindingKey] ?? '').trim();
    if (!contextPath)
    {
        throw new Error('FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT is required');
    }
    if (!outputPath)
    {
        throw new Error(`missing explicit output binding ${entry.outputBindingKey}`);
    }
    if (!payloadPath)
    {
        throw new Error(`missing explicit payload binding ${entry.payloadBindingKey}`);
    }
    const context = JSON.parse(fs.readFileSync(path.resolve(repositoryRoot, contextPath), 'utf8'));
    return { context, entry, outputPath, payloadPath, repositoryRoot };
}

export function beginRegisteredCurrentRunEvidenceProducer(options = {})
{
    const binding = loadBinding(options);
    const session = beginCurrentRunEvidencePublication({
        authorityId: binding.entry.authorityId,
        context: binding.context,
        outputPath: binding.outputPath,
        payloadPath: binding.payloadPath,
        producerId: binding.entry.producerId,
        repositoryRoot: binding.repositoryRoot
    });
    return { ...binding, ...session };
}

export function finalizeRegisteredCurrentRunEvidenceProducer(session)
{
    const payload = path.resolve(session.repositoryRoot, session.payloadPath);
    if (!fs.existsSync(payload) || !fs.statSync(payload).isFile())
    {
        throw new Error('producer payload is missing after terminal success');
    }
    const payloadSchema = JSON.parse(fs.readFileSync(payload, 'utf8'))?.schema;
    if (typeof payloadSchema !== 'string' || payloadSchema.length === 0)
    {
        throw new Error('producer payload schema is missing after terminal success');
    }
    const result = finalizeCurrentRunEvidencePublication({
        authorityId: session.entry.authorityId,
        context: session.context,
        outputPath: session.outputPath,
        payloadPath: session.payloadPath,
        payloadSchema,
        producerId: session.entry.producerId,
        repositoryRoot: session.repositoryRoot,
        sessionId: session.sessionId,
        terminalStatus: 'success'
    });
    return result.handoff;
}

function main()
{
    const action = process.argv[2];
    if (action === 'begin')
    {
        const session = beginRegisteredCurrentRunEvidenceProducer();
        process.stdout.write(`${session.sessionId}\n`);
        return;
    }
    if (action === 'finalize')
    {
        const session = { ...loadBinding(), sessionId: String(process.argv[3] ?? '').trim() };
        if (!session.sessionId)
        {
            throw new Error('publication session id is required');
        }
        const handoff = finalizeRegisteredCurrentRunEvidenceProducer(session);
        process.stdout.write(`${EVIDENCE_TERMINAL_HANDOFF_PREFIX}${JSON.stringify(handoff)}\n`);
        return;
    }
    if (action === 'recover')
    {
        const binding = loadBinding();
        const recovered = recoverCurrentRunEvidencePublication({ context: binding.context,
            outputPath: binding.outputPath, repositoryRoot: binding.repositoryRoot });
        if (recovered.handoff)
        {
            process.stdout.write(`${EVIDENCE_TERMINAL_HANDOFF_PREFIX}${JSON.stringify(recovered.handoff)}\n`);
        }
        return;
    }
    throw new Error('usage: run-current-run-evidence-producer.mjs begin|finalize <session-id>|recover');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        main();
    }
    catch (error)
    {
        process.stderr.write(`[current-run-evidence-producer] ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
