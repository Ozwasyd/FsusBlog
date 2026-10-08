// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import VaultRecoveryCheckpointDetail from '@/components/admin/article/vault/VaultRecoveryCheckpointDetail.vue';
import {
    presentVaultRecoveryCheckpoint,
    type VaultRecoveryCheckpointDisplayScope,
    type VaultRecoveryCheckpointDocument
} from '@/services/articleVault/recoveryCheckpointPresentation';

// Synthetic component-unit data only: no sealed history or materialized artifacts are asserted.
const checkpointDigest = 'a'.repeat(64);
const resolutionPlanDigest = 'b'.repeat(64);
const artifactDigest = 'c'.repeat(64);
const expected: VaultRecoveryCheckpointDisplayScope = {
    siteIdentity: 'site-one', vaultIdentity: 'vault-one', deviceIdentity: 'device-one',
    resolutionOperationIdentity: 'resolution-one', planSha256: resolutionPlanDigest,
    checkpoint: { identity: 'resolution-one-checkpoint-4', contentSha256: checkpointDigest }
};

function journal(state: VaultRecoveryCheckpointDocument['state'] = 'recovery-required'): VaultRecoveryCheckpointDocument
{
    const hasMaterialization = ['complete', 'recovered', 'rolled-forward'].includes(state);
    return {
        schema: 'fsusblog.article-vault.recovery-journal.v1', schemaVersion: 1,
        siteIdentity: expected.siteIdentity, vaultIdentity: expected.vaultIdentity,
        deviceIdentity: expected.deviceIdentity, resolutionOperationIdentity: expected.resolutionOperationIdentity,
        planSha256: resolutionPlanDigest, sequence: 4, state,
        serverResult: { identity: 'server-result-one', contentSha256: artifactDigest },
        localMaterialization: hasMaterialization ? { identity: 'materialization-one', contentSha256: 'd'.repeat(64) } : null,
        baseCommit: hasMaterialization ? { identity: 'base-one', contentSha256: 'e'.repeat(64) } : null,
        contentSha256: checkpointDigest
    };
}

describe('exact recovery checkpoint display, without recovery admission', () =>
{
    it('displays supplied server/local/base references without claiming current artifacts', () =>
    {
        const document = {
            ...journal(),
            localMaterialization: { identity: 'materialization-one', contentSha256: 'd'.repeat(64) },
            baseCommit: { identity: 'base-one', contentSha256: 'e'.repeat(64) }
        };
        const wrapper = mount(VaultRecoveryCheckpointDetail, { props: { journal: document, expected } });
        expect(wrapper.find('details').attributes('open')).toBeUndefined();
        expect(wrapper.find('[role="status"]').text()).toContain('当前坐标、checkpoint 历史与本地物化验证尚不可用');
        expect(wrapper.text()).toContain('server-result-one');
        expect(wrapper.text()).toContain(artifactDigest);
        expect(wrapper.text()).toContain('materialization-one');
        expect(wrapper.text()).toContain('d'.repeat(64));
        expect(wrapper.text()).toContain('base-one');
        expect(wrapper.text()).toContain('e'.repeat(64));
        expect(wrapper.text()).toContain(resolutionPlanDigest);
        expect(wrapper.findAll('button')).toHaveLength(0);
        expect(wrapper.findAll('a')).toHaveLength(0);
        expect(wrapper.emitted()).toEqual({});
        wrapper.unmount();
    });

    it.each(['siteIdentity', 'vaultIdentity', 'deviceIdentity', 'resolutionOperationIdentity', 'planSha256', 'contentSha256'] as const)(
        'hides every recorded detail for crossed %s', (field) =>
        {
            const crossed = { ...journal(), [field]: field.endsWith('Sha256') ? 'f'.repeat(64) : 'another-scope' };
            const wrapper = mount(VaultRecoveryCheckpointDetail, { props: { journal: crossed, expected } });
            expect(wrapper.find('[role="alert"]').exists()).toBe(true);
            expect(wrapper.findAll('dl')).toHaveLength(0);
            expect(wrapper.text()).not.toContain('server-result-one');
            expect(wrapper.text()).not.toContain(artifactDigest);
            expect(wrapper.text()).not.toContain('another-scope');
            expect(presentVaultRecoveryCheckpoint(crossed, expected)).toBeNull();
            wrapper.unmount();
        }
    );

    it.each(['recovery-required', 'complete', 'recovered', 'rolled-forward'] as const)(
        'keeps current/history/materialization unavailable for recorded %s', (state) =>
        {
            const wrapper = mount(VaultRecoveryCheckpointDetail, { props: { journal: journal(state), expected } });
            expect(wrapper.find('[role="status"]').text()).toContain('同步状态未知');
            expect(wrapper.text()).toContain(`${state} / 4`);
            expect(wrapper.text()).toContain('不证明当前同步已完成');
            expect(wrapper.text()).toContain('恢复、roll-forward 与 undo 命令尚不可用');
            expect(wrapper.findAll('button')).toHaveLength(0);
            wrapper.unmount();
        }
    );

    it('refuses another checkpoint tip and the original sync-plan digest', () =>
    {
        expect(presentVaultRecoveryCheckpoint(journal(), {
            ...expected, checkpoint: { ...expected.checkpoint, identity: 'resolution-one-checkpoint-5' }
        })).toBeNull();
        expect(presentVaultRecoveryCheckpoint(journal(), {
            ...expected, checkpoint: { ...expected.checkpoint, contentSha256: artifactDigest }
        })).toBeNull();
        expect(presentVaultRecoveryCheckpoint(journal(), {
            ...expected, planSha256: artifactDigest
        })).toBeNull();
    });

    it('shows only unavailability when the selected record is missing', () =>
    {
        const wrapper = mount(VaultRecoveryCheckpointDetail, { props: { journal: null, expected } });
        expect(wrapper.text()).toContain('指定 checkpoint 记录尚不可用');
        expect(wrapper.findAll('dl')).toHaveLength(0);
        expect(wrapper.findAll('button')).toHaveLength(0);
        wrapper.unmount();
    });

    it('removes previously visible details when the active display scope changes', async () =>
    {
        const wrapper = mount(VaultRecoveryCheckpointDetail, { props: { journal: journal(), expected } });
        expect(wrapper.text()).toContain('server-result-one');
        await wrapper.setProps({ expected: { ...expected, vaultIdentity: 'vault-two' } });
        expect(wrapper.find('[role="alert"]').exists()).toBe(true);
        expect(wrapper.findAll('dl')).toHaveLength(0);
        expect(wrapper.text()).not.toContain('server-result-one');
        expect(wrapper.text()).not.toContain(checkpointDigest);
        wrapper.unmount();
    });

    it('refuses unknown states, invalid sequence and malformed artifact references', () =>
    {
        expect(presentVaultRecoveryCheckpoint({ ...journal(), state: 'synced' as never }, expected)).toBeNull();
        expect(presentVaultRecoveryCheckpoint({ ...journal(), sequence: -1 }, expected)).toBeNull();
        expect(presentVaultRecoveryCheckpoint({
            ...journal(), serverResult: { identity: 'server-result-one', contentSha256: 'invalid-digest' }
        }, expected)).toBeNull();
    });
});
