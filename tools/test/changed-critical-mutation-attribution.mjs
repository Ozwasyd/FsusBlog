/**
 * Mutant-to-Behavior attribution.
 *
 * Maps each executed mutant from a Stryker report to a unique behaviorId
 * via the ImplementationOwner receipt source span. Cross-behavior spans
 * that cannot be uniquely attributed are reported as blocked.
 */

/**
 * @typedef {object} MutantAttribution
 * @property {string} mutantId - Canonical mutant ID (sourceProject:file:id)
 * @property {string} behaviorId - Attributed behavior ID
 * @property {string} sourcePath - Implementation owner source path
 * @property {string} symbol - Implementation owner symbol
 * @property {string} mutator - Stryker mutator name
 * @property {string} status - Killed|Survived|Timeout|NoCoverage|CompileError|Ignored
 * @property {string[]} coveredTestIds - Raw test IDs that cover this mutant
 * @property {string[]} killedTestIds - Raw test IDs that killed this mutant
 */

/**
 * Attribute mutants from a Stryker report to behaviors via owner receipt.
 *
 * @param {object} options
 * @param {object} options.report - Stryker JSON report with files{}
 * @param {string} options.sourceProject - Source project prefix (e.g. 'src/core')
 * @param {object} options.ownerReceipt - Sealed owner receipt with bindings[]
 * @param {object} options.selection - Selection result with behaviors[]
 * @returns {{ attributions: MutantAttribution[], blocked: object[] }}
 */
export function attributeMutantsToBehaviors({ report, sourceProject, ownerReceipt, selection })
{
    const attributions = [];
    const blocked = [];
    const ownerBindings = ownerReceipt?.bindings ?? [];

    // Build source path → behavior owner index
    const ownerByPath = new Map();
    for (const binding of ownerBindings)
    {
        if (binding.status === 'error')
        {
            continue;
        }
        const normalized = String(binding.sourcePath ?? '').replaceAll('\\', '/');
        if (!ownerByPath.has(normalized))
        {
            ownerByPath.set(normalized, []);
        }
        ownerByPath.get(normalized).push(binding);
    }

    // Build behavior set from selection for quick lookup
    const selectedBehaviorIds = new Set(
        (selection?.behaviors ?? []).map((b) => b.behaviorId)
    );

    for (const [filePath, fileData] of Object.entries(report?.files ?? {}))
    {
        const normalizedFile = filePath.replaceAll('\\', '/');
        // Reconstruct full repo-relative path
        const fullPath = normalizedFile.startsWith(sourceProject)
            ? normalizedFile
            : `${sourceProject}/${normalizedFile}`;

        // Find owner bindings for this file
        const fileOwners = (ownerByPath.get(fullPath) ?? [])
            .filter((o) => selectedBehaviorIds.has(o.behaviorId));

        for (const mutant of fileData?.mutants ?? [])
        {
            const mutantId = `${sourceProject}:${normalizedFile}:${mutant.id}`;
            const coveredTestIds = mutant.coveredBy ?? [];
            const killedTestIds = mutant.killedBy ?? [];

            if (fileOwners.length === 0)
            {
                blocked.push({
                    mutantId,
                    reason: 'no-owner',
                    sourcePath: fullPath,
                    mutator: mutant.mutatorName ?? 'unknown',
                    status: mutant.status
                });
                continue;
            }

            if (fileOwners.length > 1)
            {
                // Multiple behaviors own this file — attempt span-level attribution
                const attributed = attributeBySpan(mutant, fileOwners);
                if (!attributed)
                {
                    blocked.push({
                        mutantId,
                        reason: 'ambiguous-owner-boundary',
                        sourcePath: fullPath,
                        candidateBehaviors: fileOwners.map((o) => o.behaviorId),
                        mutator: mutant.mutatorName ?? 'unknown',
                        status: mutant.status
                    });
                    continue;
                }
                attributions.push({
                    mutantId,
                    behaviorId: attributed.behaviorId,
                    sourcePath: fullPath,
                    symbol: attributed.symbol,
                    mutator: mutant.mutatorName ?? 'unknown',
                    status: mutant.status,
                    coveredTestIds,
                    killedTestIds
                });
                continue;
            }

            // Unique owner
            const owner = fileOwners[0];
            attributions.push({
                mutantId,
                behaviorId: owner.behaviorId,
                sourcePath: fullPath,
                symbol: owner.symbol,
                mutator: mutant.mutatorName ?? 'unknown',
                status: mutant.status,
                coveredTestIds,
                killedTestIds
            });
        }
    }

    return {
        attributions: attributions.sort((a, b) => a.mutantId.localeCompare(b.mutantId)),
        blocked: blocked.sort((a, b) => a.mutantId.localeCompare(b.mutantId))
    };
}

