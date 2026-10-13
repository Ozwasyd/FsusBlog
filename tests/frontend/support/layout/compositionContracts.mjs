import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { resolveLocalFsusUiRepositoryRoot } from '@fsusblog/layout-governance/fsusui-source-resolver';
import { validateJsonSchema } from '@fsusblog/layout-governance/schema-validator';

export const compositionMatrixPath = 'tests/frontend/fixtures/layout-archetype-matrix.json';
export const compositionLedgerPath = 'tests/frontend/fixtures/layout-visual-change-ledger.json';
export const compositionSchemaPath = 'config/schemas/layout-composition-contract.schema.json';
export const compositionValidatorPath = 'tests/frontend/support/layout/compositionContracts.mjs';
export const compositionIdentitySchema = 'fsusblog.layout-composition-identity.v1';
export const compositionValidatorVersion = 'fsusblog.layout-composition-validator.v1';

function canonical(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonical);
    }
    if (value !== null && typeof value === 'object')
    {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    }
    return value;
}

export function compositionDigest(value)
{
    return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('hex');
}

function fail(message)
{
    const error = new Error(`[layout-composition-contract] ${message}`);
    error.code = 'layout-composition-contract-invalid';
    throw error;
}

function unique(values, label)
{
    if (new Set(values).size !== values.length)
    {
        fail(`duplicate ${label}`);
    }
}

function pointerValue(document, pointer)
{
    if (pointer === 'source-file')
    {
        return typeof document === 'string' && document.trim() ? document : undefined;
    }
    return pointer.split('/').slice(1).reduce((value, part) =>
    {
        const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
        return value !== null && typeof value === 'object' && Object.hasOwn(value, key) ? value[key] : undefined;
    }, document);
}

function fixtureValue(reference, matrix, fixtureDocuments)
{
    const document = reference.source === compositionMatrixPath ? matrix : fixtureDocuments[reference.source];
    const value = pointerValue(document, reference.pointer);
    if (value === undefined || (Array.isArray(value) && value.length === 0))
    {
        fail(`missing required fixture ${reference.source}${reference.pointer}`);
    }
    return value;
}

function contractFixtureRefs(contract)
{
    return [
        ...contract.requiredStateFixtures.flatMap(({ fixtureRef }) => fixtureRef ? [fixtureRef] : []),
        ...contract.requiredViewportThemeMatrix.flatMap((entry) => [entry.viewportsRef, entry.themesRef, entry.mediaRef])
    ];
}

export function compositionFixtureSources(matrix)
{
    return [...new Set([...matrix.compositionGovernance.fixtureInfrastructureRefs,
        ...matrix.archetypes.flatMap(({ compositionContract }) => contractFixtureRefs(compositionContract))]
        .map(({ source }) => source).filter((source) => source !== compositionMatrixPath))].sort();
}

