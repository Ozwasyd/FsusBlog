// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import VaultResolutionStatus from '@/components/article-vault/VaultResolutionStatus.vue';
import { vaultCurrentCheckIntent } from '@/components/article-vault/resolutionStatusPresentation';
import type {
    RecoveryJournalPresentation, ResolutionPlanPresentation, VaultBoundValidationPresentation
} from '@/components/article-vault/resolutionStatusPresentation';
import schema from '../../../../src/shared/Contracts/ArticleVault/article-vault-conflict-evidence.schema.json';

/** Synthetic render fixtures only; compiled terminal tests separately exercise canonical Shared APIs. */
function proposal(): ResolutionPlanPresentation {
    const coordinate = {
        present: true, deleted: false, serverRevision: 3, lifecycle: 'draft', source: { sha256: 'a'.repeat(64) },
        metadataManifestSha256: 'b'.repeat(64), dependencySha256: 'c'.repeat(64),
        permissionSha256: 'd'.repeat(64), contentSha256: 'e'.repeat(64)
    };
    return {
        schema: 'fsusblog.article-vault.resolution-plan.v1', schemaVersion: 1,
        resolutionOperationIdentity: 'resolution-1', state: 'prepared', contentSha256: '1'.repeat(64),
        evidenceSha256: '2'.repeat(64), gitFactsSha256: '3'.repeat(64),
        binding: { portableArticleIdentity: 'article-1', operationIdentity: 'observation-1',
            planSha256: '4'.repeat(64), coordinates: { base: coordinate, local: coordinate, server: coordinate } },
        groups: [{ groupIdentity: 'group-1', allOrNothing: true,
            portableArticleIdentities: ['article-1', 'article-2'], dependencies: [
                { prerequisitePortableArticleIdentity: 'article-1', dependentPortableArticleIdentity: 'article-2' }
            ] }, { groupIdentity: 'group-2', allOrNothing: true, portableArticleIdentities: ['article-2'], dependencies: [] }],
        decisions: [{ type: 'metadata-overlap', action: 'propose-metadata-replacement', provenance: 'manual',
            resultCandidateSha256: '5'.repeat(64) }],
        expectedOutput: { expectedServerRevision: 3, sourceSha256: '6'.repeat(64),
            metadataManifestSha256: '7'.repeat(64), dependencySha256: '8'.repeat(64) }, expiresAtUnixMs: 1000
    };
}

function descriptor(plan = proposal(), state = 'recovery-required'): RecoveryJournalPresentation {
    return {
        schema: 'fsusblog.article-vault.recovery-journal.v1', schemaVersion: 1,
        resolutionOperationIdentity: plan.resolutionOperationIdentity, planSha256: plan.contentSha256,
        sequence: 2, state, previousCheckpointSha256: '9'.repeat(64), contentSha256: 'a'.repeat(64),
        serverResult: { identity: 'server-result-1', contentSha256: 'b'.repeat(64) },
        localMaterialization: null, baseCommit: null, beforeBaseSha256: 'c'.repeat(64), afterBaseSha256: null,
        backupPolicy: { maxBytes: 1024, deleteAfterUnixMs: 2000, encryptionRequired: true }
    };
}

const mounted: ReturnType<typeof mount>[] = [];
function render(plan = proposal(), journal: RecoveryJournalPresentation | null = descriptor(plan)) {
    const checkpoint = journal ? {
        identity: `${plan.resolutionOperationIdentity}-checkpoint-${journal.sequence}`, contentSha256: journal.contentSha256
    } : null;
    const wrapper = mount(VaultResolutionStatus, { props: {
        plan, schema, checkpoint, journal, planValidation: null, historyValidation: null,
        executionAdmission: null, recoveryAdmission: null
    }, attachTo: document.body });
    mounted.push(wrapper);
    return wrapper;
}
afterEach(() => { mounted.splice(0).forEach(wrapper => wrapper.unmount()); });

