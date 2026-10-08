import { createHash } from 'node:crypto';

// Controlled source-test value only; this is never a native receipt or DB claim.
export function currentSchemaContractFixture(sourceCommit = 'a'.repeat(40))
{
    return {
        schema: 'fsusblog.runtime-role-current-schema-contract.v1', stage: 'compiled-contract',
        evidenceClass: 'original-production-current-model-and-receipt-validation-contract',
        receiptFormat: 'fsusblog.current-schema-receipt.v1',
        target: { modelVersion: 'model.v1', extractorVersion: 'extractor.v1', generatorVersion: 'generator.v1',
            sourceDigest: 'b'.repeat(64), contentDigest: 'c'.repeat(64) },
        producer: { sourceCommit, producerId: 'fsusblog.current-schema-owned-projection.v1',
            producerAssemblySha256: 'd'.repeat(64), contractAssemblySha256: 'e'.repeat(64) },
        entityTableCount: 1, requiredRecipeCount: 1, inputDigest: 'f'.repeat(64),
        nativeVerifier: 'FsusBlog.Server.Infrastructure.SchemaMigration.CurrentSchemaReceiptAdmission.VerifyAsync',
        nativeStage: 'post-static-admission', actualDatabaseObserved: false, nativeClaimEligible: false
    };
}

export function sealRuntimeRoleFixture(value)
{
    const unsigned = {
        schema: value.schema, modes: value.modes, staticRoleCapabilities: value.staticRoleCapabilities,
        unsupportedCombinations: value.unsupportedCombinations, ownership: value.ownership,
        deploymentAuthority: value.deploymentAuthority, currentSchemaContract: value.currentSchemaContract
    };
    return { ...unsigned, observationDigest: createHash('sha256').update(JSON.stringify(unsigned)).digest('hex') };
}
