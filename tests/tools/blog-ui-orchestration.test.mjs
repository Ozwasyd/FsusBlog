/* eslint-disable import-x/no-relative-parent-imports -- This contract test imports the repository tools under test. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createValidBlogUiBundle, runBlogUiSelfCheck, sealBlogUiAdjudication, validateBlogUiBundle } from '../../.agents/skills/fsusblog-design-conformance/scripts/ui-orchestration.mjs';
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

test('receipt shape rejects external scheduler route and runtime claims', () =>
{
    for (const field of [
        'model', 'profile', 'route', 'runtime', 'runtimeProfile', 'lease', 'stage', 'retry'
    ])
    {
        const bundle = createValidBlogUiBundle();
        bundle.classification[field] = 'external-scheduler-value';
        assert.throws(() => validateBlogUiBundle(reseal(bundle)), {
            code: 'blog-ui-orchestration-authority-leak'
        });
    }
    const bundle = createValidBlogUiBundle();
    bundle.classification.waiver = true;
    assert.throws(() => validateBlogUiBundle(reseal(bundle)), {
        code: 'blog-ui-receipt-shape'
    });

    for (const field of ['route', 'runtime', 'model'])
    {
        const topLevel = createValidBlogUiBundle();
        topLevel[field] = 'external-scheduler-value';
        assert.throws(() => validateBlogUiBundle(topLevel), {
            code: 'blog-ui-orchestration-authority-leak'
        });
    }
});

test('baseline runtime identity drift cannot cross the active candidate binding', () =>
{
    const bundle = createValidBlogUiBundle();
    bundle.classification.fsusUIBaseline.packageVersion = '0.35.0';
    seal(bundle.classification.fsusUIBaseline, 'baselineDigest');
    assert.throws(() => validateBlogUiBundle(reseal(bundle)), {
        code: 'blog-ui-authority-binding'
    });

    const invalid = createValidBlogUiBundle();
    invalid.classification.fsusUIBaseline.gitHead = 'not-a-commit';
    assert.throws(() => validateBlogUiBundle(reseal(invalid)), {
        code: 'blog-ui-baseline-identity'
    });
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

test('adjudication cannot cross candidate identity even with a fresh receipt digest', () =>
{
    for (const [field, value] of [
        ['candidateSha', '9'.repeat(40)],
        ['candidateIdentityDigest', 'e'.repeat(64)]
    ])
    {
        const bundle = createValidBlogUiBundle();
        bundle.adjudication[field] = value;
        seal(bundle.adjudication, 'adjudicationDigest');
        assert.throws(() => validateBlogUiBundle(bundle), {
            code: 'blog-ui-adjudication-binding'
        });
    }
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
    assert.match(execution, /Migration and rollback validation limits/iu);
    assert.match(execution, /do not validate.*external scheduler/isu);
    assert.match(execution, /tests\/tools\/public-design-document-authority\.test\.mjs/iu);
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

test('freshly sealed rendered evidence still requires complete schema-defined observations', () =>
{
    for (const field of ['viewport', 'state', 'theme', 'inputModes', 'evidenceDigest'])
    {
        rejects((bundle) =>
        {
            delete bundle.uxAcceptance.viewportStateMatrix[0][field];
        }, 'blog-ui-ux-acceptance-binding');
    }
    for (const field of ['id', 'kind', 'path', 'digest', 'inspected', 'fixtureClass'])
    {
        rejects((bundle) =>
        {
            delete bundle.uxAcceptance.inspectedRenderedArtifacts[0][field];
        }, 'blog-ui-ux-acceptance-binding');
    }
});

test('nested evidence rejects waivers invalid enums duplicates and non-object observations', () =>
{
    const mutations = [
        (bundle) =>
        {
            bundle.uxAcceptance.inspectedRenderedArtifacts[0].waiver = true;
        },
        (bundle) =>
        {
            bundle.uxAcceptance.viewportStateMatrix[0].waiver = true;
        },
        (bundle) =>
        {
            bundle.uxAcceptance.viewportStateMatrix[0].theme = 'unverified';
        },
        (bundle) =>
        {
            bundle.uxAcceptance.viewportStateMatrix[0].inputModes = ['keyboard', 'keyboard'];
        },
        (bundle) =>
        {
            bundle.uxAcceptance.viewportStateMatrix[0].inputModes = ['unverified'];
        },
        (bundle) =>
        {
            bundle.uxAcceptance.inspectedRenderedArtifacts[0].kind = 'static-check';
        },
        (bundle) =>
        {
            bundle.uxAcceptance.inspectedRenderedArtifacts[0].path = '';
        },
        (bundle) =>
        {
            bundle.uxAcceptance.viewportStateMatrix[0] = null;
        },
        (bundle) =>
        {
            bundle.uxAcceptance.inspectedRenderedArtifacts[0] = null;
        }
    ];
    for (const mutate of mutations)
    {
        rejects(mutate, 'blog-ui-ux-acceptance-binding');
    }
});

test('nested authority references cannot carry independently sealed extra claims', () =>
{
    rejects((bundle) =>
    {
        bundle.classification.requiredDesignAuthorities[0].waiver = true;
    }, 'blog-ui-authority-binding');
    rejects((bundle) =>
    {
        bundle.classification.requiredDesignAuthorities[0] = null;
    }, 'blog-ui-authority-binding');
    rejects((bundle) =>
    {
        bundle.classification.fsusUIBaseline.contractDigests.waiver = true;
        seal(bundle.classification.fsusUIBaseline, 'baselineDigest');
    }, 'blog-ui-baseline-identity');
});

test('an independently valid adjudication cannot be spliced across task candidate baseline or authority', () =>
{
    const mutations = [
        (receipt) =>
        {
            receipt.issueId = '3268';
        },
        (receipt) =>
        {
            receipt.candidateSha = '7'.repeat(40);
        },
        (receipt) =>
        {
            receipt.candidateIdentityDigest = 'e'.repeat(64);
        },
        (receipt) =>
        {
            receipt.ownerRepository = 'Ozwasyd/FsusUI';
        },
        (receipt) =>
        {
            receipt.affectedSurfaces = ['different-surface'];
        },
        (receipt) =>
        {
            receipt.requiredDesignAuthorities[0].digest = 'e'.repeat(64);
        },
        (receipt) =>
        {
            receipt.fsusUIBaseline.packageVersion = 'other-active-baseline';
            seal(receipt.fsusUIBaseline, 'baselineDigest');
        }
    ];
    for (const mutate of mutations)
    {
        const bundle = createValidBlogUiBundle();
        const unrelated = bundle.adjudicationClassification;
        mutate(unrelated);
        bundle.adjudication.ownerRepository = unrelated.ownerRepository;
        bundle.adjudication.candidateSha = unrelated.candidateSha;
        bundle.adjudication.candidateIdentityDigest = unrelated.candidateIdentityDigest;
        bundle.adjudication.authoritativeSkillDigests = unrelated.requiredDesignAuthorities.map((entry) => entry.digest);
        bundle.adjudication.authorityDigests = [...bundle.adjudication.authoritativeSkillDigests];
        bundle.adjudication.activeBaselineIdentityDigest = unrelated.fsusUIBaseline.baselineDigest;
        reseal(bundle);
        // The standalone receipt is valid against its own classification.
        assert.doesNotThrow(() => sealBlogUiAdjudication(bundle.adjudication, unrelated));
        assert.throws(() => validateBlogUiBundle(bundle), { code: 'blog-ui-adjudication-binding' });
    }
});

test('standalone adjudication validates the supplied classification reference itself', () =>
{
    const bundle = createValidBlogUiBundle();
    bundle.adjudicationClassification.receiptDigest = 'e'.repeat(64);
    bundle.adjudication.classificationReceiptDigest = 'e'.repeat(64);
    seal(bundle.adjudication, 'adjudicationDigest');
    assert.throws(() => sealBlogUiAdjudication(bundle.adjudication, bundle.adjudicationClassification), {
        code: 'blog-ui-authority-binding'
    });
});

test('bundle requires an explicit boolean overlap declaration and every domain input', () =>
{
    for (const field of Object.keys(createValidBlogUiBundle()))
    {
        const bundle = createValidBlogUiBundle();
        delete bundle[field];
        assert.throws(() => validateBlogUiBundle(bundle), { code: 'blog-ui-bundle-shape' });
    }
    for (const value of [null, 0, '', 'false', []])
    {
        rejects((bundle) =>
        {
            bundle.overlappingImplementationOwner = value;
        }, 'blog-ui-bundle-shape');
    }
});

test('alternate package-pin baseline remains usable when every consumed reference agrees', () =>
{
    const bundle = createValidBlogUiBundle();
    const baseline = bundle.baseline;
    baseline.sourceKind = 'package-pin';
    baseline.absolutePath = null;
    baseline.gitHead = null;
    baseline.packageVersion = 'fixture-package-pin';
    seal(baseline, 'baselineDigest');
    bundle.classification.fsusUIBaseline = structuredClone(baseline);
    bundle.adjudicationClassification.fsusUIBaseline = structuredClone(baseline);
    bundle.adjudication.activeBaselineIdentityDigest = baseline.baselineDigest;
    bundle.uxAcceptance.fsusUIBaselineDigest = baseline.baselineDigest;
    const result = validateBlogUiBundle(reseal(bundle));
    assert.equal(result.baseline.sourceKind, 'package-pin');
    assert.equal(result.classification.fsusUIBaseline.baselineDigest, baseline.baselineDigest);
});
