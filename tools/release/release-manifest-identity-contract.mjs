const digest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
const exact = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
    && !['latest', 'previous', 'stable'].includes(value);
const closed = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...fields].sort());

// This is a projection within the sole release manifest, not another receipt or
// release schema. Actual byte, signature and native admissions remain separate.
export function validateReleaseIdentityRoster(manifest)
{
    const errors = [];
    const identity = manifest.identity;
    function fields(value, keys, label)
    {
        if (!closed(value, keys))
        {
            errors.push(`${label} must have closed exact fields`);
            return false;
        }
        return true;
    }
    function artifact(value, label)
    {
        if (!fields(value, ['reference', 'sha256'], label))
        {
            return;
        }
        if (typeof value.reference !== 'string' || !value.reference.startsWith('/')
            || value.reference !== value.reference.trim() || value.reference.includes('\\')
            || value.reference.split('/').some(part => ['latest', 'previous', 'stable', '.', '..'].includes(part))
            || [...value.reference].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
            || !digest(value.sha256))
        {
            errors.push(`${label} requires an explicit artifact reference and SHA-256`);
        }
    }
    function contract(value, label)
    {
        if (!fields(value, ['version', 'artifact'], label))
        {
            return;
        }
        if (!exact(value.version))
        {
            errors.push(`${label}.version must be a current exact value`);
        }
        artifact(value.artifact, `${label}.artifact`);
    }
    if (!fields(identity, ['source', 'backend', 'frontend', 'serviceWorker', 'contracts', 'runtime', 'provenance', 'signing'], 'identity'))
    {
        return errors;
    }
    if (fields(identity.source, ['commitSha', 'worktreeFingerprint', 'buildId', 'buildReceipt'], 'identity.source'))
    {
        if (identity.source.commitSha !== manifest.commitSha || !digest(identity.source.worktreeFingerprint)
            || !exact(identity.source.buildId))
        {
            errors.push('identity.source must bind the exact source/worktree/build');
        }
        artifact(identity.source.buildReceipt, 'identity.source.buildReceipt');
    }
    if (fields(identity.backend, ['imageDigest', 'artifact'], 'identity.backend'))
    {
        if (identity.backend.imageDigest !== manifest.imageDigest)
        {
            errors.push('identity.backend image must match the same candidate');
        }
        artifact(identity.backend.artifact, 'identity.backend.artifact');
    }
    if (fields(identity.frontend, ['buildId', 'buildReceipt', 'buildManifest', 'assetManifest', 'wasmArtifact'], 'identity.frontend'))
    {
        if (!exact(identity.frontend.buildId) || identity.frontend.buildId !== identity.source?.buildId || identity.frontend.buildManifest?.sha256 !== manifest.frontendManifestHash
            || identity.frontend.wasmArtifact?.sha256 !== manifest.wasmArtifactHash)
        {
            errors.push('identity.frontend must match current build/assets/Wasm');
        }
        for (const key of ['buildReceipt', 'buildManifest', 'assetManifest', 'wasmArtifact'])
        {
            artifact(identity.frontend[key], `identity.frontend.${key}`);
        }
    }
    if (fields(identity.serviceWorker, ['namespace', 'version', 'artifact'], 'identity.serviceWorker'))
    {
        if (!exact(identity.serviceWorker.namespace) || !exact(identity.serviceWorker.version))
        {
            errors.push('identity.serviceWorker must have an exact current namespace/version');
        }
        artifact(identity.serviceWorker.artifact, 'identity.serviceWorker.artifact');
    }
    if (fields(identity.contracts, ['aeds', 'protocol', 'wasmAbi', 'notification'], 'identity.contracts'))
    {
        for (const key of ['aeds', 'protocol', 'wasmAbi', 'notification'])
        {
            contract(identity.contracts[key], `identity.contracts.${key}`);
        }
    }
    if (fields(identity.runtime, ['roles', 'config', 'dependencies'], 'identity.runtime'))
    {
        for (const key of ['roles', 'config', 'dependencies'])
        {
            contract(identity.runtime[key], `identity.runtime.${key}`);
        }
    }
    contract(identity.provenance, 'identity.provenance');
    if (fields(identity.signing, ['algorithm', 'keyId', 'publicKey', 'trustPolicy'], 'identity.signing'))
    {
        if (identity.signing.algorithm !== 'ed25519' || !exact(identity.signing.keyId))
        {
            errors.push('identity.signing requires an explicit Ed25519 authority');
        }
        artifact(identity.signing.publicKey, 'identity.signing.publicKey');
        contract(identity.signing.trustPolicy, 'identity.signing.trustPolicy');
    }
    return errors;
}

// Artifact locations are sealed in contentDigest, but never choose candidateId.
export function releaseIdentityRosterContent(identity)
{
    if (Array.isArray(identity))
    {
        return identity.map(releaseIdentityRosterContent);
    }
    if (!identity || typeof identity !== 'object')
    {
        return identity;
    }
    return Object.fromEntries(Object.entries(identity).filter(([key]) => key !== 'reference')
        .map(([key, value]) => [key, releaseIdentityRosterContent(value)]));
}

export function releaseIdentityRosterArtifacts(identity)
{
    const artifacts = [];
    function visit(value, name)
    {
        if (closed(value, ['reference', 'sha256']))
        {
            artifacts.push({ name, ...value });
        }
        else if (value && typeof value === 'object')
        {
            for (const [key, child] of Object.entries(value))
            {
                visit(child, `${name}.${key}`);
            }
        }
    }
    visit(identity, 'identity');
    return artifacts;
}
