const digestPattern = /^[0-9a-f]{64}$/u;
const commitPattern = /^[0-9a-f]{40}$/u;

const manifestKeys = ['schema', 'visualInputDigest', 'visualInputCategories', 'fsusUi', 'screenshots'];
const screenshotKeys = [
    'id', 'file', 'route', 'viewport', 'theme', 'scope', 'sourceCommit', 'releaseId',
    'frontendBuildIdentity', 'backendBuildIdentity', 'fixtureDigest',
    'captureConfigurationDigest', 'fsusUi', 'visualInputDigest', 'pngSha256'
];
const fsusUiKeys = ['commit', 'tree', 'lockDigest', 'clean'];
const sharedIdentityFields = [
    'sourceCommit', 'releaseId', 'frontendBuildIdentity', 'backendBuildIdentity',
    'fixtureDigest', 'captureConfigurationDigest', 'visualInputDigest'
];

export function validateManifestShape(manifest, { schema, serialize })
{
    const errors = [];
    if (manifest.schema !== schema)
    {
        errors.push(`manifest schema must be ${schema}`);
    }
    if (serialize(Object.keys(manifest)) !== serialize(manifestKeys))
    {
        errors.push('manifest fields must use canonical order');
    }
    if (serialize(Object.keys(manifest.fsusUi ?? {})) !== serialize(fsusUiKeys)
        || !commitPattern.test(manifest.fsusUi?.commit ?? '')
        || !commitPattern.test(manifest.fsusUi?.tree ?? '')
        || !digestPattern.test(manifest.fsusUi?.lockDigest ?? '')
        || manifest.fsusUi?.clean !== true)
    {
        errors.push('manifest FsusUI identity is invalid or dirty');
    }
    const categoryNames = Object.keys(manifest.visualInputCategories ?? {});
    if (serialize(categoryNames) !== serialize([...categoryNames].sort())
        || categoryNames.some((name) => !digestPattern.test(manifest.visualInputCategories[name] ?? '')))
    {
        errors.push('manifest visual input categories must be sorted digests');
    }
    return errors;
}

export function createSharedIdentitySets()
{
    return new Map(sharedIdentityFields.map((field) => [field, new Set()]));
}

export function validateScreenshotMetadata(entry, { expected, manifest, serialize, validateReleaseId })
{
    const errors = [];
    if (serialize(Object.keys(entry)) !== serialize(screenshotKeys))
    {
        errors.push(`${entry.id ?? '<unknown>'} fields must use canonical order`);
    }
    for (const field of ['file', 'route', 'viewport', 'theme', 'scope'])
    {
        if (entry[field] !== expected[field])
        {
            errors.push(`${entry.id} has unknown ${field}: ${entry[field]}`);
        }
    }
    if (!commitPattern.test(entry.sourceCommit ?? ''))
    {
        errors.push(`${entry.id} sourceCommit is invalid`);
    }
    for (const field of ['fixtureDigest', 'captureConfigurationDigest', 'visualInputDigest', 'pngSha256'])
    {
        if (!digestPattern.test(entry[field] ?? ''))
        {
            errors.push(`${entry.id} ${field} is invalid`);
        }
    }
    for (const [field, suffix] of [
        ['frontendBuildIdentity', 'src/frontend'],
        ['backendBuildIdentity', 'src/backend']
    ])
    {
        if (entry[field] !== `${entry.sourceCommit}:${suffix}`)
        {
            errors.push(`${entry.id} ${field} is invalid`);
        }
    }
    for (const error of validateReleaseId(entry.releaseId, { forPublication: true }))
    {
        errors.push(`${entry.id} releaseId: ${error}`);
    }
    if (!entry.releaseId?.endsWith(`-${entry.sourceCommit?.slice(0, 12)}`))
    {
        errors.push(`${entry.id} releaseId is not bound to sourceCommit`);
    }
    if (serialize(entry.fsusUi) !== serialize(manifest.fsusUi))
    {
        errors.push(`${entry.id} FsusUI identity differs from manifest`);
    }
    if (entry.visualInputDigest !== manifest.visualInputDigest)
    {
        errors.push(`${entry.id} visualInputDigest differs from manifest`);
    }
    return errors;
}

export function validateSharedIdentityAgreement(identitySets)
{
    const errors = [];
    for (const [field, values] of identitySets)
    {
        if (values.size !== 1)
        {
            errors.push(`manifest screenshots disagree on ${field}`);
        }
    }
    return errors;
}
