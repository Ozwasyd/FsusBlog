import fs from 'node:fs';
import { URL } from 'node:url';

const { digestCanonical, readRetryPolicyRegistry, retryPolicyById, sha256 } = await import(new URL('../../test/attempt-provenance.mjs', import.meta.url));
const { validateReplayPlan } = await import(new URL('../../test/execution-replay-contract.mjs', import.meta.url));
const { validateJsonSchema } = await import(new URL('../schema-validator/validate.mjs', import.meta.url));

const schema = JSON.parse(fs.readFileSync(new URL('./contract.schema.json', import.meta.url), 'utf8'));
const physicalKinds = new Set(['atomic-producer', 'hard-prerequisite']);

export function isAtomicExecutable(node)
{
    return physicalKinds.has(node.kind);
}

export function exactAtomicItem(items, id, label)
{
    const matches = (items ?? []).filter((item) => item.id === id);
    if (matches.length !== 1)
    {
        throw new Error(`${label} requires exact-one authority: ${id}`);
    }
    return matches[0];
}

export function resolveAtomicReference(items, reference, label)
{
    const material = exactAtomicItem(items, reference.id, label);
    const { contentDigest, ...body } = material;
    if (contentDigest !== reference.contentDigest || digestCanonical(body) !== contentDigest)
    {
        throw new Error(`${label} content digest mismatch: ${reference.id}`);
    }
    return material;
}

export function resolveAtomicReplayPlan(items, reference)
{
    const material = exactAtomicItem(items, reference.id, 'replay plan');
    if (typeof material.bytes !== 'string' || typeof material.artifactPath !== 'string'
        || sha256(material.bytes) !== reference.contentDigest)
    {
        throw new Error('replay artifact byte digest mismatch');
    }
    const plan = validateReplayPlan(JSON.parse(material.bytes));
    if (plan.planDigest !== reference.planDigest)
    {
        throw new Error('canonical replay plan digest mismatch');
    }
    return { ...material, plan };
}

function sortedUnique(values, label)
{
    if (JSON.stringify(values) !== JSON.stringify([...new Set(values)].sort()))
    {
        throw new Error(`${label} must be sorted and unique`);
    }
}

function checkEdges(nodes)
{
    const byId = new Map(nodes.map((node) => [node.producerId, node]));
    if (byId.size !== nodes.length)
    {
        throw new Error('duplicate producerId');
    }
    const visited = new Set();
    const active = new Set();
    const visit = (id) =>
    {
        if (active.has(id))
        {
            throw new Error(`atomic dependency cycle: ${id}`);
        }
        if (visited.has(id))
        {
            return;
        }
        const node = byId.get(id);
        if (!node)
        {
            throw new Error(`unknown atomic dependency: ${id}`);
        }
        active.add(id);
        for (const dependency of [...node.dependsOn, ...node.settledDependsOn])
        {
            if (byId.get(dependency)?.kind === 'always-run-finalizer')
            {
                throw new Error('always-run finalizer cannot unlock a successor');
            }
            visit(dependency);
        }
        active.delete(id);
        visited.add(id);
    };
    nodes.forEach((node) => visit(node.producerId));
}

function checkExecutable(node, authorities)
{
    const ownership = (authorities.physicalOwnership ?? []).filter((item) => item.producerId === node.producerId);
    if (ownership.length !== 1 || ownership[0].logicalParentId !== node.logicalParentId
        || ownership[0].owner !== node.owner
        || digestCanonical(ownership[0].commandSourceRef) !== digestCanonical(node.commandSourceRef))
    {
        throw new Error(`missing, duplicate or ambiguous physical ownership: ${node.producerId}`);
    }
    const source = resolveAtomicReference(authorities.commandSources, node.commandSourceRef, 'command source');
    if (!Array.isArray(source.command) || source.command.length === 0
        || source.command.some((argument) => typeof argument !== 'string' || !argument)
        || source.executableAuthorityCount !== 1)
    {
        throw new Error('atomic command source must own one standalone executable authority');
    }
    const closure = resolveAtomicReference(authorities.inputClosures, source.inputClosureRef, 'input closure');
    if (closure.commandSourceId !== source.id || closure.commandDigest !== digestCanonical(source.command)
        || !Array.isArray(closure.unresolvedDynamicReads) || closure.unresolvedDynamicReads.length !== 0)
    {
        throw new Error('command source/input closure mismatch or unresolved dynamic reads');
    }
    const fixture = resolveAtomicReference(authorities.fixtureProfiles, node.fixtureProfile, 'fixture profile');
    const replay = resolveAtomicReplayPlan(authorities.replayPlans, node.replayPlanRef);
    if (replay.plan.producer.id !== node.producerId || replay.replayOwner !== node.replayOwner
        || replay.fixtureProfileDigest !== fixture.contentDigest
        || digestCanonical([replay.plan.command.executable, ...replay.plan.command.args]) !== digestCanonical(source.command))
    {
        throw new Error('replay plan is not bound to producer, replay owner and fixture');
    }
    const resource = resolveAtomicReference(authorities.resourceContracts, node.resourceContractRef, 'resource contract');
    if (resource.resources?.coordinationOnly === true)
    {
        throw new Error('executable child cannot be coordination-only');
    }
    if (node.stateAccessRef !== null)
    {
        const state = resolveAtomicReference(authorities.stateAccess, node.stateAccessRef, 'state access');
        if (state.producerId !== node.producerId || state.unknownAccess !== false)
        {
            throw new Error('unknown or cross-producer state access');
        }
    }
    else if (node.executionClass === 'runtime')
    {
        throw new Error('runtime child requires stateAccessRef');
    }
    const policy = retryPolicyById(node.attemptPolicyId, readRetryPolicyRegistry());
    if (policy.classification !== 'correctness' || policy.allowedRetries !== 0
        || policy.firstFailureBlocksQualification !== true || policy.retryOn.length !== 0)
    {
        throw new Error('correctness child must use zero-retry first-failure policy');
    }
    for (const field of ['serviceDependencies', 'artifacts', 'evidence'])
    {
        sortedUnique(node[field], `${node.producerId}.${field}`);
    }
    if (node.evidence.length === 0)
    {
        throw new Error('correctness child requires explicit evidence ownership');
    }
}

