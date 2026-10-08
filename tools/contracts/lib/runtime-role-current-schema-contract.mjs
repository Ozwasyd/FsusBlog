import { createHash } from 'node:crypto';

export const runtimeRoleObservationSchema = 'fsusblog.runtime-role-observation.v3';
export const runtimeRoleCurrentSchemaContractSchema = 'fsusblog.runtime-role-current-schema-contract.v1';
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const text = (value) => typeof value === 'string' && value.length > 0 && value.trim() === value;

// The compiled artifact proves a current production contract. It never grants
// receipt admission or claims a live database. Native consumers must independently
// invoke the original Server verifier after the static-admission stage succeeds.
export function validateRuntimeRoleCurrentSchemaContract(value, { sourceCommit } = {})
{
    const contract = value?.currentSchemaContract;
    const target = contract?.target;
    const producer = contract?.producer;
    return value?.schema === runtimeRoleObservationSchema
    && exactKeys(value, ['schema', 'modes', 'staticRoleCapabilities', 'unsupportedCombinations',
        'ownership', 'deploymentAuthority', 'currentSchemaContract', 'observationDigest'])
    && exactKeys(contract, ['schema', 'stage', 'evidenceClass', 'receiptFormat', 'target', 'producer',
        'entityTableCount', 'requiredRecipeCount', 'inputDigest', 'nativeVerifier', 'nativeStage',
        'actualDatabaseObserved', 'nativeClaimEligible'])
    && contract.schema === runtimeRoleCurrentSchemaContractSchema
    && contract.stage === 'compiled-contract'
    && contract.evidenceClass === 'original-production-current-model-and-receipt-validation-contract'
    && contract.receiptFormat === 'fsusblog.current-schema-receipt.v1'
    && exactKeys(target, ['modelVersion', 'extractorVersion', 'generatorVersion', 'sourceDigest', 'contentDigest'])
    && ['modelVersion', 'extractorVersion', 'generatorVersion'].every((key) => text(target[key]))
    && digest(target.sourceDigest) && digest(target.contentDigest)
    && exactKeys(producer, ['sourceCommit', 'producerId', 'producerAssemblySha256', 'contractAssemblySha256'])
    && /^[a-f0-9]{40}$/u.test(producer.sourceCommit ?? '') && producer.sourceCommit !== '0'.repeat(40)
    && (!sourceCommit || producer.sourceCommit === sourceCommit)
    && producer.producerId === 'fsusblog.current-schema-owned-projection.v1'
    && digest(producer.producerAssemblySha256) && digest(producer.contractAssemblySha256)
    && Number.isSafeInteger(contract.entityTableCount) && contract.entityTableCount > 0
    && Number.isSafeInteger(contract.requiredRecipeCount) && contract.requiredRecipeCount > 0
    && digest(contract.inputDigest)
    && contract.nativeVerifier === 'FsusBlog.Server.Infrastructure.SchemaMigration.CurrentSchemaReceiptAdmission.VerifyAsync'
    && contract.nativeStage === 'post-static-admission'
    && contract.actualDatabaseObserved === false && contract.nativeClaimEligible === false
    && value.observationDigest === createHash('sha256').update(JSON.stringify({
        schema: value.schema, modes: value.modes, staticRoleCapabilities: value.staticRoleCapabilities,
        unsupportedCombinations: value.unsupportedCombinations, ownership: value.ownership,
        deploymentAuthority: value.deploymentAuthority, currentSchemaContract: contract
    })).digest('hex');
}
