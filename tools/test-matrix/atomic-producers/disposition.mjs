import fs from 'node:fs';
import { URL } from 'node:url';

const { digestCanonical, sealContentDigest } = await import(new URL('../../test/attempt-provenance.mjs', import.meta.url));
const { validateJsonSchema } = await import(new URL('../schema-validator/validate.mjs', import.meta.url));

const schema = JSON.parse(fs.readFileSync(new URL('./disposition.schema.json', import.meta.url), 'utf8'));

function identity(entry)
{
    return JSON.stringify([entry.location, entry.parentId, entry.childCommandIdentity]);
}

function ordered(entries)
{
    return [...entries].sort((left, right) => identity(left).localeCompare(identity(right), 'en'));
}

export function compositeObservationDigest(observations)
{
    return digestCanonical(ordered(observations));
}

/**
 * Audit only: observations come from source owners, and never become topology.
 * Every observed authority requires one disposition and one migration child.
 */
export function validateCompositeLeafDisposition(inventory, { matrixDigest, observations, migrationOwners })
{
    const errors = validateJsonSchema(inventory, schema);
    if (errors.length)
    {
        throw new Error(`disposition schema: ${errors.join('; ')}`);
    }
    if (inventory.matrixDigest !== matrixDigest
        || inventory.observationDigest !== compositeObservationDigest(observations))
    {
        throw new Error('inventory matrix or source observation digest mismatch');
    }
    const observed = new Map(observations.map((entry) => [identity(entry), entry]));
    const disposed = new Map(inventory.entries.map((entry) => [identity(entry), entry]));
    if (observed.size !== observations.length || disposed.size !== inventory.entries.length)
    {
        throw new Error('duplicate observed child or disposition');
    }
    if (JSON.stringify([...observed.keys()].sort()) !== JSON.stringify([...disposed.keys()].sort()))
    {
        throw new Error('hidden executable children: source/disposition roster differs');
    }
    const childOwners = new Map();
    for (const entry of inventory.entries)
    {
        if (entry.migrationOwner === 2244 || !Array.isArray(migrationOwners)
            || migrationOwners.filter((id) => id === entry.migrationOwner).length !== 1)
        {
            throw new Error('migrationOwner must reference exact-one assigned tracking child');
        }
        const key = JSON.stringify([entry.parentId, entry.childCommandIdentity]);
        if (childOwners.has(key) && childOwners.get(key) !== entry.migrationOwner)
        {
            throw new Error('one child has multiple migration owners');
        }
        childOwners.set(key, entry.migrationOwner);
        const source = observed.get(identity(entry));
        if (digestCanonical(source.commandSourceRef) !== digestCanonical(entry.commandSourceRef))
        {
            throw new Error('disposition command source ref mismatch');
        }
        const allowed = {
            producer: ['atomic-producer', 'hard-prerequisite'],
            cleanup: ['always-run-finalizer'],
            inventory: ['always-run-finalizer', 'settled-join'],
            projection: ['settled-join'],
            diagnostic: ['diagnostic-only'],
            embedded: ['not-independent']
        }[source.authorityKind];
        if (!allowed?.includes(entry.classification))
        {
            throw new Error('executable child has an incompatible coordination-only disposition');
        }
        if (!(source.proofTestIds ?? []).includes(entry.proofTestId))
        {
            throw new Error('disposition proofTestId has no source-owner proof');
        }
    }
    return sealContentDigest({ ...inventory, entries: ordered(inventory.entries) });
}

export function renderCompositeLeafDisposition(inventory, authorities)
{
    const validated = validateCompositeLeafDisposition(inventory, authorities);
    const rows = validated.entries.map((entry) =>
        `| ${entry.parentId} | ${entry.childCommandIdentity} | ${entry.classification} | #${entry.migrationOwner} | ${entry.proofTestId} |`);
    return [
        '# Composite leaf disposition projection',
        '',
        'Audit projection only; tests/matrix.yml remains the topology owner.',
        `Matrix digest: ${validated.matrixDigest}`,
        `Inventory digest: ${validated.contentDigest}`,
        '',
        '| Parent | Child | Disposition | Migration owner | Proof |',
        '| --- | --- | --- | --- | --- |',
        ...rows,
        ''
    ].join('\n');
}
