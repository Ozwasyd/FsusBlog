/* eslint-disable import-x/no-relative-parent-imports -- This contract test imports the repository tools under test. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createValidBlogUiBundle, runBlogUiSelfCheck, validateBlogUiBundle } from '../../.agents/skills/fsusblog-design-conformance/scripts/ui-orchestration.mjs';
import { blogUiDomainPolicyDigest, blogUiStagePolicy as policy, blogUiStagePolicyDigest, validateBlogUiStagePolicy } from '../../.agents/skills/fsusblog-design-conformance/scripts/ui-stage-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const skillRoot = path.join(root, '.agents/skills/fsusblog-design-conformance');
const receiptNames = ['classification', 'adjudication', 'uxAcceptance'];

function canonical(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonical);
    }
    if (!value || typeof value !== 'object')
    {
        return value;
    }
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function seal(receipt, field = 'receiptDigest')
{
    const unsigned = { ...receipt };
    delete unsigned[field];
    receipt[field] = createHash('sha256').update(JSON.stringify(canonical(unsigned))).digest('hex');
    return receipt;
}

function reseal(bundle)
{
    seal(bundle.classification);
    seal(bundle.adjudicationClassification);
    bundle.adjudication.classificationReceiptDigest = bundle.adjudicationClassification.receiptDigest;
    seal(bundle.adjudication, 'adjudicationDigest');
    if (bundle.uxAcceptance)
    {
        bundle.uxAcceptance.classificationReceiptDigest = bundle.classification.receiptDigest;
        seal(bundle.uxAcceptance);
    }
    return bundle;
}

function rejects(mutate, code)
{
    const bundle = createValidBlogUiBundle();
    mutate(bundle);
    assert.throws(() => validateBlogUiBundle(reseal(bundle)), { code });
}

function run(...args)
{
    return spawnSync(process.execPath, [path.join(skillRoot, 'scripts/ui-orchestration.mjs'), ...args], {
        cwd: skillRoot,
        encoding: 'utf8',
        timeout: 15000
    });
}

function output(result)
{
    return `${result.stdout}\n${result.stderr}`;
}

test('UI domain self-check preserves every negative control', () =>
{
    const controls = JSON.parse(readFileSync(path.join(skillRoot, 'contracts/blog-ui-orchestration-negative-controls.json'), 'utf8'));
    const result = runBlogUiSelfCheck();
    assert.equal(result.schemas, 4);
    assert.equal(result.negativeControls, controls.length);
    assert.ok(controls.length >= 18);
    assert.equal(result.policyDigest, blogUiStagePolicyDigest);
    assert.equal(blogUiStagePolicyDigest, blogUiDomainPolicyDigest);
});

test('domain policy mirrors FsusUI external-orchestration boundary', () =>
{
    assert.equal(policy.authorityScope, 'repository-domain-and-acceptance-only');
    assert.equal(policy.sharedOrchestrationAuthority, 'external');
    assert.ok(policy.forbiddenSharedOrchestrationClaims.includes('model-profile-effort'));
    assert.ok(policy.forbiddenSharedOrchestrationClaims.includes('route-selection'));
    assert.deepEqual(policy.requiredSkillIds, [
        'fsusblog-design-conformance',
        'fsusui-design-conformance'
    ]);
    assert.equal(Object.hasOwn(policy, 'executionProfiles'), false);
    assert.equal(Object.hasOwn(policy, 'implementation'), false);
    assert.equal(Object.hasOwn(policy, 'writerLeaseOrder'), false);
});

test('all decision and verification classes remain domain facts without route bindings', () =>
{
    for (const uiDecisionClass of policy.uiDecisionClasses.filter((value) => value !== policy.systemDesignDisputeClass))
    {
        for (const verificationClass of policy.verificationClasses)
        {
            const result = validateBlogUiBundle(createValidBlogUiBundle({ uiDecisionClass, verificationClass }));
            assert.equal(result.classification.uiDecisionClass, uiDecisionClass);
            assert.equal(result.classification.verificationClass, verificationClass);
            assert.equal(result.uxAcceptance.verificationClass, verificationClass);
            assert.equal(result.classification.domainPolicyDigest, blogUiDomainPolicyDigest);
            assert.equal(Object.hasOwn(result.classification, 'actualModel'), false);
            assert.equal(Object.hasOwn(result.uxAcceptance, 'actualProfile'), false);
            assert.ok(Object.isFrozen(result.classification));
        }
    }
});

test('system-design disputes require matching adjudication without model or route fields', () =>
{
    const result = validateBlogUiBundle(createValidBlogUiBundle({
        uiDecisionClass: policy.systemDesignDisputeClass,
        verificationClass: 'ux-system'
    }));
    assert.equal(result.adjudicationClassification.uiDecisionClass, policy.systemDesignDisputeClass);
    assert.equal(result.adjudication.status, 'adjudicated');
    assert.equal(result.adjudication.modifiedPaths.length, 0);
    assert.equal(Object.hasOwn(result.adjudication, 'actualModel'), false);
    assert.equal(Object.hasOwn(result.adjudication, 'humanGateReason'), false);
});

test('each receipt rejects a correctly re-signed stale domain policy identity', () =>
{
    rejects((bundle) =>
    {
        bundle.classification.domainPolicyDigest = 'f'.repeat(64);
    }, 'blog-ui-domain-policy-binding');
    rejects((bundle) =>
    {
        bundle.adjudication.domainPolicyDigest = 'f'.repeat(64);
    }, 'blog-ui-domain-policy-binding');
    rejects((bundle) =>
    {
        bundle.uxAcceptance.domainPolicyDigest = 'f'.repeat(64);
    }, 'blog-ui-domain-policy-binding');
});

test('v1 Blog receipts cannot be relabeled as valid v2 evidence', () =>
{
    for (const name of receiptNames)
    {
        const bundle = createValidBlogUiBundle();
        const target = name === 'adjudication' ? bundle.adjudication : bundle[name];
        target.schema = target.schema.replace('.v2', '.v1');
        assert.throws(() => validateBlogUiBundle(reseal(bundle)));
    }
});

test('implementation ownership and independent acceptance remain fail-closed', () =>
{
    rejects((bundle) =>
    {
        bundle.overlappingImplementationOwner = true;
    }, 'blog-ui-owner-overlap');
    rejects((bundle) =>
    {
        bundle.adjudication.modifiedPaths = ['src/frontend/src/App.vue'];
    }, 'blog-ui-adjudicator-read-only');
    rejects((bundle) =>
    {
        bundle.uxAcceptance.modifiedPaths = ['src/frontend/src/App.vue'];
    }, 'blog-ui-ux-acceptance-binding');
    rejects((bundle) =>
    {
        bundle.behaviorGreen = false;
    }, 'blog-ui-behavior-green-required');
    rejects((bundle) =>
    {
        bundle.uxAcceptance.inspectedRenderedArtifacts = [];
    }, 'blog-ui-ux-acceptance-binding');
    rejects((bundle) =>
    {
        bundle.uxAcceptance.blockers = ['unresolved focus state'];
    }, 'blog-ui-ux-acceptance-binding');
});

test('baseline and both Skill bindings remain mandatory', () =>
{
    rejects((bundle) =>
    {
        bundle.classification.requiredDesignAuthorities.pop();
    }, 'blog-ui-authority-binding');
    rejects((bundle) =>
    {
        bundle.classification.fsusUIBaseline.dirty = true;
    }, 'blog-ui-baseline-identity');
    rejects((bundle) =>
    {
        bundle.uxAcceptance.fsusUIBaselineDigest = 'e'.repeat(64);
    }, 'blog-ui-ux-acceptance-binding');
});

test('freshly signed adjudication for a different classification is rejected', () =>
{
    const bundle = createValidBlogUiBundle();
    bundle.adjudication.classificationReceiptDigest = 'e'.repeat(64);
    seal(bundle.adjudication, 'adjudicationDigest');
    assert.throws(() => validateBlogUiBundle(bundle), { code: 'blog-ui-adjudication-binding' });
});

test('policy rejects unknown fields and restored orchestration ownership claims', () =>
{
    const mutations = [
        (value) =>
        {
            value.waiver = true;
        },
        (value) =>
        {
            value.executionProfiles = { 'sol-low': { model: 'gpt-5.6-sol', effort: 'low' } };
        },
        (value) =>
        {
            value.sharedOrchestrationAuthority = 'repository';
        },
        (value) =>
        {
            value.forbiddenSharedOrchestrationClaims =
                value.forbiddenSharedOrchestrationClaims.filter((entry) => entry !== 'model-profile-effort');
        },
        (value) =>
        {
            value.implementationOwnership.acceptanceMayModifyImplementation = true;
        },
        (value) =>
        {
            value.acceptanceRequirements.independentAcceptanceRequired = false;
        },
        (value) =>
        {
            value.writerLeaseOrder = ['test-owner', 'ui-ux-implementer'];
        }
    ];
    for (const mutate of mutations)
    {
        const candidate = structuredClone(policy);
        mutate(candidate);
        assert.throws(() => validateBlogUiStagePolicy(candidate), { code: 'blog-ui-policy-invalid' });
    }
    assert.ok(Object.isFrozen(validateBlogUiStagePolicy(policy).uiDecisionClasses));
});

test('receipt schemas and sources no longer freeze provider model enums', () =>
{
    for (const name of [
        'ui-classification-receipt.schema.json',
        'ui-system-adjudication-receipt.schema.json',
        'ux-acceptance-receipt.schema.json',
        'blog-ui-stage-policy.json'
    ])
    {
        const text = readFileSync(path.join(skillRoot, 'contracts', name), 'utf8');
        assert.doesNotMatch(text, /gpt-5\.6-sol|sol-low|actualModel|actualEffort|actualProfile|ui-execution-profiles/u);
    }
    assert.equal(path.join(skillRoot, 'contracts/generated/ui-execution-profiles.schema.json')
        .endsWith('ui-execution-profiles.schema.json'), true);
    assert.throws(() => readFileSync(path.join(skillRoot, 'contracts/generated/ui-execution-profiles.schema.json'), 'utf8'), /ENOENT/u);
    assert.throws(() => readFileSync(path.join(skillRoot, 'contracts/ui-dispatch-receipt.schema.json'), 'utf8'), /ENOENT/u);
});

test('Skill and execution-policy docs declare external shared orchestration', () =>
{
    const skill = readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
    const execution = readFileSync(path.join(skillRoot, 'references/execution-policy.md'), 'utf8');
    const orchestrated = readFileSync(path.join(skillRoot, 'references/orchestrated-ui.md'), 'utf8');
    for (const text of [skill, execution, orchestrated])
    {
        assert.match(text, /shared orchestration|external/iu);
        assert.doesNotMatch(text, /sole execution-profile and route registry|exact model\/effort bindings|gpt-5\.6-sol/u);
    }
});

test('self-check CLI refuses to pretend it validated a supplied receipt file', () =>
{
    const result = run('unvalidated-receipt.json');
    assert.notEqual(result.status, 0);
    assert.match(output(result), /self-checks only/u);
});

test('self-check CLI reports domain policy digest', () =>
{
    const result = run();
    assert.equal(result.status, 0, output(result));
    assert.match(output(result), new RegExp(`policy=${blogUiDomainPolicyDigest}`, 'u'));
});