/** Pure data validation only: no SFC parsing, DOM probes, browser or visual verdict. */
export function validateCompositionContracts({ matrix, schema, ledger, fixtureDocuments, authorityDocuments })
{
    const schemaErrors = validateJsonSchema(matrix, schema);
    if (schemaErrors.length)
    {
        fail(schemaErrors.join('; '));
    }
    const governance = matrix.compositionGovernance;
    for (const reference of governance.fixtureInfrastructureRefs)
    {
        fixtureValue(reference, matrix, fixtureDocuments);
    }
    unique(matrix.archetypes.map(({ surface, kind }) => `${surface}/${kind}`), 'archetype');
    unique(matrix.archetypes.map(({ kind }) => kind), 'archetype kind');
    unique(governance.designSources.map(({ id }) => id), 'design source');
    unique(governance.capabilityBindings.map(({ issue }) => issue), 'capability binding');
    for (const binding of governance.capabilityBindings)
    {
        if ((binding.issue === 1814) !== (binding.capability === 'authoring-product-model'))
        {
            fail('capability owner mismatch');
        }
    }
    const authorityIds = new Set(governance.designSources.map(({ id }) => id));
    for (const source of governance.designSources)
    {
        const document = authorityDocuments[source.id];
        if (!document || document.repository !== source.repository || document.path !== source.path
            || typeof document.content !== 'string' || !document.content.trim())
        {
            fail(`missing or mismatched design source ${source.id}`);
        }
        if ((source.id === 'fsusui-design') !== (source.repository === 'FsusUI'))
        {
            fail(`wrong design source owner ${source.id}`);
        }
    }
    if (ledger?.version !== 'fsusblog-layout-visual-change-ledger-v1' || ledger.sourceIssue !== 1313
        || !Array.isArray(ledger.entries))
    {
        fail('canonical visual ledger missing');
    }
    const archetypeIds = new Set(matrix.archetypes.map(({ surface, kind }) => `${surface}/${kind}`));
    for (const entry of ledger.entries)
    {
        if (!Array.isArray(entry.archetypes) || entry.archetypes.some((id) => !archetypeIds.has(id)))
        {
            fail('visual ledger references an unknown archetype');
        }
    }
    for (const entry of matrix.archetypes)
    {
        const id = `${entry.surface}/${entry.kind}`;
        const contract = entry.compositionContract;
        if ((entry.surface === 'public') === (contract.surfaceProfile === 'task'))
        {
            fail(`${id}: wrong surface profile`);
        }
        if ((entry.kind === 'reading') !== (contract.surfaceProfile === 'reading'))
        {
            fail(`${id}: reading profile mismatch`);
        }
        const regions = [contract.primaryRegion, ...contract.allowedSecondaryRegions];
        const regionIds = new Set(regions.map((region) => region.id));
        const ownerIds = new Set(regions.map((region) => region.ownerId));
        unique(regions.map((region) => region.id), `${id} region`);
        unique(regions.map((region) => region.ownerId), `${id} owner`);
        const knownRegion = (regionId) =>
        {
            if (!regionIds.has(regionId))
            {
                fail(`${id}: unowned region ${regionId}`);
            }
        };
        const knownOwner = (ownerId) =>
        {
            if (!ownerIds.has(ownerId))
            {
                fail(`${id}: unowned action/chrome owner ${ownerId}`);
            }
        };
        const knownAuthority = (authorityId) =>
        {
            if (!authorityIds.has(authorityId) || !contract.designSourceRefs.includes(authorityId))
            {
                fail(`${id}: unbound design authority ${authorityId}`);
            }
        };
        if (contract.designSourceRefs.length !== authorityIds.size)
        {
            fail(`${id}: incomplete design-source binding`);
        }
        knownRegion(contract.primaryVisualAnchor.regionId);
        if (contract.primaryVisualAnchor.regionId !== contract.primaryRegion.id)
        {
            fail(`${id}: competing primary anchor`);
        }
        knownRegion(contract.pageHeadingOwner.regionId);
        knownOwner(contract.pageHeadingOwner.id);
        if (regions.find((region) => region.id === contract.pageHeadingOwner.regionId).ownerId !== contract.pageHeadingOwner.id)
        {
            fail(`${id}: page heading owner does not own its region`);
        }
        knownAuthority(contract.pageHeadingOwner.authorityRef);
        const flowIds = regions.filter((region) => !region.placement || region.placement === 'flow').map((region) => region.id);
        unique(contract.contentOrder, `${id} content order`);
        if (flowIds.length !== contract.contentOrder.length || flowIds.some((regionId) => !contract.contentOrder.includes(regionId)))
        {
            fail(`${id}: content order must cover every flow region exactly once`);
        }
        if (contract.contentOrder[0] !== contract.pageHeadingOwner.regionId)
        {
            fail(`${id}: heading must precede content/actions`);
        }
        for (const regionId of contract.contentOrder)
        {
            knownRegion(regionId);
        }
        const action = contract.actionPriority;
        if (action.kind === 'exact-one')
        {
            for (const ownerId of action.secondaryOwnerIds)
            {
                knownOwner(ownerId);
            }
            knownOwner(action.primaryOwnerId);
            if (action.secondaryOwnerIds.includes(action.primaryOwnerId))
            {
                fail(`${id}: same-priority action owner`);
            }
        }
        else
        {
            const states = contract.requiredStateFixtures.filter(({ dimensionId }) => dimensionId === action.stateDimensionId);
            if (states.length < 2)
            {
                fail(`${id}: exclusive actions require a declared semantic state dimension`);
            }
            unique(action.cases.map(({ stateId }) => stateId), `${id} exclusive action state`);
            if (states.length !== action.cases.length || states.some((state) => !action.cases.some(({ stateId }) => stateId === state.id)))
            {
                fail(`${id}: exclusive actions must cover every referenced state`);
            }
            for (const candidate of action.cases)
            {
                if (candidate.primaryCardinality === 1)
                {
                    knownOwner(candidate.primaryOwnerId);
                }
                unique(candidate.secondaryActions.map(({ actionId }) => actionId), `${id} secondary action`);
                for (const secondary of candidate.secondaryActions)
                {
                    knownOwner(secondary.ownerId);
                    if (secondary.ownerId === candidate.primaryOwnerId)
                    {
                        fail(`${id}: same-priority action owner`);
                    }
                }
            }
        }
        unique(contract.fixedChromeOwners.map(({ id: ownerId }) => ownerId), `${id} chrome owner`);
        unique(contract.fixedChromeOwners.map(({ responsibility }) => responsibility), `${id} fixed chrome responsibility`);
        for (const chrome of contract.fixedChromeOwners)
        {
            knownRegion(chrome.regionId);
            knownOwner(chrome.id);
            knownAuthority(chrome.authorityRef);
            if (!regions.some((region) => region.id === chrome.regionId && region.ownerId === chrome.id && region.placement === 'chrome'))
            {
                fail(`${id}: chrome does not own a chrome region`);
            }
        }
        unique(contract.surfaceRoles.map(({ regionId }) => regionId), `${id} surface role`);
        if (contract.surfaceRoles.length !== regions.length)
        {
            fail(`${id}: missing surface role`);
        }
        for (const surface of contract.surfaceRoles)
        {
            knownRegion(surface.regionId);
            knownAuthority(surface.authorityRef);
            const expected = surface.role === 'document' ? 'flat' : surface.role === 'overlay' ? 'floating' : 'boundary';
            if (surface.material !== expected)
            {
                fail(`${id}: decorative or unowned material`);
            }
            if (['status', 'risk'].includes(surface.role) && surface.authorityRef !== 'blog-surface-profiles')
            {
                fail(`${id}: status/risk requires the Blog surface-role authority`);
            }
            const region = regions.find((candidate) => candidate.id === surface.regionId);
            if ((region.placement === 'overlay') !== (surface.role === 'overlay'))
            {
                fail(`${id}: overlay role mismatch`);
            }
        }
        const primarySurface = contract.surfaceRoles.find(({ regionId }) => regionId === contract.primaryRegion.id);
        if (primarySurface.role !== 'document')
        {
            fail(`${id}: primary content must remain flat document surface`);
        }
        const edges = new Map();
        for (const pair of contract.allowedSurfaceNesting.pairs)
        {
            knownRegion(pair.parentRegionId);
            knownRegion(pair.childRegionId);
            if (pair.parentRegionId === pair.childRegionId || edges.has(pair.childRegionId))
            {
                fail(`${id}: duplicate/cyclic nesting`);
            }
            edges.set(pair.childRegionId, pair.parentRegionId);
            const parent = contract.surfaceRoles.find(({ regionId }) => regionId === pair.parentRegionId);
            const child = contract.surfaceRoles.find(({ regionId }) => regionId === pair.childRegionId);
            if (parent.role !== 'document' || !['control-group', 'data-region'].includes(child.role))
            {
                fail(`${id}: nested panel/card wall or decorative shell`);
            }
        }
        unique(contract.firstFoldInvariants.map(({ id: invariantId }) => invariantId), `${id} first-fold invariant`);
        for (const invariant of contract.firstFoldInvariants)
        {
            knownRegion(invariant.regionId);
            knownAuthority(invariant.authorityRef);
        }
        unique(contract.requiredStateFixtures.map(({ id: stateId }) => stateId), `${id} required state`);
        unique(contract.requiredStateFixtures.map(({ dimensionId, value }) => `${dimensionId}/${value}`), `${id} semantic state condition`);
        for (const state of contract.requiredStateFixtures)
        {
            if (!state.fixtureRef)
            {
                continue;
            }
            const values = fixtureValue(state.fixtureRef, matrix, fixtureDocuments);
            if (Array.isArray(values) && values.every((value) => typeof value === 'string') && !values.includes(state.value))
            {
                fail(`${id}: unrelated fixture cannot bind required state ${state.id}`);
            }
        }
        for (const reference of contractFixtureRefs(contract))
        {
            fixtureValue(reference, matrix, fixtureDocuments);
        }
        for (const dimensions of contract.requiredViewportThemeMatrix)
        {
            for (const reference of [dimensions.viewportsRef, dimensions.themesRef, dimensions.mediaRef])
            {
                if (!Array.isArray(fixtureValue(reference, matrix, fixtureDocuments)))
                {
                    fail(`${id}: matrix dimension is not an array`);
                }
            }
            const themes = fixtureValue(dimensions.themesRef, matrix, fixtureDocuments);
            if (!themes.includes('light') || !themes.includes('dark'))
            {
                fail(`${id}: incomplete required themes`);
            }
        }
        if (!contract.requiredViewportThemeMatrix.some(({ viewportsRef, themesRef, mediaRef }) =>
            viewportsRef.source === compositionMatrixPath && viewportsRef.pointer === '/coverage/viewports'
            && themesRef.source === compositionMatrixPath && themesRef.pointer === '/coverage/themes'
            && mediaRef.source === compositionMatrixPath && mediaRef.pointer === '/coverage/media'))
        {
            fail(`${id}: missing canonical archetype matrix coverage reference`);
        }
    }
    return {
        status: 'contract-defined',
        archetypes: matrix.archetypes.length,
        pendingCapabilities: governance.capabilityBindings.map(({ issue, capability, status }) => ({ issue, capability, status })),
        runtimeFixtureBinding: { status: governance.fixtureBindingStatus, ownerIssue: governance.fixtureBindingOwnerIssue },
        pendingStateBindings: matrix.archetypes.flatMap(({ surface, kind, compositionContract }) =>
            compositionContract.requiredStateFixtures.map(({ id, fixtureRef, bindingOwnerIssue }) => ({
                archetype: `${surface}/${kind}`, stateId: id, fixtureRef, ownerIssue: bindingOwnerIssue
            })))
    };
}

