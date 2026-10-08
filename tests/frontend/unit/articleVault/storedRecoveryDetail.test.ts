// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import VaultStoredRecoveryDetail from '@/components/admin/article/vault/VaultStoredRecoveryDetail.vue';
import VaultStatusUnavailable from '@/components/admin/article/vault/VaultStatusUnavailable.vue';
import {
    presentVaultStoredRecovery,
    type VaultStoredRecoveryDisplayScope,
    type VaultStoredRecoverySnapshot,
    type VaultStoredResolutionProposal
} from '@/services/articleVault/storedRecoveryPresentation';

const expected: VaultStoredRecoveryDisplayScope = {
    siteIdentity: 'site-fixture', vaultIdentity: 'vault-fixture', deviceIdentity: 'device-fixture', agentIdentity: 'agent-fixture',
    portableArticleIdentity: 'article-fixture', serverArticleIdentity: '123', planReference: 'plan-fixture', planSha256: 'a'.repeat(64),
    groupIdentity: 'group-fixture', itemOperationIdentity: 'item-fixture', operationIdentity: 'operation-fixture', operationSha256: 'b'.repeat(64),
    resolutionOperationIdentity: `resolution-${'c'.repeat(64)}`, resolutionPlanSha256: 'd'.repeat(64), exactSequence: 3, exactCheckpointSha256: 'e'.repeat(64)
};
// Producer shape fixtures only, not current facts, a sealed store record or an accepted history.
const proposal: VaultStoredResolutionProposal = {
    schema: 'fsusblog.article-vault.resolution-plan.v1', schemaVersion: 1,
    resolutionOperationIdentity: expected.resolutionOperationIdentity, state: 'prepared', contentSha256: expected.resolutionPlanSha256,
    evidenceSha256: '1'.repeat(64), gitFactsSha256: '2'.repeat(64), rootManifestSha256: '3'.repeat(64),
    binding: {
        siteIdentity: expected.siteIdentity, vaultIdentity: expected.vaultIdentity, deviceIdentity: expected.deviceIdentity,
        portableArticleIdentity: expected.portableArticleIdentity, serverArticleIdentity: expected.serverArticleIdentity,
        planCandidateIdentity: expected.planReference, planSha256: expected.planSha256,
        groupIdentity: expected.groupIdentity, operationIdentity: expected.itemOperationIdentity
    }
};
const snapshot: VaultStoredRecoverySnapshot = {
    resolutionPlanSha256: expected.resolutionPlanSha256,
    operation: {
        schema: 'fsusblog.article-vault.operation-identity.v1', schemaVersion: 1,
        siteIdentity: expected.siteIdentity, vaultIdentity: expected.vaultIdentity, deviceIdentity: expected.deviceIdentity,
        agentIdentity: expected.agentIdentity, planReference: expected.planReference, planSha256: expected.planSha256,
        operationIdentity: expected.operationIdentity, contentSha256: expected.operationSha256
    },
    checkpoints: [{
        schema: 'fsusblog.article-vault.operation-checkpoint.v1', schemaVersion: 1, operationIdentity: expected.operationIdentity,
        identitySha256: expected.operationSha256, sequence: 3, state: 'blocked', serverCommit: 'not-started',
        serverResult: null, materializationReceipt: null, reasonCode: 'capability_missing', contentSha256: expected.exactCheckpointSha256
    }],
    serverResult: null,
    missingCapabilities: ['canonical_conflict_resolution_execution_admission', 'encrypted_recovery_backup_and_journal_persistence',
        'native_conditional_write_and_readback', 'atomic_verified_manifest_base_receipt_commit']
};

