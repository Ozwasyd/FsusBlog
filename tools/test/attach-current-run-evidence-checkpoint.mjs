#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { attachCurrentRunEvidenceReferenceToCheckpoint } from './current-run-evidence-checkpoint.mjs';
import { validateEvidenceLocatorRegistry } from './evidence-location-contract.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function option(name)
{
    const index = process.argv.indexOf(name);
    if (index < 0 || !process.argv[index + 1]) throw new Error(`${name} is required`);
    return process.argv[index + 1];
}

const registry = JSON.parse(fs.readFileSync(path.join(repositoryRoot,
    'config/testing/evidence-locator-registry.json'), 'utf8'));
validateEvidenceLocatorRegistry(registry);
const consumerId = option('--consumer');
const entry = registry.entries.find((candidate) => candidate.consumerId === consumerId);
if (!entry) throw new Error(`unknown evidence locator consumer: ${consumerId}`);
const contextPath = String(process.env.FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT ?? '').trim();
const checkpointPath = String(process.env.FSUSBLOG_CURRENT_RUN_EVIDENCE_CHECKPOINT_PATH ?? '').trim();
const handoffPath = String(process.env[entry.handoffBindingKey] ?? '').trim();
if (!contextPath) throw new Error('FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT is required');
if (!checkpointPath) throw new Error('FSUSBLOG_CURRENT_RUN_EVIDENCE_CHECKPOINT_PATH is required');
if (!handoffPath) throw new Error(`missing explicit handoff binding ${entry.handoffBindingKey}`);
const context = JSON.parse(fs.readFileSync(path.resolve(contextPath), 'utf8'));
const handoff = JSON.parse(fs.readFileSync(path.resolve(handoffPath), 'utf8'));
const checkpoint = attachCurrentRunEvidenceReferenceToCheckpoint({ checkpointPath, context,
    entry, handoff, registry, repositoryRoot });
process.stdout.write(`${JSON.stringify({ authorityId: entry.authorityId,
    checkpointRevision: checkpoint.revision })}\n`);