export function requireCompositionRuntimeBindings(inputs)
{
    const result = validateCompositionContracts(inputs);
    if (result.pendingCapabilities.length || result.pendingStateBindings.length)
    {
        fail('current runtime state/capability bindings are pending; a source contract is not acceptance');
    }
    return result;
}

/** Callers supply actual current source/baseline identities; this emits no runtime or visual receipt. */
export function createCompositionIdentity(inputs, { sourceCommit, fsusUIBaselineIdentity })
{
    validateCompositionContracts(inputs);
    if (!/^[a-f0-9]{40}$/.test(sourceCommit ?? ''))
    {
        fail('missing exact source commit');
    }
    const baselineErrors = validateJsonSchema(fsusUIBaselineIdentity, inputs.fsusUIBaselineSchema);
    if (baselineErrors.length)
    {
        fail(`FsusUI baseline identity: ${baselineErrors.join('; ')}`);
    }
    const unsignedBaseline = { ...fsusUIBaselineIdentity };
    delete unsignedBaseline.baselineDigest;
    if (fsusUIBaselineIdentity.baselineDigest !== compositionDigest(unsignedBaseline))
    {
        fail('FsusUI baseline identity tampered');
    }
    const { matrix, schema, ledger, fixtureDocuments, authorityDocuments } = inputs;
    if (typeof inputs.validatorSource !== 'string' || !inputs.validatorSource.trim())
    {
        fail('missing validator source identity');
    }
    const identity = {
        schema: compositionIdentitySchema,
        validatorVersion: compositionValidatorVersion,
        validatorDigest: compositionDigest(inputs.validatorSource),
        sourceCommit,
        fsusUIBaselineIdentityDigest: fsusUIBaselineIdentity.baselineDigest,
        fsusUIMode: fsusUIBaselineIdentity.sourceKind === 'local-source' ? 'local' : 'published',
        archetypeMatrixDigest: compositionDigest(matrix),
        compositionContractDigest: compositionDigest({
            version: matrix.compositionGovernance.schema,
            contracts: matrix.archetypes.map(({ surface, kind, compositionContract }) => ({ archetype: `${surface}/${kind}`, compositionContract }))
        }),
        contractSchemaDigest: compositionDigest(schema),
        designSourceDigest: compositionDigest(matrix.compositionGovernance.designSources.map((source) => ({
            ...source, contentDigest: compositionDigest(authorityDocuments[source.id].content)
        }))),
        fixtureSourceDigest: compositionDigest({ coverage: matrix.coverage, sources: compositionFixtureSources(matrix).map((source) => ({
            source, contentDigest: compositionDigest(fixtureDocuments[source])
        })) }),
        visualLedgerDigest: compositionDigest(ledger)
    };
    return { ...identity, identityDigest: compositionDigest(identity) };
}