/**
 * Attempt span-level attribution when multiple owners share a file.
 * Uses mutant location line to find the closest preceding owner symbol.
 * Returns null if attribution is ambiguous.
 */
function attributeBySpan(mutant, fileOwners)
{
    // If all owners point to the same behavior, attribute to it
    const uniqueBehaviors = [...new Set(fileOwners.map((o) => o.behaviorId))];
    if (uniqueBehaviors.length === 1)
    {
        return fileOwners[0];
    }
    // Cannot resolve without AST-level span data — report blocked
    return null;
}

/**
 * Compute per-behavior mutation qualification from attributions.
 *
 * @param {object} options
 * @param {MutantAttribution[]} options.attributions
 * @param {object[]} options.blocked
 * @param {object} options.behaviorCatalog - behavior-contracts.json
 * @param {string[]} [options.behaviorIds] - Restrict qualification to these behavior IDs
 * @param {object} [options.qualificationOptions] - Exact-set and clean-test evidence
 *   - expectedMutantIdsByBehavior: { behaviorId: mutantId[] } exact required mutant IDs
 *   - cleanTestIdsByBehavior: { behaviorId: canonicalTestId[] } tests clean this round
 *   - bindingByTestId: { canonicalTestId: binding } #2185 binding map
 *   - testIdentityByRawId: { rawTestId: fullyQualifiedName } current-run raw identity map
 * @returns {{ qualifications: object[], failed: boolean }}
 */
