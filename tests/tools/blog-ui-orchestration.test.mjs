/* eslint-disable import-x/no-relative-parent-imports -- This contract test imports the repository tools under test. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { checkExecutionProfilesSchema, executionProfilesSchemaText, executionProfilesSchemaUrl } from '../../.agents/skills/fsusblog-design-conformance/scripts/generate-execution-profiles.mjs';
import { createValidBlogUiBundle, runBlogUiSelfCheck, validateBlogUiBundle } from '../../.agents/skills/fsusblog-design-conformance/scripts/ui-orchestration.mjs';
import { blogUiStagePolicy as policy, blogUiStagePolicyDigest, validateBlogUiStagePolicy } from '../../.agents/skills/fsusblog-design-conformance/scripts/ui-stage-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const skillRoot = path.join(root, '.agents/skills/fsusblog-design-conformance');
const receiptNames = ['classification', 'dispatch', 'adjudication', 'uxAcceptance'];

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

function seal(receipt)
{
    const unsigned = { ...receipt };
    delete unsigned.receiptDigest;
    receipt.receiptDigest = createHash('sha256').update(JSON.stringify(canonical(unsigned))).digest('hex');
    return receipt;
}

function reseal(bundle)
{
    seal(bundle.classification);
    if (bundle.dispatch)
    {
        bundle.dispatch.classificationReceiptDigest = bundle.classification.receiptDigest;
        seal(bundle.dispatch);
        bundle.uxAcceptance.classificationReceiptDigest = bundle.classification.receiptDigest;
        bundle.uxAcceptance.dispatchReceiptDigest = bundle.dispatch.receiptDigest;
        seal(bundle.uxAcceptance);
    }
    bundle.adjudication.classificationReceiptDigest = bundle.classification.receiptDigest;
    seal(bundle.adjudication);
    return bundle;
}

function rejects(mutate, code)
{
    const bundle = createValidBlogUiBundle();
    mutate(bundle);
    assert.throws(() => validateBlogUiBundle(reseal(bundle)), { code });
}

function fixture(t)
{
    const directory = mkdtempSync(path.join(tmpdir(), 'fsusblog-ui-policy-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    cpSync(skillRoot, directory, { recursive: true });
    return directory;
}

function run(directory, script, ...args)
{
    return spawnSync(process.execPath, [path.join(directory, 'scripts', script), ...args], {
        cwd: directory,
        encoding: 'utf8',
        timeout: 15000
    });
}

function output(result)
{
    return `${result.stdout}\n${result.stderr}`;
}

test('UI policy self-check preserves every existing negative control', () =>
{
    const controls = JSON.parse(readFileSync(path.join(skillRoot, 'contracts/blog-ui-orchestration-negative-controls.json'), 'utf8'));
    const result = runBlogUiSelfCheck();
    assert.equal(result.schemas, 6);
    assert.equal(result.negativeControls, controls.length);
    assert.ok(controls.length >= 18);
    assert.equal(result.policyDigest, blogUiStagePolicyDigest);
});

test('all declared implementation shapes and UX classes use the exact policy binding', () =>
{
    for (const [uiDecisionClass, routes] of Object.entries(policy.implementation.routing))
    {
        if (routes === 'stop')
        {
            continue;
        }
        for (const [executionShape, profileId] of Object.entries(routes))
        {
            for (const verificationClass of Object.keys(policy.uxAcceptance.routing))
            {
                const result = validateBlogUiBundle(createValidBlogUiBundle({ uiDecisionClass, executionShape, verificationClass }));
                assert.equal(result.dispatch.actualProfile, profileId);
                assert.equal(result.dispatch.actualModel, policy.executionProfiles[profileId].model);
                assert.equal(result.dispatch.actualEffort, policy.executionProfiles[profileId].effort);
                assert.equal(result.uxAcceptance.actualProfile, policy.uxAcceptance.routing[verificationClass]);
                assert.ok(Object.isFrozen(result.dispatch));
            }
        }
    }
});

test('bounded render-probe-heavy work has a supported explicit route', () =>
{
    for (const uiDecisionClass of ['prescribed', 'bounded-composition'])
    {
        const result = validateBlogUiBundle(createValidBlogUiBundle({ uiDecisionClass, executionShape: 'render-probe-heavy' }));
        assert.equal(result.dispatch.actualProfile, policy.implementation.routing[uiDecisionClass]['render-probe-heavy']);
    }
});

test('every adjudication reason uses its declared readonly route', () =>
{
    for (const authorityState of Object.keys(policy.adjudication.routing))
    {
        const result = validateBlogUiBundle(createValidBlogUiBundle({
            uiDecisionClass: 'system-design-dispute',
            includeDispatch: false,
            adjudicationAuthorityState: authorityState
        }));
        assert.equal(result.dispatch, null);
        assert.equal(result.adjudication.actualProfile, policy.adjudication.routing[authorityState]);
        assert.equal(result.adjudication.sandbox, 'read-only');
        assert.equal(result.adjudication.requiredReslice, true);
    }
});

test('unsupported execution shapes and system disputes cannot acquire implementation dispatch', () =>
{
    for (const executionShape of [...policy.implementation.resliceShapes, 'unknown-shape'])
    {
        rejects((bundle) =>
        {
            bundle.dispatch.executionShape = executionShape;
        }, 'blog-ui-reslice-required');
    }
    rejects((bundle) =>
    {
        bundle.classification.uiDecisionClass = 'system-design-dispute';
    }, 'blog-ui-adjudication-required');
});

test('each receipt rejects a correctly re-signed stale policy identity', () =>
{
    for (const name of receiptNames)
    {
        rejects((bundle) =>
        {
            bundle[name].stagePolicyDigest = 'f'.repeat(64);
        }, 'blog-ui-stage-policy-binding');
        rejects((bundle) =>
        {
            delete bundle[name].stagePolicyDigest;
        }, 'blog-ui-stage-policy-binding');
    }
});

test('v1 Blog receipts cannot be relabeled as valid v2 evidence', () =>
{
    for (const name of receiptNames)
    {
        const bundle = createValidBlogUiBundle();
        bundle[name].schema = bundle[name].schema.replace('.v2', '.v1');
        assert.throws(() => validateBlogUiBundle(reseal(bundle)));
    }
});

test('model effort and unknown profile mismatches remain fail-closed after re-signing', () =>
{
    for (const [name, code] of [
        ['dispatch', 'blog-ui-route-mismatch'],
        ['adjudication', 'blog-ui-adjudicator-read-only'],
        ['uxAcceptance', 'blog-ui-ux-acceptance-binding']
    ])
    {
        for (const field of ['actualModel', 'actualEffort', 'actualProfile'])
        {
            rejects((bundle) =>
            {
                bundle[name][field] = 'unregistered-fixture-value';
            }, code);
        }
    }
});

test('stage-role and writer isolation cannot be bypassed with a matching profile', () =>
{
    rejects((bundle) =>
    {
        bundle.dispatch.stageRole = 'code-implementer';
    }, 'blog-ui-implementer-role');
    for (const forbidden of ['tests/example.test.mjs', 'docs/security.md', '.agents/skills/example/SKILL.md'])
    {
        rejects((bundle) =>
        {
            bundle.dispatch.firstWritablePath = forbidden;
            bundle.dispatch.allowedPaths = [forbidden];
        }, 'blog-ui-write-lease');
    }
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
});

test('behavior green cannot replace independent current rendered acceptance', () =>
{
    rejects((bundle) =>
    {
        bundle.behaviorGreen = false;
    }, 'blog-ui-behavior-green-required');
    for (const field of ['renderedArtifacts', 'viewportStateMatrix'])
    {
        rejects((bundle) =>
        {
            bundle.uxAcceptance[field] = [];
        }, 'blog-ui-ux-acceptance-binding');
    }
    rejects((bundle) =>
    {
        bundle.uxAcceptance.verifierRunIdentityDigest = bundle.uxAcceptance.implementationRunIdentityDigest;
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
        bundle.dispatch.fsusUIBaselineDigest = 'e'.repeat(64);
    }, 'blog-ui-authority-binding');
    rejects((bundle) =>
    {
        bundle.dispatch.requiredSkills.pop();
    }, 'blog-ui-authority-binding');
    rejects((bundle) =>
    {
        bundle.classification.fsusUIBaseline.dirty = true;
    }, 'blog-ui-baseline-identity');
});

test('freshly signed adjudication for a different classification is rejected in both paths', () =>
{
    for (const includeDispatch of [true, false])
    {
        const bundle = createValidBlogUiBundle({
            uiDecisionClass: includeDispatch ? 'prescribed' : 'system-design-dispute',
            includeDispatch
        });
        bundle.adjudication.classificationReceiptDigest = 'e'.repeat(64);
        seal(bundle.adjudication);
        assert.throws(() => validateBlogUiBundle(bundle), { code: 'blog-ui-adjudication-binding' });
    }
});

test('policy rejects unknown fields undeclared routes and relaxed execution boundaries', () =>
{
    const mutations = [
        (value) =>
        {
            value.waiver = true;
        },
        (value) =>
        {
            value.executionProfiles[Object.keys(value.executionProfiles)[0]].fallback = '*';
        },
        (value) =>
        {
            value.implementation.routing.prescribed['atomic-edit'] = 'unknown-profile';
        },
        (value) =>
        {
            value.implementation.routing.prescribed['complete-page-system'] = value.implementation.allowedProfiles[0];
        },
        (value) =>
        {
            value.implementation.automaticPromotion = true;
        },
        (value) =>
        {
            value.adjudication.sandbox = 'workspace-write';
        },
        (value) =>
        {
            delete value.adjudication.routing['authority-conflict'];
        },
        (value) =>
        {
            value.uxAcceptance.writeScope = 'implementation-only';
        },
        (value) =>
        {
            value.humanGate.eligibleReasons.push(value.humanGate.ineligibleReasons[0]);
        }
    ];
    for (const mutate of mutations)
    {
        const candidate = structuredClone(policy);
        mutate(candidate);
        assert.throws(() => validateBlogUiStagePolicy(candidate), { code: 'blog-ui-policy-invalid' });
    }
    assert.ok(Object.isFrozen(validateBlogUiStagePolicy(policy).executionProfiles));
});

test('generated profile schema is an exact repeatable projection of policy bytes', () =>
{
    checkExecutionProfilesSchema();
    assert.equal(readFileSync(executionProfilesSchemaUrl, 'utf8'), executionProfilesSchemaText());
    assert.equal(executionProfilesSchemaText(), executionProfilesSchemaText());
    const schema = JSON.parse(executionProfilesSchemaText());
    assert.equal(schema.$defs.stagePolicyDigest.const, blogUiStagePolicyDigest);
    for (const [stage, ids] of [
        ['implementation', policy.implementation.allowedProfiles],
        ['adjudication', policy.adjudication.allowedProfiles],
        ['uxAcceptance', [...new Set(Object.values(policy.uxAcceptance.routing))]]
    ])
    {
        assert.deepEqual(schema.$defs[stage].oneOf.map((entry) => entry.properties.actualProfile.const), ids);
        for (const entry of schema.$defs[stage].oneOf)
        {
            const profile = policy.executionProfiles[entry.properties.actualProfile.const];
            assert.equal(entry.properties.actualModel.const, profile.model);
            assert.equal(entry.properties.actualEffort.const, profile.effort);
        }
    }
});

test('alternate owner policy changes profile names models and effort without checker edits', (t) =>
{
    const directory = fixture(t);
    const policyFile = path.join(directory, 'contracts/blog-ui-stage-policy.json');
    const candidate = structuredClone(policy);
    const ids = Object.keys(candidate.executionProfiles);
    let serialized = JSON.stringify(candidate);
    ids.forEach((id, index) =>
    {
        serialized = serialized.replaceAll(JSON.stringify(id), JSON.stringify(`reviewed-profile-${index}`));
    });
    const alternate = JSON.parse(serialized);
    for (const [index, profile] of Object.values(alternate.executionProfiles).entries())
    {
        profile.model = `fixture-provider/model-${index}`;
        profile.effort = `fixture-depth-${index}`;
    }
    writeFileSync(policyFile, `${JSON.stringify(alternate, null, 2)}\n`);
    assert.notEqual(run(directory, 'generate-execution-profiles.mjs', '--check').status, 0);
    const generate = run(directory, 'generate-execution-profiles.mjs', '--write');
    assert.equal(generate.status, 0, output(generate));
    const check = run(directory, 'ui-orchestration.mjs');
    assert.equal(check.status, 0, output(check));
    const generated = readFileSync(path.join(directory, 'contracts/generated/ui-execution-profiles.schema.json'), 'utf8');
    assert.ok(generated.includes('fixture-provider/model-0'));
    for (const id of ids)
    {
        assert.ok(!generated.includes(`"${id}"`));
    }
    for (const script of ['ui-orchestration.mjs', 'ui-stage-policy.mjs', 'generate-execution-profiles.mjs'])
    {
        assert.equal(readFileSync(path.join(directory, 'scripts', script), 'utf8'), readFileSync(path.join(skillRoot, 'scripts', script), 'utf8'));
    }
});

test('stale generated profile schema blocks checker import not just the CLI self-check', (t) =>
{
    const directory = fixture(t);
    const generated = path.join(directory, 'contracts/generated/ui-execution-profiles.schema.json');
    writeFileSync(generated, '{}\n');
    const url = pathToFileURL(path.join(directory, 'scripts/ui-orchestration.mjs')).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)})`], { encoding: 'utf8', timeout: 15000 });
    assert.notEqual(result.status, 0);
    assert.match(output(result), /blog-ui-profile-schema-drift/u);
});

test('self-check CLI refuses to pretend it validated a supplied receipt file', () =>
{
    const result = run(skillRoot, 'ui-orchestration.mjs', 'unvalidated-receipt.json');
    assert.notEqual(result.status, 0);
    assert.match(output(result), /self-checks only/u);
});

test('generated binding manifest drift also blocks checker import', (t) =>
{
    const directory = fixture(t);
    writeFileSync(path.join(directory, 'contracts/generated/ui-execution-profiles.binding.json'), '{}\n');
    const result = run(directory, 'ui-orchestration.mjs');
    assert.notEqual(result.status, 0);
    assert.match(output(result), /blog-ui-profile-schema-drift/u);
});