/**
 * Validate a matrix-owned attachment against supplied upstream projections.
 * This validates references; it does not admit or generate upstream authorities.
 */
export function validateAtomicProducerDeclarations(matrix, authorities)
{
    const declarations = matrix?.atomicProducerDeclarations;
    const errors = validateJsonSchema(declarations, schema);
    if (errors.length)
    {
        throw new Error(`atomic declarations schema: ${errors.join('; ')}`);
    }
    if (authorities?.matrixDigest !== digestCanonical(matrix))
    {
        throw new Error('atomic authorities must bind the exact matrix digest');
    }
    checkEdges(declarations.nodes);
    const parentIds = new Set(declarations.nodes.map((node) => node.logicalParentId));
    for (const parentId of parentIds)
    {
        const parents = (matrix.tiers ?? []).filter((tier) => tier.id === parentId);
        if (parents.length !== 1 || parents[0].command !== undefined
            || parents[0].executionMode !== 'projection' || parents[0].commandKind !== 'projection')
        {
            throw new Error(`logical parent must be exact-one command-free projection: ${parentId}`);
        }
        const children = declarations.nodes.filter((node) => node.logicalParentId === parentId && isAtomicExecutable(node));
        const projection = declarations.nodes.filter((node) => node.kind === 'logical-projection' && node.logicalParentId === parentId);
        const projectedProducers = Array.isArray(parents[0].projectFrom) ? parents[0].projectFrom : [parents[0].projectFrom];
        if (projection.length !== 1 || parents[0].executionOwner !== projection[0].owner
            || children.some((node) => node.projectionOwner !== projection[0].owner)
            || JSON.stringify(projectedProducers) !== JSON.stringify(children.map((node) => node.producerId).sort())
            || JSON.stringify(projection[0].settledDependsOn) !== JSON.stringify(children.map((node) => node.producerId).sort()))
        {
            throw new Error(`logical parent requires exact-one projection of its executable children: ${parentId}`);
        }
        const physical = (authorities.physicalOwnership ?? []).filter((item) => item.logicalParentId === parentId);
        if (JSON.stringify(children.map((node) => node.producerId).sort())
            !== JSON.stringify(physical.map((item) => item.producerId).sort()))
        {
            throw new Error(`physical ownership roster differs for parent: ${parentId}`);
        }
    }
    for (const node of declarations.nodes)
    {
        sortedUnique(node.dependsOn, `${node.producerId}.dependsOn`);
        sortedUnique(node.settledDependsOn, `${node.producerId}.settledDependsOn`);
        if (node.dependsOn.some((id) => node.settledDependsOn.includes(id)))
        {
            throw new Error('dependency cannot be both hard and settled');
        }
        if (isAtomicExecutable(node))
        {
            checkExecutable(node, authorities);
        }
        else
        {
            if (node.dependsOn.length !== 0 || node.settledDependsOn.length === 0)
            {
                throw new Error('coordination requires explicit settled dependencies only');
            }
            if (node.kind === 'always-run-finalizer')
            {
                const operation = resolveAtomicReference(authorities.finalizerOperations, node.operationRef, 'finalizer operation');
                if (operation.purpose !== node.finalizerPurpose || operation.command !== undefined
                    || operation.tests !== undefined || operation.build !== undefined)
                {
                    throw new Error('finalizer operation must be command-free cleanup or inventory');
                }
            }
        }
    }
    return structuredClone(declarations);
}
