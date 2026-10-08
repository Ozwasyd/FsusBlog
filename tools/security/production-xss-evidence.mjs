import path from 'node:path';

const { loadProductionXssCorpus, selectProductionXssCases } = await import(new URL('../../tests/frontend/support/security/productionXssCorpus.mjs', import.meta.url));
const { evaluateSecurityObservation } = await import(new URL('../../tests/frontend/support/security/productionXssObserver.mjs', import.meta.url));
const { verifyProductionBuildReceipt } = await import(new URL('../ci/production-build-artifacts.mjs', import.meta.url));
const { assertBrowserPlanActualMatch } = await import(new URL('../test/playwright-browser-identity.mjs', import.meta.url));

// Read-only verification. The browser runner owns execution, retained raw
// observations and cleanup; a job summary cannot replace those inputs.
export const requiredEvidenceVerifier = Object.freeze({
    version: 1,
    successStatuses: Object.freeze(['success']),
    describe: async (receipt) => (await import(new URL('../release/required-evidence-owner-contract.mjs', import.meta.url))).describeJobEvidence(receipt),
    async verify({ domainInputs, repositoryRoot, context })
    {
        const { verifiedOwnerResult, requireOwnerChecks } = await import(new URL('../release/required-evidence-owner-contract.mjs', import.meta.url));
        const { readOwnerEvidenceReference } = await import(new URL('../release/required-evidence-owner-input.mjs', import.meta.url));
        const report = readOwnerEvidenceReference(domainInputs?.report, { repositoryRoot, context });
        const build = readOwnerEvidenceReference(domainInputs?.build, { repositoryRoot, context });
        if (typeof domainInputs?.fsusUiRoot !== 'string')
        {
            throw new Error('explicit FsusUI corpus root is required');
        }
        const corpus = await loadProductionXssCorpus({ FSUSBLOG_LOCAL_FSUSUI_ROOT: domainInputs.fsusUiRoot });
        const cases = selectProductionXssCases(corpus.corpus, 'release');
        const receipt = report.receipt;
        if (receipt.schema !== 'fsusblog.production-xss-browser-matrix.v1'
            || receipt.status !== 'ok' || receipt.mode !== 'release' || receipt.cleanup?.status !== 'success'
            || receipt.source?.corpusDigest !== `sha256:${corpus.digest}` || receipt.caseCount !== cases.length
            || JSON.stringify(receipt.browsers?.toSorted()) !== JSON.stringify(['chromium', 'firefox', 'webkit'])
            || !Array.isArray(receipt.entries) || receipt.entries.length === 0)
        {
            throw new Error('production XSS corpus/matrix/browser/cleanup contract mismatch');
        }
        const verified = verifyProductionBuildReceipt({
            artifactRoot: path.dirname(build.file), receiptFile: path.basename(build.file),
            expectedSourceState: { commit: context.sourceCommit,
                worktreeFingerprint: context.worktreeFingerprint.replace(/^sha256:/u, '') },
            expectedReceiptDigest: receipt.runtime?.build?.receiptContentDigest,
            repairReadOnlySeal: false
        });
        const domains = new Set(verified.receipt.domains.map((domain) => domain.name));
        if (['backend-runtime', 'frontend-dist', 'generated-contracts', 'wasm'].some((domain) => !domains.has(domain)))
        {
            throw new Error('production XSS immutable build omits required domains');
        }
        if (!Array.isArray(receipt.browserIdentities) || receipt.browserIdentities.length !== 3)
        {
            throw new Error('exact browser identities are required');
        }
        const browserNames = receipt.browserIdentities.map(({ plan, actual }) =>
        {
            assertBrowserPlanActualMatch(plan, actual);
            return actual.browserName;
        }).sort();
        if (JSON.stringify(browserNames) !== JSON.stringify(receipt.browsers.toSorted()))
        {
            throw new Error('browser identity set mismatch');
        }
        if (!Array.isArray(domainInputs.observations)
            || domainInputs.observations.length !== receipt.entries.length)
        {
            throw new Error('every XSS result needs its explicit retained observation');
        }
        const keys = new Set();
        const observationDigests = [];
        for (const [index, result] of receipt.entries.entries())
        {
            const key = JSON.stringify([result.browser, result.caseId, result.phase, result.surface]);
            if (result.status !== 'ok' || keys.has(key) || !receipt.browsers.includes(result.browser)
                || !cases.some((entry) => entry.id === result.caseId))
            {
                throw new Error('unknown/duplicate/failed XSS result');
            }
            keys.add(key);
            const observation = readOwnerEvidenceReference(domainInputs.observations[index], { repositoryRoot, context });
            if (JSON.stringify(observation.receipt.binding) !== key)
            {
                throw new Error('XSS observation result binding mismatch');
            }
            const raw = observation.receipt.observation;
            for (const field of ['dialogs', 'popups', 'downloads', 'externalRequests', 'unexpectedNavigations',
                'cspViolations', 'trustedTypesErrors', 'dangerousDom', 'missingText', 'missingSelectors'])
            {
                if (!Array.isArray(raw?.[field]))
                {
                    throw new Error(`XSS raw observation is missing ${field}`);
                }
            }
            if (!Number.isInteger(raw.executionSentinel))
            {
                throw new Error('XSS raw execution sentinel is required');
            }
            requireOwnerChecks(evaluateSecurityObservation(raw));
            observationDigests.push(observation.digest);
        }
        for (const browser of receipt.browsers)
        {
            for (const entry of cases)
            {
                if (!receipt.entries.some((result) => result.browser === browser && result.caseId === entry.id))
                {
                    throw new Error(`missing production XSS case: ${browser}/${entry.id}`);
                }
            }
        }
        return verifiedOwnerResult({ reportDigest: report.digest, buildDigest: build.digest,
            corpusDigest: `sha256:${corpus.digest}`, observationDigests });
    }
});