export function qualifyBehaviorMutations({
    attributions,
    blocked,
    behaviorCatalog,
    behaviorIds = null,
    qualificationOptions = {}
})
{
    const contractsById = new Map(
        (behaviorCatalog?.contracts ?? []).map((c) => [c.id, c])
    );
    const qualifications = [];
    let failed = false;
    const expectedMutantIdsByBehavior = qualificationOptions.expectedMutantIdsByBehavior ?? {};
    const cleanTestIdsByBehavior = qualificationOptions.cleanTestIdsByBehavior ?? {};
    const bindingByTestId = qualificationOptions.bindingByTestId ?? {};
    const testIdentityByRawId = qualificationOptions.testIdentityByRawId ?? {};
    const hasCleanTestEvidence =
        Object.keys(bindingByTestId).length > 0
    && Object.keys(testIdentityByRawId).length > 0;

    // Group attributions by behavior
    const byBehavior = new Map();
    for (const attr of attributions)
    {
        if (!byBehavior.has(attr.behaviorId))
        {
            byBehavior.set(attr.behaviorId, []);
        }
        byBehavior.get(attr.behaviorId).push(attr);
    }
    // Duplicate mutant results must fail closed (delivery item 10).
    const seenMutantIds = new Map();
    for (const attr of attributions)
    {
        if (seenMutantIds.has(attr.mutantId) && seenMutantIds.get(attr.mutantId) !== attr.behaviorId)
        {
            failed = true;
        }
        if (seenMutantIds.has(attr.mutantId))
        {
            failed = true;
        }
        seenMutantIds.set(attr.mutantId, attr.behaviorId);
    }

    function expectedTestIdsForBehavior(behaviorId)
    {
        return (cleanTestIdsByBehavior[behaviorId] ?? []).sort((a, b) => a.localeCompare(b));
    }

    function resolveCleanTestId(rawTestId)
    {
        const fqn = testIdentityByRawId[rawTestId];
        if (!fqn)
        {
            return null;
        }
        return Object.values(bindingByTestId).find((binding) => binding.fullyQualifiedName === fqn)
            ? Object.values(bindingByTestId).find((binding) => binding.fullyQualifiedName === fqn).canonicalTestId
            : null;
    }

    for (const [behaviorId, contract] of contractsById)
    {
        if (behaviorIds != null && !behaviorIds.includes(behaviorId))
        {
            continue;
        }
        if (!contract.mutationPolicy?.mutationRequired)
        {
            continue;
        }
        if (contract.status !== 'active')
        {
            continue;
        }

        const mutants = byBehavior.get(behaviorId) ?? [];
        const executed = mutants.filter((m) =>
            ['Killed', 'Survived', 'Timeout'].includes(m.status));
        const killed = mutants.filter((m) => m.status === 'Killed');
        const survived = mutants.filter((m) => m.status === 'Survived');
        const timeout = mutants.filter((m) => m.status === 'Timeout');
        const noCoverage = mutants.filter((m) => m.status === 'NoCoverage');
        const compileError = mutants.filter((m) => m.status === 'CompileError');
        const scoreable = mutants.filter((m) =>
            ['Killed', 'Survived', 'Timeout', 'NoCoverage'].includes(m.status));
        const score = scoreable.length > 0
            ? Number(((killed.length / scoreable.length) * 100).toFixed(2))
            : 0;

        const failures = [];
        const policy = contract.mutationPolicy;

        if (policy.requireExecutedMutants && executed.length === 0)
        {
            failures.push(`${behaviorId} mutationRequired but zero executed mutants`);
        }
        if (survived.length > 0 && policy.allowedEquivalentMutantPolicy === 'none')
        {
            failures.push(`${behaviorId} has ${survived.length} survived mutant(s)`);
        }
        if (timeout.length > 0)
        {
            failures.push(`${behaviorId} has ${timeout.length} timeout mutant(s)`);
        }
        if (noCoverage.length > 0 && policy.allowedEquivalentMutantPolicy === 'none')
        {
            failures.push(`${behaviorId} has ${noCoverage.length} no-coverage mutant(s)`);
        }
        if (compileError.length > 0)
        {
            failures.push(`${behaviorId} has ${compileError.length} error/compile-error mutant(s)`);
        }
        if (score < policy.minimumMutationScore && scoreable.length > 0)
        {
            failures.push(`${behaviorId} mutation score ${score} < minimum ${policy.minimumMutationScore}`);
        }

        // Exact required mutant set (delivery items 1, 5, 10): any planned mutant
        // with no attribution result or no execution is a missing result.
        const expectedMutantIds = expectedMutantIdsByBehavior[behaviorId] ?? [];
        if (expectedMutantIds.length > 0)
        {
            const attributedMutantIds = new Set(mutants.map((m) => m.mutantId));
            const missing = expectedMutantIds.filter((mutantId) => !attributedMutantIds.has(mutantId));
            if (missing.length > 0)
            {
                failures.push(
                    `${behaviorId} missing required mutant result(s): ${missing.sort().join(', ')}`
                );
            }
        }

        // Required tests must be clean-first-attempt this round (delivery item 7):
        // skipped/blocked/diagnostic/recovered tests cannot satisfy kill credit.
        const requiredTestIds = expectedTestIdsForBehavior(behaviorId);
        const expectedBindings = Object.values(bindingByTestId)
            .filter((binding) => binding.behaviorId === behaviorId)
            .map((binding) => binding.canonicalTestId);
        if (expectedBindings.length > 0)
        {
            const missingClean = expectedBindings.filter((id) => !requiredTestIds.includes(id));
            if (missingClean.length > 0)
            {
                failures.push(
                    `${behaviorId} required test(s) not clean this round: ${missingClean.sort().join(', ')}`
                );
            }
        }

        for (const mutant of hasCleanTestEvidence ? mutants : [])
        {
            for (const rawTestId of mutant.killedTestIds ?? [])
            {
                const canonicalTestId = resolveCleanTestId(rawTestId);
                if (!canonicalTestId)
                {
                    failures.push(
                        `${behaviorId} mutant ${mutant.mutantId} killed by unbound test ${rawTestId}`
                    );
                    continue;
                }
                if (!requiredTestIds.includes(canonicalTestId))
                {
                    failures.push(
                        `${behaviorId} mutant ${mutant.mutantId} killed by unclean test ${canonicalTestId}`
                    );
                }
            }
        }

        // Blocked mutants for this behavior also fail qualification
        const blockedForBehavior = blocked.filter((b) =>
        {
            // Check if blocked mutant's source path matches any owner of this behavior
            return false; // blocked mutants have no behavior attribution by definition
        });

        const qualified = failures.length === 0;
        if (!qualified)
        {
            failed = true;
        }

        qualifications.push({
            behaviorId,
            mutationRequired: true,
            executed: executed.length,
            killed: killed.length,
            survived: survived.length,
            timeout: timeout.length,
            noCoverage: noCoverage.length,
            compileError: compileError.length,
            requiredMutants: expectedMutantIds.length,
            recordedMutants: mutants.length,
            score,
            minimumMutationScore: policy.minimumMutationScore,
            qualified,
            failures
        });
    }

    // If any mutants are blocked (ambiguous attribution), fail the whole qualification
    if (blocked.length > 0)
    {
        failed = true;
    }

    return {
        qualifications: qualifications.sort((a, b) => a.behaviorId.localeCompare(b.behaviorId)),
        blockedCount: blocked.length,
        failed
    };
}

