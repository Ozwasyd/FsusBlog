#!/usr/bin/env node

import {
    assertNoClaimSchemaDuplication,
    formatDocClaimError,
    parseRepositoryClaims,
    root,
    scanDocClaimGovernance,
    validateDocClaimSchemaContract,
    loadDocClaimSchema
} from './doc-claim.mjs';

function main()
{
    try
    {
        validateDocClaimSchemaContract(loadDocClaimSchema());
        assertNoClaimSchemaDuplication(root);
        const violations = scanDocClaimGovernance(root);
        if (violations.length > 0)
        {
            for (const violation of violations)
            {
                console.error(`[doc-claim] ${violation.code} (${violation.documentPath}): ${violation.message}`);
            }
            process.exitCode = 1;
            return;
        }
        const receipt = parseRepositoryClaims(root);
        console.log(
            `[doc-claim] schema, parse gates, and governance surfaces are clean; claims=${receipt.claims.length} digest=${receipt.contentDigest}`
        );
    }
    catch (error)
    {
        if (error?.code)
        {
            console.error(formatDocClaimError(error));
        }
        else
        {
            console.error(error);
        }
        process.exitCode = 1;
    }
}

main();
