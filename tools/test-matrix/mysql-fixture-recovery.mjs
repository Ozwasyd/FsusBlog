/**
 * Reconcile only supervisor-retained MySQL allocations before their scheduler
 * grants can be released. This does not admit another execution or qualify it.
 * The scheduler supplies its live recovery-capability guard; the lifecycle
 * owner remains responsible for exact container and credential observations.
 */
export async function reconcileRetainedMySqlFixtureServices({ allocations, binding, assertRecovery, lifecycle })
{
    if (typeof assertRecovery !== 'function')
    {
        throw new Error('MySQL scheduler recovery requires its acquired recovery guard');
    }
    assertRecovery();
    if (allocations === undefined)
    {
        return Object.freeze([]);
    }
    if (!allocations || Array.isArray(allocations) || typeof allocations !== 'object')
    {
        throw new Error('MySQL scheduler recovery requires a retained allocation map');
    }
    const entries = Object.entries(structuredClone(allocations));
    const prepared = [];
    const stateFiles = new Set();
    const fingerprint = value => String(value ?? '').replace(/^sha256:/u, '');
    for (const [tierId, record] of entries)
    {
        assertRecovery();
        const context = record?.context;
        const bundleId = context?.bundleId === 'matrix:backend-unit' ? 'backend-unit' : context?.bundleId;
        if (!record || Array.isArray(record) || typeof record !== 'object'
            || Object.keys(record).some(key => !['context', 'stateFile', 'bindingDigest', 'status', 'admissionFile', 'cleanup'].includes(key))
            || !['creating', 'prepared', 'cleaned'].includes(record.status)
            || !/^sha256:[a-f0-9]{64}$/u.test(record.bindingDigest ?? '')
            || !context || context.root !== binding.root || context.runId !== binding.runId
            || context.namespace !== binding.namespace || context.stepId !== 'migration-services'
            || !['backend-tests', 'matrix:backend-unit'].includes(context.bundleId)
            || !binding.resourceBundleIds.includes(bundleId)
            || context.sourceState?.commit !== binding.sourceState.commit
            || fingerprint(context.sourceState?.worktreeFingerprint) !== fingerprint(binding.sourceState.worktreeFingerprint))
        {
            throw new Error('MySQL scheduler recovery allocation crosses its original run/source/resource binding');
        }
        const retained = lifecycle.readRetainedMySqlFixtureLifecycle(context, record.bindingDigest);
        const controller = retained.state.controllerIdentity;
        const owner = binding.schedulerOwner;
        if (record.stateFile !== retained.paths.stateFile || stateFiles.has(record.stateFile)
            || !owner || ['pid', 'processStartIdentity', 'executableDigest', 'commandDigest']
            .some(key => owner[key] === undefined || controller?.[key] !== owner[key]))
        {
            throw new Error('MySQL scheduler recovery allocation has a foreign path, controller or duplicate identity');
        }
        stateFiles.add(record.stateFile);
        prepared.push({ tierId, record });
    }
    const results = [];
    // Validate the entire retained roster before the first destructive action.
    for (const { tierId, record } of prepared)
    {
        assertRecovery();
        await lifecycle.recoverMySqlFixtureService(record.context, { expectedBindingDigest: record.bindingDigest });
        assertRecovery();
        const observed = lifecycle.verifyMySqlFixtureServiceCleanup(record.context, { expectedBindingDigest: record.bindingDigest });
        if (observed.qualificationEligible !== false || observed.stateFile !== record.stateFile
            || observed.bindingDigest !== record.bindingDigest || !/^sha256:[a-f0-9]{64}$/u.test(observed.stateDigest ?? '')
            || observed.cleanup?.containerAbsent !== true || observed.cleanup?.credentialsRemoved !== true)
        {
            throw new Error('MySQL scheduler recovery did not prove exact container and credential cleanup');
        }
        results.push(Object.freeze({ tierId, stateFile: observed.stateFile, bindingDigest: observed.bindingDigest,
            stateDigest: observed.stateDigest, qualificationEligible: false, cleanup: Object.freeze({ ...observed.cleanup }) }));
    }
    assertRecovery();
    return Object.freeze(results);
}

/**
 * Require one exact cleanup proof per retained allocation. The commit caller
 * supplies the canonical lifecycle owner to reobserve absence immediately
 * before releasing grants; a durable replay validates the same sealed roster.
 */
export function assertRetainedMySqlFixtureRecoveryComplete({ allocations, records, lifecycle, requireCleaned = false })
{
    if (allocations !== undefined && (!allocations || Array.isArray(allocations) || typeof allocations !== 'object'))
    {
        throw new Error('MySQL scheduler recovery completion requires a retained allocation map');
    }
    const entries = Object.entries(allocations ?? {});
    if (!Array.isArray(records) || records.length !== entries.length)
    {
        throw new Error('MySQL scheduler recovery completion differs from its exact allocation roster');
    }
    const byTier = new Map();
    const stateFiles = new Set();
    const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
    for (const record of records)
    {
        if (!exactKeys(record, ['tierId', 'stateFile', 'bindingDigest', 'stateDigest', 'qualificationEligible', 'cleanup'])
            || typeof record.tierId !== 'string' || record.tierId.length === 0 || byTier.has(record.tierId)
            || typeof record.stateFile !== 'string' || record.stateFile.length === 0 || stateFiles.has(record.stateFile)
            || !/^sha256:[a-f0-9]{64}$/u.test(record.bindingDigest ?? '')
            || !/^sha256:[a-f0-9]{64}$/u.test(record.stateDigest ?? '')
            || record.qualificationEligible !== false
            || !exactKeys(record.cleanup, ['containerAbsent', 'credentialsRemoved'])
            || record.cleanup.containerAbsent !== true || record.cleanup.credentialsRemoved !== true)
        {
            throw new Error('MySQL scheduler recovery completion contains an invalid cleanup proof');
        }
        byTier.set(record.tierId, record);
        stateFiles.add(record.stateFile);
    }
    for (const [tierId, allocation] of entries)
    {
        const record = byTier.get(tierId);
        if (!record || record.stateFile !== allocation?.stateFile || record.bindingDigest !== allocation?.bindingDigest
            || (requireCleaned && (allocation.status !== 'cleaned'
                || !exactKeys(allocation.cleanup, ['containerAbsent', 'credentialsRemoved'])
                || allocation.cleanup.containerAbsent !== true || allocation.cleanup.credentialsRemoved !== true)))
        {
            throw new Error('MySQL scheduler recovery completion crosses its retained allocation');
        }
    }
    // Preflight the complete proof roster before any live observation.
    if (lifecycle)
    {
        for (const [tierId, allocation] of entries)
        {
            const record = byTier.get(tierId);
            const observed = lifecycle.verifyMySqlFixtureServiceCleanup(allocation.context,
                { expectedBindingDigest: allocation.bindingDigest });
            if (observed.qualificationEligible !== false || observed.stateFile !== record.stateFile
                || observed.bindingDigest !== record.bindingDigest || observed.stateDigest !== record.stateDigest
                || observed.cleanup?.containerAbsent !== true || observed.cleanup?.credentialsRemoved !== true)
            {
                throw new Error('MySQL scheduler recovery cleanup changed before grant release');
            }
        }
    }
}
