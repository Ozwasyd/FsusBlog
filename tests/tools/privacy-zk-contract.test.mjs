import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const lane = fs.readFileSync(path.join(root, 'tools/test/lanes/privacy-zk-comment-matrix.sh'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'src/frontend/package.json'), 'utf8'));

test('privacy contract package scripts keep current circuit checks before the generated prover check', () =>
{
    const scripts = packageJson.scripts;
    const contract = scripts['check:privacy-zk-contract'];
    const prebuild = scripts['check:privacy-zk-contract:prebuild'];
    const postbuild = scripts['check:privacy-zk-contract:postbuild'];

    assert.equal(contract, 'npm run check:privacy-zk-contract:prebuild && npm run check:privacy-zk-contract:postbuild');
    assert.match(prebuild, /comment-privacy-build-contract\.mjs/u);
    assert.match(prebuild, /check-zk-comment-v5-unlinkability\.mjs/u);
    assert.doesNotMatch(prebuild, /check:security:matrices|check:openapi-sync|check:contract:frame-schema|run-test-matrix|check-workflow-matrix-sync/u);
    assert.match(postbuild, /check-zk-comment-v5-manifests\.mjs/u);
    assert.doesNotMatch(postbuild, /MCL pairing fixture/u);
});

test('privacy functional command excludes performance tests', () =>
{
    const scripts = packageJson.scripts;
    const originalBackend = scripts['check:privacy-zk-backend'];
    const functionalBackend = scripts['check:privacy-zk-backend-functional'];

    assert.ok(originalBackend);
    assert.ok(functionalBackend);
    assert.match(functionalBackend, /^dotnet test /u);
    assert.match(functionalBackend, / -c Release /u);
    assert.match(functionalBackend, /AnonymousPrivacyConcurrencyTests/u);
    assert.match(functionalBackend, /Category!=Performance/u);
    for (const selection of originalBackend.match(/FullyQualifiedName~[A-Za-z0-9]+/gu) ?? [])
    {
        if (/ZkAnonymousProofVerifierContractTests|AnonymousCommentGovernanceContractTests/u.test(selection))
        {
            continue;
        }
        assert.match(functionalBackend, new RegExp(selection, 'u'));
    }
    assert.doesNotMatch(functionalBackend, /FSUSBLOG_RUN_PERFORMANCE_TESTS/u);
});

test('privacy evidence requires all successful stage receipts', () =>
{
    const finalize = lane.slice(lane.indexOf('FinalizePrivacyMatrix()'), lane.indexOf('case "${1:-all}"'));
    assert.match(finalize, /RequireStageReceipt contract/u);
    assert.match(finalize, /RequireStageReceipt functional/u);
    assert.doesNotMatch(finalize, /RequireStageReceipt benchmark/u);
    assert.match(lane, /receipt\.runId !== expectedRunId/u);
});

test('privacy prebuild consumes canonical receipts without a Debug build or inert MCL switch', () =>
{
    assert.doesNotMatch(lane, /EnsureBackendFilteredBuild[\s\S]{0,120}RunPrivacyPrebuildContract/u);
    assert.doesNotMatch(lane, /FSUSBLOG_ZK_MCL_NO_BUILD/u);
    assert.match(lane, /run-privacy-zk-prebuild-projection\.mjs/u);
    assert.match(lane, /privacy-zk-prebuild-ownership\.json/u);
});

test('privacy frontend report has a dedicated lane and contains no retired test paths', () =>
{
    const frontend = packageJson.scripts['check:privacy-zk-frontend'];
    assert.match(frontend, /FSUSBLOG_VITEST_LANE=privacy-zk/u);
    assert.doesNotMatch(frontend, /commentAnonymousAuthorWorkflow|anonymousModerationGovernanceWorkflow/u);
});
