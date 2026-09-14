#!/usr/bin/env node
/**
 * CLI gate: ProseClaimVerifier governance + optional receipt-backed claim verification.
 *
 * Default mode runs governance only (unique registry, no fuzzy/reviewed/baseline surfaces).
 * With --receipt, also verifies repository DocClaim prose against the given FactObservation receipts.
 *
 * Never invokes LLM, network, extractors, or human review state.
 */

import { parseRepositoryClaims, root as docClaimRoot } from './doc-claim.mjs';
import {
    ProseClaimErrorCode,
    formatProseClaimDiagnostic
} from './prose-claim-verifier/errors.mjs';
import {
    scanProseClaimGovernance,
    formatGovernanceViolations,
    countForbiddenProseSurfaces,
    root as proseRoot
} from './prose-claim-verifier/governance.mjs';
import {
    ProseRenderRegistry,
    proseSupportedClaimTypes,
    proseRejectedClaimTypes
} from './prose-claim-verifier/renderers.mjs';
import { verifyProseClaims } from './prose-claim-verifier/verifier.mjs';

function parseArgs(argv)
{
    const options = {
        receipts: [],
        governanceOnly: false
    };
    for (let index = 0; index < argv.length; index += 1)
    {
        const arg = argv[index];
        if (arg === '--receipt' || arg === '--receipts')
        {
            const value = argv[index + 1];
            if (!value)
            {
                throw new Error(`${arg} requires a path`);
            }
            options.receipts.push(value);
            index += 1;
            continue;
        }
        if (arg === '--governance-only')
        {
            options.governanceOnly = true;
            continue;
        }
        if (arg === '--help' || arg === '-h')
        {
            options.help = true;
            continue;
        }
        throw new Error(`unknown argument ${arg}`);
    }
    return options;
}

function main()
{
    const options = parseArgs(process.argv.slice(2));
    if (options.help)
    {
        console.log(`Usage: node tools/docs/check-prose-claims.mjs [--governance-only] [--receipt path]...

Verifies controlled DocClaim prose against FactObservation receipts.
Default: governance scan. With --receipt: also verify prose claims.`);
        return;
    }

    const repositoryRoot = proseRoot || docClaimRoot;

    // Registry self-check: supported/rejected sets and unique registry.
    if (ProseRenderRegistry.kinds.length === 0)
    {
        console.error('[prose-claim] empty ProseRenderRegistry');
        process.exitCode = 1;
        return;
    }
    if (proseSupportedClaimTypes.length === 0 || proseRejectedClaimTypes.length === 0)
    {
        console.error('[prose-claim] supported/rejected claim type sets must be non-empty');
        process.exitCode = 1;
        return;
    }

    const violations = scanProseClaimGovernance(repositoryRoot);
    if (violations.length > 0)
    {
        for (const line of formatGovernanceViolations(violations))
        {
            console.error(`[prose-claim] ${line}`);
        }
        process.exitCode = 1;
        return;
    }

    const forbiddenCounts = countForbiddenProseSurfaces(repositoryRoot);
    if (forbiddenCounts.fuzzy !== 0 || forbiddenCounts.reviewed !== 0 || forbiddenCounts.baseline !== 0)
    {
        console.error(
            `[prose-claim] forbidden surfaces must be zero: fuzzy=${forbiddenCounts.fuzzy} reviewed=${forbiddenCounts.reviewed} baseline=${forbiddenCounts.baseline}`
        );
        process.exitCode = 1;
        return;
    }

    if (options.governanceOnly || options.receipts.length === 0)
    {
        console.log(
            `[prose-claim] governance clean; renders=${ProseRenderRegistry.kinds.length} supportedTypes=${proseSupportedClaimTypes.join(',')} forbiddenSurfaces=0`
        );
        return;
    }

    const receipt = parseRepositoryClaims(repositoryRoot);
    // Parse receipt has no pass evidence; verification is a separate consumer.
    const claims = receipt.claims;
    const result = verifyProseClaims({
        claims,
        receipts: options.receipts
    });
    if (!result.ok)
    {
        for (const diagnostic of result.diagnostics)
        {
            console.error(`[prose-claim] ${formatProseClaimDiagnostic(diagnostic)}`);
        }
        process.exitCode = 1;
        return;
    }
    console.log(
        `[prose-claim] ok claims=${claims.length} diagnostics=0 renders=${ProseRenderRegistry.kinds.length}`
    );
}

try
{
    main();
}
catch (error)
{
    if (error?.code)
    {
        console.error(`[prose-claim] ${error.code}: ${error.message}`);
    }
    else
    {
        console.error(error);
    }
    process.exitCode = 1;
}