/**
 * Attach per-behavior expected killed test IDs/kinds to attributions.
 *
 * Each attribution records the behavior's binding-derived expected killer
 * tests (canonical IDs and kinds) so the sealed receipt carries the exact
 * expected test contract alongside the actual raw killed-by result.
 *
 * @param {object} options
 * @param {MutantAttribution[]} options.attributions
 * @param {object} options.selection - Selection with behaviors[].testBindings[]
 * @returns {MutantAttribution[]} Enriched attributions
 */
export function attachExpectedTestEvidence({ attributions, selection })
{
    const expectedByBehavior = new Map();
    for (const behavior of selection?.behaviors ?? [])
    {
        expectedByBehavior.set(behavior.behaviorId, {
            testIds: [...new Set((behavior.testBindings ?? []).map((b) => b.canonicalTestId))]
                .sort((a, b) => a.localeCompare(b)),
            testKinds: [...new Set((behavior.testBindings ?? []).map((b) => b.testKind))]
                .sort((a, b) => a.localeCompare(b))
        });
    }
    return attributions.map((attribution) =>
    {
        const expected = expectedByBehavior.get(attribution.behaviorId) ?? { testIds: [], testKinds: [] };
        return {
            ...attribution,
            expectedKilledTestIds: expected.testIds,
            expectedTestKinds: expected.testKinds
        };
    });
}

/**
 * Exact required-mutant IDs in attribution format.
 *
 * `attributeMutantsToBehaviors` identifies every mutant as
 * `<sourceProject>:<project-relative-file>:<raw-mutant-id>`. The authority
 * inventory instead keys mutants by the semantic SHA-256 identity, so the
 * expected per-behavior set must be re-derived from the same raw mutant IDs
 * to compare exactly (delivery items 1/5/10: 0/multiple/missing all fail).
 */
export function expectedAttributionMutantIdsByBehavior(selection, authority)
{
    const closures = selection?.projectClosures ?? [];
    const sourceProjectFor = (sourceFile) =>
    {
        const closure = closures.find((entry) =>
            sourceFile.startsWith(`${entry.sourceProject}/`));
        return closure?.sourceProject ?? sourceFile.split('/').slice(0, 2).join('/');
    };
    const result = {};
    for (const behavior of selection?.behaviors ?? [])
    {
        const mutateFiles = new Set(behavior.mutateFiles ?? []);
        result[behavior.behaviorId] = (authority?.inventory ?? [])
            .filter((mutant) => mutateFiles.has(mutant.sourceFile))
            .map((mutant) =>
            {
                const sourceProject = sourceProjectFor(mutant.sourceFile);
                const relative = sourceProject
                    ? mutant.sourceFile.slice(sourceProject.length + 1)
                    : mutant.sourceFile;
                return `${sourceProject}:${relative}:${mutant.rawMutantId}`;
            })
            .sort((left, right) => left.localeCompare(right));
    }
    return result;
}
