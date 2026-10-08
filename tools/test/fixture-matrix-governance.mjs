const { canonicalJson, digest, requireDigest, seal, verifySeal } = await import(new URL('../test-fixtures/mutation-recovery/canonical.mjs', import.meta.url));

export const fixtureMatrixMutations = Object.freeze([
    'all-runtime-acceptance-all', 'missing-profile-default', 'tier-case-seed', 'environment-override',
    'profile-omitted-from-cache', 'hidden-bootstrap-seed', 'second-producer-dag', 'old-parser',
    'data-scale-local-fallback', 'diagnostic-receipt-reuse'
]);
export const fixtureIdentityDimensions = Object.freeze([
    'profile', 'catalog', 'capability', 'variant', 'producer-plan', 'receipt', 'generation'
]);

const rules = Object.freeze([
    ['environment-override', /(?:process\.env(?:\.[\w]*FIXTURE[\w]*PROFILE[\w]*|\[[^\]\n]*FIXTURE[^\]\n]*PROFILE[^\]\n]*\])|\$\{[\w]*FIXTURE[\w]*PROFILE[\w]*(?::[-=][^}]*)?\})/giu],
    ['environment-override', /GetEnvironmentVariable\s*\([^)]*(?:FIXTURE[^)]*PROFILE|PROFILE[^)]*FIXTURE)[^)]*\)/giu],
    ['missing-profile-default', /(?:fixtureProfile|profileId|fixture_profile)\s*(?:\?\?|\|\||=|:)\s*['"](?:auth-basic|public-minimal|acceptance-all)['"]/gu],
    ['missing-profile-default', /(?:fixtureProfile|profileId|defaultProfile|fallbackProfile)[^;\n]*(?:\?\?|\|\|)\s*['"](?:auth-basic|public-minimal|acceptance-all)['"]/gu],
    ['all-runtime-acceptance-all', /(?:fixtureProfile|profileId)\s*:\s*['"]?acceptance-all\b/gu],
    ['hidden-bootstrap-seed', /(?:seed(?:Auth|Public|Fixture|Acceptance)|prepareFixtures|prepare-fixtures|fixture-cli[^\n]*\bprepare\b)/giu],
    ['second-producer-dag', /(?:const|let|var|readonly)\s+(?:[\w]*[Pp]rofile[\w]*(?:Map|Dag|DAG)|[\w]*[Pp]roducer(?:Map|Dag|DAG))\s*=/gu],
    ['old-parser', /(?:fixtureTier|fixturePreset|parseLegacyFixture|allowLegacyFixture|fixtureCompat)\b/gu],
    ['data-scale-local-fallback', /data-scale[^\n]*(?:\?\?|\|\||fallback|default)[^\n]*(?:local|dev|shared)/giu],
    ['diagnostic-receipt-reuse', /(?:correctness[^\n]*(?:=|:)\s*[^\n]*diagnostic(?:Receipt|Namespace)|diagnostic(?:Receipt|Namespace)[^\n]*(?:correctness|verifiedReceipt))/giu],
    ['consumer-bypass', /(?:skipFixtureVerify|bypassFixtureAdmission|allowUnverifiedFixture)\b/gu],
    ['latest-receipt', /(?:latest|mtime)[^\n]*(?:fixture|mutation|recovery)[^\n]*(?:receipt|evidence)/giu],
    ['sequence-restart', /(?:restartBackend|recreateBackend|resetFixtureDatabase|flushall|flushdb)\s*\(/giu]
]);

/** Conservative source scanner. Findings are never auto-fixed or wildcard-suppressed. */
export function scanFixtureMatrixSources(sources, { authorityErrors = [] } = {})
{
    const violations = [];
    const warnings = [];
    const files = Object.keys(sources).sort();
    for (const error of authorityErrors)
    {
        const separator = error.indexOf(': ');
        if (separator < 0 || !files.includes(error.slice(0, separator)))
        {
            throw new Error('canonical fixture authority error is not bound to scanned source');
        }
        violations.push({ ruleId: 'canonical-fixture-authority', file: error.slice(0, separator),
            line: 1, matchDigest: digest(error) });
    }
    for (const file of files)
    {
        const source = sources[file];
        if (typeof source !== 'string')
        {
            throw new Error(`scanner requires text source ${file}`);
        }
        const findings = new Map();
        const lines = source.split('\n');
        let tierDecision = false;
        for (const [lineIndex, line] of lines.entries())
        {
            tierDecision ||= /(?:case\s+.*tier|(?:switch|if)\s*\(.*tier)/iu.test(line);
            if (tierDecision && /(?:seed\w*|prepareFixture\w*)\s*\(/iu.test(line))
            {
                findings.set(`tier-case-seed:${lineIndex}`, {
                    ruleId: 'tier-case-seed', file, line: lineIndex + 1, matchDigest: digest(line)
                });
            }
            // Bounded overlapping windows keep minified/generated long lines from causing
            // unbounded regexp backtracking. No bytes are omitted from inspection.
            if (line.length > 4096)
            {
                warnings.push({ file, line: lineIndex + 1, reason: 'long-line-cross-window-semantics-requires-review' });
            }
            for (let offset = 0; offset < line.length; offset += 3840)
            {
                const window = line.slice(offset, offset + 4096);
                for (const [ruleId, pattern] of rules)
                {
                    for (const match of window.matchAll(pattern))
                    {
                        const location = offset + match.index;
                        findings.set(`${ruleId}:${lineIndex}:${location}`, {
                            ruleId, file, line: lineIndex + 1, matchDigest: digest(match[0])
                        });
                    }
                }
            }
        }
        for (const finding of findings.values())
        {
            // Documents are inspected, but prose alone cannot prove an active executable path.
            if (file.endsWith('.md'))
            {
                warnings.push({ ...finding, reason: 'documentation-reference-requires-review' });
            }
            else
            {
                violations.push(finding);
            }
        }
    }
    return seal({
        schema: 'fsusblog.fixture-matrix-scanner.v1',
        files,
        sourceDigest: digest(files.map((file) => ({ file, digest: digest(sources[file]) }))),
        violations,
        warnings
    });
}

function same(left, right, label)
{
    if (canonicalJson(left) !== canonicalJson(right))
    {
        throw new Error(`${label} missing, extra, orphan, duplicate or drifted`);
    }
}

function rows(value, label)
{
    if (!Array.isArray(value) || !value.length)
    {
        throw new Error(`${label} requires observed nonempty step roster`);
    }
    const ids = new Set();
    const tests = new Set();
    return value.map((row) =>
    {
        same(Object.keys(row).sort(), ['admissionDigest', 'capabilities', 'nodes', 'producerIds', 'profileId', 'stepId', 'testIds'], `${label} row fields`);
        if (typeof row.stepId !== 'string' || !row.stepId || ids.has(row.stepId)
            || typeof row.profileId !== 'string' || !row.profileId)
        {
            throw new Error(`${label} duplicate/missing step or profile`);
        }
        ids.add(row.stepId);
        const normalized = { stepId: row.stepId, profileId: row.profileId };
        for (const field of ['testIds', 'capabilities', 'producerIds', 'nodes'])
        {
            const entries = row[field];
            if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== 'string' || !entry)
                || new Set(entries).size !== entries.length)
            {
                throw new Error(`${label} missing/duplicate ${field}`);
            }
            if (field === 'testIds')
            {
                for (const id of entries)
                {
                    if (tests.has(id))
                    {
                        throw new Error(`${label} duplicate test ownership`);
                    }
                    tests.add(id);
                }
            }
            normalized[field] = [...entries].sort();
        }
        requireDigest(row.admissionDigest, `${label} admissionDigest`);
        normalized.admissionDigest = row.admissionDigest;
        return normalized;
    }).sort((left, right) => left.stepId.localeCompare(right.stepId));
}

/** Exact bidirectional comparison of independently supplied compiled and observed rosters. */
export function verifyFixtureMatrixExactness({ matrix, bindings, consumers, local, ci })
{
    const expected = rows(matrix, 'matrix');
    for (const [label, actual] of Object.entries({ bindings, consumers, local, ci }))
    {
        same(rows(actual, label), expected, label);
    }
    return seal({ schema: 'fsusblog.fixture-matrix-exactness.v1', status: 'verified', rosterDigest: digest(expected) });
}

function verifyMutationResults(results, source)
{
    same(results.map((result) => result.id).sort(), [...fixtureMatrixMutations].sort(), 'required mutation roster');
    for (const result of results)
    {
        same(result.source, source, 'mutation source');
        requireDigest(result.inputDigest, 'mutation input');
        requireDigest(result.outputDigest, 'mutation output');
        if (result.status !== 'killed' || !Number.isInteger(result.exitCode) || result.exitCode === 0
            || !Array.isArray(result.diagnostics) || !result.diagnostics.length)
        {
            throw new Error(`mutation ${result.id} survived or was not observed`);
        }
    }
}

function verifyInvalidation(results, source)
{
    same(results.map((result) => result.dimension).sort(), [...fixtureIdentityDimensions].sort(), 'identity invalidation roster');
    for (const result of results)
    {
        same(result.source, source, 'invalidation source');
        requireDigest(result.beforeDigest, 'invalidation before');
        requireDigest(result.afterDigest, 'invalidation after');
        requireDigest(result.observationDigest, 'invalidation observation');
        if (result.beforeDigest === result.afterDigest || result.status !== 'observed'
            || ['oldPlanAdmitted', 'oldCacheHit', 'oldEvidenceAdmitted', 'oldReleaseCandidateAdmitted']
                .some((field) => result[field] !== false))
        {
            throw new Error(`identity ${result.dimension} did not invalidate old results`);
        }
    }
}

/**
 * Produces a recomputable blocked terminal report. Upstream #2663/#2664 verifier APIs
 * are unavailable; source materials and self-sealed input receipts cannot authorize acceptance.
 */
export function buildFixtureMatrixAcceptance({ source, scanner, inputReceipts = {}, exactness, mutations, invalidation })
{
    if (!/^[a-f0-9]{40}$/u.test(source?.commit ?? ''))
    {
        throw new Error('acceptance source requires exact commit');
    }
    requireDigest(source.worktreeFingerprint, 'acceptance worktree fingerprint');
    verifySeal(scanner, 'contentDigest', 'scanner result');
    const results = [];
    const inputRefs = [];
    for (const owner of ['2663', '2664'])
    {
        const receipt = inputReceipts[owner];
        if (!receipt)
        {
            results.push({ check: `input-${owner}`, status: 'unrun', reason: 'owner receipt unavailable' });
            continue;
        }
        // Preserve supplied bytes as references; no invented schema or local seal admits them.
        inputRefs.push({ owner, digest: digest(receipt) });
        results.push({ check: `input-${owner}`, status: 'unrun', reason: 'exact owner verifier API unavailable' });
    }
    results.push({ check: 'scanner', status: scanner.violations.length ? 'failed' : 'passed', violations: scanner.violations.length });
    for (const [check, material, verify] of [
        ['exactness-and-parity', exactness, () => verifyFixtureMatrixExactness(exactness)],
        ['mutations', mutations, () => verifyMutationResults(mutations, source)],
        ['identity-invalidation', invalidation, () => verifyInvalidation(invalidation, source)]
    ])
    {
        if (!material)
        {
            results.push({ check, status: 'unrun', reason: 'observed material unavailable' });
            continue;
        }
        try
        {
            verify();
            results.push({ check, status: 'passed', materialDigest: digest(material) });
        }
        catch (error)
        {
            results.push({ check, status: 'failed', reason: error.message, materialDigest: digest(material) });
        }
    }
    return seal({
        schema: 'fsusblog.fixture-matrix-acceptance.v1',
        source,
        inputRefs,
        scannerDigest: scanner.contentDigest,
        results,
        warnings: [...scanner.warnings, { reason: 'upstream-input-authority-unavailable' }],
        status: 'blocked',
        qualificationEligible: false
    });
}

export function verifyFixtureMatrixAcceptance(receipt, inputs)
{
    verifySeal(receipt, 'contentDigest', 'fixture matrix acceptance');
    same(receipt, buildFixtureMatrixAcceptance(inputs), 'recomputed terminal receipt');
    return receipt;
}