export function verifyCompositionIdentity(candidate, current)
{
    const keys = Object.keys(current).sort();
    if (!candidate || JSON.stringify(Object.keys(candidate).sort()) !== JSON.stringify(keys))
    {
        fail('identity fields missing or unowned');
    }
    const unsigned = { ...candidate };
    delete unsigned.identityDigest;
    if (candidate.identityDigest !== compositionDigest(unsigned))
    {
        fail('identity content tampered');
    }
    for (const key of keys.filter((field) => field !== 'identityDigest'))
    {
        if (candidate[key] !== current[key])
        {
            fail(`stale ${key}`);
        }
    }
    return true;
}

/** Read only the sole matrix/ledger, declared fixtures and current design documents. */
export function loadCompositionInputs({ repositoryRoot, fsusUIRoot })
{
    const upstream = fsusUIRoot ?? resolveLocalFsusUiRepositoryRoot({
        repositoryRoot,
        override: process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT
    });
    if (!upstream)
    {
        fail('current effective FsusUI design source unavailable');
    }
    const read = (path) => readFileSync(resolve(repositoryRoot, path), 'utf8');
    const matrix = JSON.parse(read(compositionMatrixPath));
    const schema = JSON.parse(read(compositionSchemaPath));
    const ledger = JSON.parse(read(compositionLedgerPath));
    const validatorSource = read(compositionValidatorPath);
    const fsusUIBaselineSchema = JSON.parse(read('.agents/skills/fsusblog-design-conformance/contracts/fsusui-baseline-identity.schema.json'));
    // Validate shape before following any declared path. No glob or fallback registry.
    const errors = validateJsonSchema(matrix, schema);
    if (errors.length)
    {
        fail(errors.join('; '));
    }
    const fixtureDocuments = Object.fromEntries(compositionFixtureSources(matrix).map((path) =>
    {
        const content = read(path);
        return [path, path.endsWith('.json') ? JSON.parse(content) : content];
    }));
    const authorityDocuments = Object.fromEntries(matrix.compositionGovernance.designSources.map((source) => [source.id, {
        repository: source.repository,
        path: source.path,
        content: readFileSync(resolve(source.repository === 'FsusUI' ? upstream : repositoryRoot, source.path), 'utf8')
    }]));
    return { matrix, schema, ledger, fixtureDocuments, authorityDocuments, fsusUIBaselineSchema, validatorSource };
}