describe('Vault resolution proposal and checkpoint presentation', () => {
    it('shows exact distinct article count, operations, atomic constraints and expected output references', () => {
        const wrapper = render();
        expect(wrapper.text()).toContain('2 篇文章 · 1 项操作');
        expect(wrapper.text()).toContain('全部或无');
        expect(wrapper.text()).toContain('article-1 → article-2');
        expect(wrapper.findAll('section[aria-label]').map(section => section.attributes('aria-label')))
            .toEqual(['共同基线', '本地', '服务端']);
        expect(wrapper.text()).toContain('权限摘要');
        expect(wrapper.text()).toContain('依赖摘要');
        expect(wrapper.text()).toContain('7'.repeat(64));
        expect(wrapper.text()).toContain('尚无机器校验结果');
        expect(wrapper.attributes('aria-labelledby')).toBe(wrapper.get('h2').attributes('id'));
    });

    it.each(['prepared', 'server-committing', 'server-committed', 'local-materializing', 'recovery-required',
        'recovered', 'rolled-forward', 'cancelled', 'failed', 'complete'])('renders only the supplied canonical checkpoint state: %s', state => {
        const wrapper = render(proposal(), descriptor(proposal(), state));
        expect(wrapper.findAll('[role="status"]')).toHaveLength(2);
        expect(wrapper.text()).not.toContain('已同步');
        expect(wrapper.text()).toContain('检查点引用与策略要求不代表备份、落盘或清理已完成');
        expect(wrapper.findAll('button').map(button => button.text())).toEqual(['重新校验当前引用']);
    });

    it('preserves canonical missing-execution and missing-recovery refusal reason codes', async () => {
        const wrapper = render();
        const requested = vaultCurrentCheckIntent(wrapper.props('plan')!, wrapper.props('checkpoint'));
        await wrapper.setProps({
            executionAdmission: { requested, result: { isValid: false, reasonCode: 'article_vault_resolution_canonical_execution_admission_missing' } },
            recoveryAdmission: { requested, result: { isValid: false, reasonCode: 'article_vault_recovery_canonical_materializer_and_operation_admission_missing' } }
        });
        expect(wrapper.text()).toContain('article_vault_resolution_canonical_execution_admission_missing');
        expect(wrapper.text()).toContain('article_vault_recovery_canonical_materializer_and_operation_admission_missing');
        expect(wrapper.text()).not.toContain('通过');
    });

    it('does not promote old passing checks when the plan reference changes', async () => {
        const wrapper = render();
        const check: VaultBoundValidationPresentation = {
            requested: vaultCurrentCheckIntent(wrapper.props('plan')!, wrapper.props('checkpoint')),
            result: { isValid: true, reasonCode: null }
        };
        await wrapper.setProps({ planValidation: check, historyValidation: check, executionAdmission: check, recoveryAdmission: check });
        expect(wrapper.text()).toContain('通过');
        await wrapper.setProps({ plan: { ...proposal(), contentSha256: 'd'.repeat(64) } });
        expect(wrapper.text()).not.toContain('通过');
        expect(wrapper.text().match(/校验结果不属于当前引用/g)).toHaveLength(4);
    });

    it('binds history and recovery checks to the exact requested checkpoint, including reload races', async () => {
        const wrapper = render();
        const requested = vaultCurrentCheckIntent(wrapper.props('plan')!, wrapper.props('checkpoint'));
        const check = { requested, result: { isValid: true, reasonCode: null } };
        await wrapper.setProps({ historyValidation: check, recoveryAdmission: check });
        await wrapper.setProps({ checkpoint: { ...wrapper.props('checkpoint')!, contentSha256: 'e'.repeat(64) } });
        expect(wrapper.text()).not.toContain('通过');
        expect(wrapper.text()).toContain('操作、计划或精确检查点引用不匹配');
        expect(wrapper.text()).not.toContain('检查点 2');
        await wrapper.get('button').trigger('click');
        expect(wrapper.emitted('request-current-check')).toEqual([[{
            resolutionOperationIdentity: 'resolution-1', planSha256: proposal().contentSha256,
            checkpoint: { identity: 'resolution-1-checkpoint-2', contentSha256: 'e'.repeat(64) }
        }]]);
    });

    it.each(['operation', 'plan', 'tip', 'version', 'state'])('fails closed on incompatible checkpoint %s', variant => {
        const journal = descriptor();
        const wrapper = render(proposal(), { ...journal,
            resolutionOperationIdentity: variant === 'operation' ? 'another-operation' : journal.resolutionOperationIdentity,
            planSha256: variant === 'plan' ? 'e'.repeat(64) : journal.planSha256,
            schemaVersion: variant === 'version' ? 2 : journal.schemaVersion,
            state: variant === 'state' ? 'synced' : journal.state,
            sequence: variant === 'tip' ? 0 : journal.sequence
        });
        if (variant === 'tip') {
            // The explicit requested tip, rather than a newest journal lookup, controls display.
            return wrapper.setProps({ checkpoint: { identity: 'resolution-1-checkpoint-2', contentSha256: journal.contentSha256 } })
                .then(() => expect(wrapper.text()).not.toContain('检查点 2'));
        }
        expect(wrapper.text()).not.toContain('检查点 2');
        expect(wrapper.text()).toContain('不匹配');
    });

    it('requests exact immutable references without mutating plan or journal', async () => {
        const plan = proposal();
        const journal = descriptor(plan);
        const before = JSON.stringify({ plan, journal });
        const wrapper = render(plan, journal);
        await wrapper.get('button').trigger('click');
        expect(wrapper.emitted('request-current-check')?.[0]?.[0]).toEqual(vaultCurrentCheckIntent(plan, wrapper.props('checkpoint')));
        expect(JSON.stringify({ plan, journal })).toBe(before);
        expect(wrapper.findAll('input, textarea, [contenteditable]')).toHaveLength(0);
    });

    it('keeps unknown proposal vocabulary and private extra fields out of rendered output', async () => {
        const plan = { ...proposal(), rawSource: 'private-source', credential: 'secret-token' };
        const wrapper = render(plan, { ...descriptor(plan), privateBackupBytes: 'private-backup' } as RecoveryJournalPresentation);
        for (const secret of ['private-source', 'secret-token', 'private-backup']) expect(wrapper.html()).not.toContain(secret);
        await wrapper.setProps({ plan: { ...plan, decisions: [{ ...plan.decisions[0], action: 'accept-all-local' }] } });
        expect(wrapper.text()).toContain('不兼容');
        expect(wrapper.findAll('button')).toHaveLength(0);
    });

    it('renders absent proposals and checkpoints without synthesizing a recovery state', async () => {
        const wrapper = render(proposal(), null);
        expect(wrapper.text()).toContain('尚未加载精确检查点');
        await wrapper.setProps({ plan: null });
        expect(wrapper.text()).toContain('尚未加载解决提案');
        expect(wrapper.findAll('button')).toHaveLength(0);
    });
});
