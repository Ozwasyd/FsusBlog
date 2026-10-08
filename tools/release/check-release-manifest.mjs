#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';

// eslint-disable-next-line import-x/no-relative-parent-imports -- Activation delegates to the existing rollout owner's pure contract.
import { beginCurrentActivationSwitch } from '../deployment/current-activation-contract.mjs';

import { RELEASE_ID_CONTRACT } from './release-id.mjs';
import { verifyReleaseManifestArtifacts } from './release-manifest-signature-contract.mjs';
import { readExplicitReleaseArtifact, readCurrentSchemaReceiptReleaseBinding, readReleaseManifest } from './release-manifest.mjs';

function parseArgs(argv)
{
    const options = {};
    for (let index = 0; index < argv.length; index += 2)
    {
        const name = argv[index];
        const value = argv[index + 1];
        if (!name?.startsWith('--') || value === undefined)
        {
            throw new Error(`invalid argument near ${name ?? '<end>'}`);
        }
        options[name.slice(2)] = value;
    }
    return options;
}

try
{
    const options = parseArgs(process.argv.slice(2));
    if (options['legacy-rollback'] !== undefined)
    {
        throw new Error('--legacy-rollback is unsupported; restore requires a verified matching backup or a forward fix');
    }
    if (options['receipt-byte-binding'] !== undefined && options['receipt-byte-binding'] !== 'true')
    {
        throw new Error('receipt-byte-binding mode must be explicitly true');
    }
    if (options['identity-roster-byte-binding'] !== undefined)
    {
        if (options['identity-roster-byte-binding'] !== 'true' || options.manifest || options['receipt-byte-binding'])
        {
            throw new Error('identity roster byte binding is explicit and cannot substitute for manifest admission');
        }
        const bytes = readExplicitReleaseArtifact(options['identity-roster'], options['identity-roster-sha256']);
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        console.log(JSON.stringify({ status: 'roster-byte-bound', qualificationEligible: false }));
    }
    else if (options['receipt-byte-binding'] === 'true')
    {
        if (options.manifest)
        {
            throw new Error('receipt byte binding cannot substitute for manifest admission');
        }
        const currentSchema = readCurrentSchemaReceiptReleaseBinding(
            options['current-schema-receipt'], options['current-schema-receipt-sha256']);
        console.log(JSON.stringify({ status: 'byte-bound', qualificationEligible: false, currentSchema }));
    }
    else
    {
        if (!options.manifest)
        {
            throw new Error('missing --manifest');
        };
        const manifestFile = path.resolve(options.manifest);
        const readOptions = {
            requireRegistryDigest: true,
            requireConcreteRuntimeProfile: true,
            expectedReleaseId: options['release-id'],
            expectedImageRef: options['image-ref'],
            expectedImageDigest: options['image-digest'],
            expectedCommitSha: options['commit-sha']
        };
        const manifest = readReleaseManifest(manifestFile, readOptions);
        const observedBinding = readCurrentSchemaReceiptReleaseBinding(
            manifest.currentSchema.receipt.reference, manifest.currentSchema.receipt.sha256);
        for (const key of ['receiptFormat', 'receiptContentDigest', 'actualSchemaDigest'])
        {
            if (observedBinding[key] !== manifest.currentSchema[key])
            {
                throw new Error(`currentSchema.${key} differs from explicit receipt bytes`);
            }
        }
        for (const key of ['target', 'database'])
        {
            for (const field of Object.keys(observedBinding[key]))
            {
                if (observedBinding[key][field] !== manifest.currentSchema[key][field])
                {
                    throw new Error(`currentSchema.${key}.${field} differs from explicit receipt bytes`);
                }
            }
        }
        if (options['activation-preflight'] !== undefined
            && (options['activation-preflight'] !== 'true' || options['verify-artifacts'] !== 'true'))
        {
            throw new Error('activation preflight requires explicit artifact/signature verification');
        }
        if (options['verify-artifacts'] !== undefined)
        {
            if (options['verify-artifacts'] !== 'true')
            {
                throw new Error('artifact verification must be explicitly true');
            }
            let plan;
            if (options['activation-preflight'] === 'true')
            {
                if (!options['activation-plan'] || !options['activation-plan-sha256'])
                {
                    throw new Error('activation requires an explicit plan artifact reference and SHA-256');
                }
                plan = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readExplicitReleaseArtifact(
                    options['activation-plan'], options['activation-plan-sha256'].replace(/^sha256:/u, ''))));
            }
            const verification = { manifest, releaseIdContract: RELEASE_ID_CONTRACT,
                trustPolicyReference: options['trust-policy'], trustPolicySha256: options['trust-policy-sha256'],
                readBytes: (reference, expectedDigest) => readExplicitReleaseArtifact(reference,
                    expectedDigest?.replace(/^sha256:/u, '') ?? (reference === plan?.manifest.reference ? plan.manifest.sha256.replace(/^sha256:/u, '')
                        : reference === manifest.currentSchema.receipt.reference ? manifest.currentSchema.receipt.sha256
                            : findArtifactDigest(manifest.identity, reference)), 64 * 1024 * 1024) };
            if (plan)
            {
                beginCurrentActivationSwitch(plan, verification);
            }
            else
            {
                verifyReleaseManifestArtifacts(verification);
            }
        }
        const slot = options.slot ?? 'candidate';
        if (!/^[a-z][a-z0-9-]{0,31}$/u.test(slot))
        {
            throw new Error('slot must be a safe lowercase identifier');
        };
        const output = {
            schema: 'fsusblog.release-deploy-input.v1',
            status: 'ok',
            qualificationEligible: false,
            candidateId: manifest.candidateId,
            manifestContentDigest: manifest.contentDigest,
            manifest: manifestFile,
            releaseId: manifest.releaseId,
            createdAtUtc: manifest.createdAtUtc,
            commitSha: manifest.commitSha,
            slot,
            imageRef: manifest.imageRef,
            imageTag: manifest.imageTag,
            imageDigest: manifest.imageDigest,
            runtimeProfile: manifest.runtimeProfile ?? null,
            rollbackTarget: manifest.releaseId
        };
        if (options.format === 'lines')
        {
            for (const field of ['releaseId', 'createdAtUtc', 'commitSha', 'slot', 'imageRef', 'imageTag', 'imageDigest', 'rollbackTarget'])
            {
                console.log(output[field]);
            }
        }
        else
        {
            console.log(JSON.stringify(output));
        }
    }
}
catch (error)
{
    console.error(`[check-release-manifest] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
}

function findArtifactDigest(value, reference)
{
    if (value?.reference === reference)
    {
        return value.sha256.slice('sha256:'.length);
    }
    if (value && typeof value === 'object')
    {
        for (const child of Object.values(value))
        {
            const found = findArtifactDigest(child, reference);
            if (found)
            {
                return found;
            }
        }
    }
    return null;
}