describe('exact stored proposal/operation checkpoint display (#2133)', () => {
    it.each(Object.keys(expected) as (keyof VaultStoredRecoveryDisplayScope)[])('rejects crossed exact %s', (field) => {
        const crossed = { ...expected, [field]: field === 'exactSequence' ? 4 : `${expected[field]}-crossed` };
        expect(presentVaultStoredRecovery(proposal, snapshot, crossed)).toBeNull();
    });

    it('keeps original plan, resolution proposal and operation identity digests distinct', () => {
        const view = presentVaultStoredRecovery(proposal, snapshot, expected)!;
        expect(view.rows.find(row => row.label === '原始 sync plan / SHA-256')?.value).toContain(expected.planSha256);
        expect(view.rows.find(row => row.label === 'Resolution operation / proposal SHA-256')?.value).toContain(expected.resolutionPlanSha256);
        expect(view.rows.find(row => row.label === 'Operation / identity SHA-256')?.value).toContain(expected.operationSha256);
        expect(presentVaultStoredRecovery(proposal, { ...snapshot, resolutionPlanSha256: expected.planSha256 }, expected)).toBeNull();
        expect(view.missingCapabilities).toHaveLength(4);
        expect(view.missingCapabilities).toContain('原子 manifest/base 回执提交');
    });

    it('does not turn operation checkpoints into a recovery journal or select a latest checkpoint', () => {
        const journal = { schema: 'fsusblog.article-vault.recovery-journal.v1', resolutionOperationIdentity: expected.resolutionOperationIdentity };
        const wrongKind = { ...snapshot, checkpoints: [journal] } as unknown as VaultStoredRecoverySnapshot;
        expect(presentVaultStoredRecovery(proposal, wrongKind, expected)).toBeNull();
        expect(presentVaultStoredRecovery(proposal, { ...snapshot, checkpoints: [] }, expected)).toBeNull();
        expect(presentVaultStoredRecovery(proposal, { ...snapshot, checkpoints: [{ ...snapshot.checkpoints[0], sequence: 9 }] }, expected)).toBeNull();
        const ordered = { ...snapshot, checkpoints: [{ ...snapshot.checkpoints[0], sequence: 2, contentSha256: '4'.repeat(64) }, snapshot.checkpoints[0]] };
        const before = JSON.stringify(ordered);
        expect(presentVaultStoredRecovery(proposal, ordered, expected)?.checkpoints.map(item => item.sequence)).toEqual([2, 3]);
        expect(JSON.stringify(ordered)).toBe(before);
    });

    it('projects only safe refs and closed reasons, omitting package/source/token/unknown producer fields', () => {
        const extras = {
            ...snapshot, privatePackage: { rawMarkdown: 'private-source-secret' }, token: 'token-secret',
            checkpoints: [{ ...snapshot.checkpoints[0], rootPath: '/private-root-secret' }],
            missingCapabilities: [...snapshot.missingCapabilities, 'private-source-secret']
        };
        const view = presentVaultStoredRecovery(proposal, extras, expected);
        expect(JSON.stringify(view)).not.toMatch(/private-source-secret|token-secret|private-root-secret/u);
        expect(view?.missingCapabilities.at(-1)).toContain('未识别');
        const unsafe = { ...snapshot, checkpoints: [{ ...snapshot.checkpoints[0], serverResult: { reference: '/private-root-secret', contentSha256: '5'.repeat(64) } }] };
        expect(presentVaultStoredRecovery(proposal, unsafe, expected)).toBeNull();
    });

    it('displays historical accepted/synced with explicit unknown current/base state and no recovery commands', () => {
        const historical = { ...snapshot, checkpoints: [{ ...snapshot.checkpoints[0], state: 'synced' as const, serverCommit: 'accepted' as const,
            serverResult: { reference: 'result-fixture', contentSha256: '6'.repeat(64) },
            materializationReceipt: { reference: 'materialization-fixture', contentSha256: '7'.repeat(64) } }] };
        const wrapper = mount(VaultStoredRecoveryDetail, { props: { proposal, snapshot: historical, expected } });
        expect(wrapper.text()).toContain('synced');
        expect(wrapper.text()).toContain('accepted');
        expect(wrapper.text()).toContain('不是 recovery journal');
        expect(wrapper.text()).toContain('当前同步、恢复授权和 base 状态仍未知');
        expect(wrapper.text()).toContain('读取 accepted source 也不授权提交 base');
        expect(wrapper.findAll('button, input, a')).toHaveLength(0);
        expect(wrapper.emitted()).toEqual({});
        wrapper.unmount();
    });

    it('hides details after scope changes or absent exact documents', async () => {
        const wrapper = mount(VaultStoredRecoveryDetail, { props: { proposal, snapshot, expected } });
        expect(wrapper.get('dl').text()).toContain(expected.siteIdentity);
        await wrapper.setProps({ expected: { ...expected, vaultIdentity: 'crossed-vault' } });
        expect(wrapper.get('[role="status"]').text()).toContain('详情不可用');
        expect(wrapper.find('dl').exists()).toBe(false);
        expect(wrapper.text()).not.toContain(expected.resolutionPlanSha256);
        expect(presentVaultStoredRecovery(null, snapshot, expected)).toBeNull();
        expect(presentVaultStoredRecovery(proposal, null, expected)).toBeNull();
        expect(presentVaultStoredRecovery(proposal, snapshot, null)).toBeNull();
        wrapper.unmount();
    });

    it('composes producer-shaped stored details inside the existing unknown status owner', async () => {
        const wrapper = mount(VaultStatusUnavailable, { props: { storedProposal: proposal, storedSnapshot: snapshot, storedRecoveryScope: expected } });
        expect(wrapper.get('summary').text()).toBe('Vault：状态未知');
        expect(wrapper.text()).toContain('已保存的 proposal 与 operation checkpoint');
        expect(wrapper.text()).toContain(expected.resolutionPlanSha256);
        expect(wrapper.findAll('details')).toHaveLength(1);
        expect(wrapper.findAll('button')).toHaveLength(0);
        await wrapper.setProps({ storedRecoveryScope: { ...expected, operationIdentity: 'another-operation' } });
        expect(wrapper.text()).toContain('详情不可用');
        expect(wrapper.text()).not.toContain(expected.resolutionPlanSha256);
        expect(wrapper.get('summary').text()).toBe('Vault：状态未知');
        wrapper.unmount();
    });
});
