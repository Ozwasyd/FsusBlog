const { readCatalog } = await import(new URL('../../../tools/test/runtime-scenario-host.mjs', import.meta.url));
const { digestCanonical } = await import(new URL('../../../tools/test-fixtures/receipt/canonical.mjs', import.meta.url));

// Controlled verifier ports test fail-closed consumer behavior only. They are
// deliberately not runtime receipts or canonical upstream implementations.
export function createSecurityAtomicFixture()
{
    const context = {
        runId: 'controlled-security-run',
        namespace: 'controlled-security-namespace',
        profileId: 'security-clean',
        sourceRevision: 'a'.repeat(40),
        runtimeDigest: digestCanonical('controlled-runtime'),
        stateCatalogDigest: digestCanonical('controlled-state-catalog')
    };
    const records = new Map();
    const calls = [];
    const declarations = new Map();
    function reference(kind, id = kind, fields = {})
    {
        const document = { kind, id, context: structuredClone(context), ready: true, ...fields };
        const ref = {
            owner: `controlled-${kind}-owner`,
            sourceRevision: 'b'.repeat(40),
            path: `controlled/${id}.json`,
            contentDigest: digestCanonical(document)
        };
        records.set(ref.path, { reference: ref, document });
        return ref;
    }
    function verify(kind)
    {
        return (ref, expectedContext) =>
        {
            calls.push(kind);
            const record = records.get(ref.path);
            if (!record || record.document.kind !== kind || !record.document.ready
              || digestCanonical(record.document) !== ref.contentDigest
              || digestCanonical(record.reference) !== digestCanonical(ref)
              || digestCanonical(record.document.context) !== digestCanonical(expectedContext))
            {
                throw new Error(`controlled ${kind} owner rejected evidence`);
            }
            return ref.contentDigest;
        };
    }
    const ownerVerifiers = Object.fromEntries([
        'runtime', 'fixture', 'reset', 'stateAccess', 'isolation', 'replay', 'envelope', 'host',
        'hostRevalidation', 'boundaryPolicy', 'boundaryInput', 'terminal'
    ].map((kind) => [kind, verify(kind)]));
    ownerVerifiers.scenarioDeclaration = (producer) => digestCanonical(declarations.get(producer.producerId)) === digestCanonical(producer)
        ? producer.producerId : null;
    ownerVerifiers.boundaryDeclaration = (producer, selection) =>
        digestCanonical(declarations.get(producer.producerId)) === digestCanonical(producer)
        && digestCanonical(selection[producer.producerId]) === digestCanonical(producer.selection)
            ? producer.producerId : null;
    ownerVerifiers.boundaryPolicyProjection = (ref) => structuredClone(records.get(ref.path).document.selection);
    ownerVerifiers.hostFailureLedger = (failures, ref) =>
        digestCanonical(failures) === digestCanonical(records.get(ref.path).document.failures)
            ? ref.contentDigest : null;
    ownerVerifiers.terminalProjection = (item) =>
    {
        const expected = records.get(item.reference.path).document.terminal;
        const actual = { ...item };
        delete actual.reference;
        return digestCanonical(actual) === digestCanonical(expected) ? item.reference.contentDigest : null;
    };
    const catalog = readCatalog();
    const bindings = catalog.scenarios.filter((scenario) => scenario.phase === 'security' && scenario.executor === 'resident')
        .map((scenario) => ({
            scenarioId: scenario.id,
            ...Object.fromEntries(['stateAccess', 'isolation', 'replay', 'envelope']
                .map((kind) => [kind, reference(kind, `${scenario.id}-${kind}`)]))
        }));
    const references = Object.fromEntries(['runtime', 'fixture', 'reset', 'host', 'attackReset'].map((kind) =>
        [kind, reference(kind === 'attackReset' ? 'reset' : kind, kind)]));
    function terminal(producerId, terminalState, primaryFailureRefs = [])
    {
        const body = { producerId, terminalState, reasonCode: `controlled-${terminalState}`, primaryFailureRefs };
        return { ...body, reference: reference('terminal', producerId, { terminal: body }) };
    }
    function register(projection)
    {
        for (const producer of projection.producers)
        {
            declarations.set(producer.producerId, producer);
        }
        return projection;
    }
    return { context, records, calls, reference, ownerVerifiers, catalog, bindings, references, terminal, register };
}
