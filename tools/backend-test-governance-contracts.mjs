export const factWrapperContracts = [
    ['tests/backend/Unit/UnifiedCacheTests.cs',
        ['RemoveManyAsync_DeletesRedisKeysAndRegistryMembersAtomically'],
        'RemoveManyAsync_SourceUsesSingleLuaScriptForDeleteAndRegistryRemoval'],
    ['tests/backend/Unit/UnifiedCacheTests.cs',
        ['RemoveByPrefixMany_SourceGroupsByPolicyAndScansRegistryOnce'],
        'RemoveByPrefix_SourceUsesPagedSetScanInsteadOfSetMembers'],
    ['tests/backend/Unit/UserServiceValidationTests.cs',
        ['StartMfaSetupAsync_UsesAtomicMfaProfileUpsert'],
        'UserService_MfaProfileUpsertUsesSingleConflictSafeStatement'],
    ['tests/backend/Unit/UserServiceValidationTests.cs',
        ['VerifyMfaOrRecoveryCodeAsync_RecoveryCodeCasConflictReturnsFalse'],
        'UserService_RecoveryCodeConsumptionUsesHashCompareAndSwap'],
    ['tests/backend/Unit/WebApplicationCompositionExtensionsTests.cs',
        ['PublicAotHtmlFastPath_PrefersBrotliVariantAndWritesPreencodedBytes', 'PublicAotHtmlFastPath_PreencodedVariantsHaveExpectedByteShape'],
        'PublicAotHtmlFastPath_SourceAvoidsStringContentAndPerRequestUtf8Encode'],
    ['tests/backend/Unit/WebApplicationCompositionExtensionsTests.cs',
        ['DynamicManifest_ReturnsNotModifiedForMatchingEtagAndChangesEtagWhenSeoChanges'],
        'DynamicManifest_SourceUsesDerivedBytesCacheAndConditionalEtag'],
    ['tests/backend/Unit/WebApplicationCompositionExtensionsTests.cs',
        ['ImmutableSearchShardKeepsLongCacheAndRemovesValidators'],
        'ImmutableStaticAssets_KeepLongCacheWithoutValidators']
];

const openApiPackageId = 'Microsoft.AspNetCore.OpenApi';
const openApiPackageVersion = '10.0.9';

function xmlItems(source, itemName)
{
    const withoutComments = source.replace(/<!--[\s\S]*?-->/gu, '');
    const items = [];
    const expression = new RegExp(
        `<${itemName}\\b([^>]*?)(?:\\/\\s*>|>([\\s\\S]*?)<\\/${itemName}\\s*>)`,
        'gu'
    );
    for (const match of withoutComments.matchAll(expression))
    {
        const attributes = new Map();
        const duplicateAttributes = new Set();
        const attributeExpression = /([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(["'])([\s\S]*?)\2/gu;
        for (const attribute of match[1].matchAll(attributeExpression))
        {
            if (attributes.has(attribute[1]))
            {
                duplicateAttributes.add(attribute[1]);
            }
            attributes.set(attribute[1], attribute[3]);
        }
        const malformedAttributes = match[1].replace(attributeExpression, '').trim() !== '';
        items.push({
            attributes,
            duplicateAttributes,
            malformedAttributes,
            body: match[2] ?? ''
        });
    }
    return items;
}

function isOpenApiPackageId(value)
{
    return typeof value === 'string' && value.toLowerCase() === openApiPackageId.toLowerCase();
}

function referencesOpenApiPackage(item)
{
    return isOpenApiPackageId(item.attributes.get('Include')) ||
        isOpenApiPackageId(item.attributes.get('Update'));
}

function hasOnlyAttributes(item, allowedNames)
{
    return [...item.attributes.keys()].every((name) => allowedNames.has(name));
}

export function verifyCentralOpenApiPackageContract(centralPackages, serverProject)
{
    const errors = [];
    const centralEntries = xmlItems(centralPackages, 'PackageVersion')
        .filter(referencesOpenApiPackage);
    if (centralEntries.length !== 1)
    {
        errors.push(`central package authority must declare exactly one ${openApiPackageId} PackageVersion`);
    }
    else
    {
        const centralEntry = centralEntries[0];
        if (centralEntry.malformedAttributes ||
            centralEntry.duplicateAttributes.size > 0 ||
            centralEntry.attributes.get('Include') !== openApiPackageId ||
            !hasOnlyAttributes(centralEntry, new Set(['Include', 'Version'])) ||
            centralEntry.body.trim() !== '' ||
            centralEntry.attributes.get('Version') !== openApiPackageVersion)
        {
            errors.push(`central package authority must bind ${openApiPackageId} exactly to ${openApiPackageVersion}`);
        }
    }

    const projectReferences = xmlItems(serverProject, 'PackageReference')
        .filter(referencesOpenApiPackage);
    if (projectReferences.length !== 1)
    {
        errors.push(`server project must declare exactly one ${openApiPackageId} PackageReference`);
    }
    else
    {
        const projectReference = projectReferences[0];
        if (projectReference.malformedAttributes ||
            projectReference.duplicateAttributes.size > 0 ||
            projectReference.attributes.get('Include') !== openApiPackageId)
        {
            errors.push(`${openApiPackageId} PackageReference must use one canonical Include without an Update override`);
        }
        if (!hasOnlyAttributes(projectReference, new Set(['Include', 'GeneratePathProperty'])) ||
            projectReference.body.trim() !== '')
        {
            errors.push(`${openApiPackageId} PackageReference must not declare inline Version or VersionOverride`);
        }
        if (projectReference.attributes.get('GeneratePathProperty') !== 'true')
        {
            errors.push(`${openApiPackageId} PackageReference must set GeneratePathProperty exactly to true`);
        }
    }
    return errors;
}
