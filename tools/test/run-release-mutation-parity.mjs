#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import {
    validateMutationReleaseParity,
    verifyReleaseArtifactBinding
} from './mutation-release-parity.mjs';

function option(name)
{
    const index = process.argv.indexOf(name);
    return index < 0 ? null : process.argv[index + 1];
}

const authorityPath = option('--authority');
const releasePath = option('--release');
const policyPath = option('--policy');
if (!authorityPath || !releasePath || !policyPath)
{
    throw new Error('usage: run-release-mutation-parity.mjs --authority <source-level> --release <release-artifact> --policy <fixed-subset>');
}
const sourceMutationResult = JSON.parse(fs.readFileSync(path.resolve(authorityPath), 'utf8'));
const releaseParityResult = JSON.parse(fs.readFileSync(path.resolve(releasePath), 'utf8'));
const selectionPolicy = JSON.parse(fs.readFileSync(path.resolve(policyPath), 'utf8'));
validateMutationReleaseParity({ sourceMutationResult, releaseParityResult, selectionPolicy });
await verifyReleaseArtifactBinding(releaseParityResult);
process.stdout.write(`release mutation parity verified: ${sourceMutationResult.inventoryDigest}\n`);
