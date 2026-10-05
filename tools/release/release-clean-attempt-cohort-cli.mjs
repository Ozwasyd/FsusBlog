#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { readCleanAttemptEvidenceSource } from './clean-attempt-evidence-source.mjs';
import { admitCleanAttemptCohort, archiveCleanAttemptCohortInputs } from './release-clean-attempt-cohort.mjs';

function option(args, name)
{
    const index = args.indexOf(name);
    if (index < 0 || typeof args[index + 1] !== 'string' || !args[index + 1].trim())
    {
        throw new Error(`${name} is required`);
    }
    return args[index + 1];
}

function exactKeys(value, expected, label)
{
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort()))
    {
        throw new Error(`${label} fields must exactly equal ${[...expected].sort().join(', ')}`);
    }
}

function main()
{
    const args = process.argv.slice(2);
    const repositoryRoot = fs.realpathSync(path.resolve(option(args, '--repository-root')));
    const inputFile = path.resolve(option(args, '--input'));
    const outputFile = path.resolve(option(args, '--output'));
    const expectedCohortId = option(args, '--cohort-id');
    const expectedBuildIdentity = option(args, '--build-identity');
    const expectedCandidate = JSON.parse(fs.readFileSync(path.resolve(option(args, '--candidate')), 'utf8'));
    const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
    exactKeys(input, ['schema', 'cohortId', 'buildIdentity', 'slots'], 'cohort input');
    if (input.schema !== 'fsusblog.release-clean-attempt-cohort-input.v1'
        || input.cohortId !== expectedCohortId
        || input.buildIdentity !== expectedBuildIdentity)
    {
        throw new Error('cohort input identity does not match the release candidate');
    }
    if (!Array.isArray(input.slots))
    {
        throw new Error('cohort input slots are required');
    }
    const slots = input.slots.map((entry, index) =>
    {
        exactKeys(entry, ['slot', 'members'], `cohort input slot ${index + 1}`);
        return {
            slot: entry.slot,
            members: entry.members.map((member) =>
            {
                exactKeys(member, ['authorityId', 'evidenceSource'], 'cohort member');
                const evidenceSource = path.resolve(path.dirname(inputFile), member.evidenceSource);
                return { authorityId: member.authorityId,
                    evidenceSource: { path: evidenceSource, fileDigest: `sha256:${createHash('sha256').update(fs.readFileSync(evidenceSource)).digest('hex')}` },
                    attemptEvidence: readCleanAttemptEvidenceSource(evidenceSource, { repositoryRoot }) };
            })
        };
    });
    const archived = archiveCleanAttemptCohortInputs({ slots, expectedCandidate, repositoryRoot,
        archiveRoot: path.dirname(outputFile), cohortId: input.cohortId, rejectedOutputFile: outputFile });
    const cohort = admitCleanAttemptCohort({
        cohortId: input.cohortId,
        buildIdentity: input.buildIdentity,
        slots: archived.slots,
        expectedCandidate: archived.expectedCandidate,
        candidateRepositoryRoot: path.dirname(outputFile),
        outputFile
    });
    process.stdout.write(`${JSON.stringify({
        schema: cohort.schema,
        cohortId: cohort.cohortId,
        qualificationEligible: cohort.qualificationEligible,
        contentDigest: cohort.contentDigest,
        outputFile
    })}\n`);
}

try
{
    main();
}
catch (error)
{
    process.stderr.write(`[release-clean-attempt-cohort] ${error.message}\n`);
    process.exitCode = 1;
}
