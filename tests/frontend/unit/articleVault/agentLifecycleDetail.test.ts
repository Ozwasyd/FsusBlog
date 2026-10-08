// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import VaultAgentLifecycleDetail from '@/components/admin/article/vault/VaultAgentLifecycleDetail.vue';
import VaultStatusUnavailable from '@/components/admin/article/vault/VaultStatusUnavailable.vue';
import {
    presentVaultAgentLifecycle,
    type VaultAgentLifecycleReport,
    type VaultAgentLifecycleState
} from '@/services/articleVault/agentLifecyclePresentation';
import type { VaultAgentLeaseScope } from '@/services/articleVault/agentLeasePresentation';

const scope: VaultAgentLeaseScope = {
    siteIdentity: 'site-fixture', vaultIdentity: 'vault-fixture', deviceIdentity: 'device-fixture',
    agentInstanceIdentity: 'agent-fixture', userSessionIdentity: 'session-secret',
    rootSha256: 'a'.repeat(64), binarySha256: 'b'.repeat(64), agentVersion: '1.2.3', protocolVersion: 1
};
// Display fixture only; no producer, current receipt chain or native capability is asserted.
const report: VaultAgentLifecycleReport = {
    schema: 'fsusblog.article-vault.agent-lifecycle.v1', binding: scope, platform: 'linux',
    previousState: 'updating', newState: 'rollback-required', sequence: 4, observedUnixMilliseconds: 1234,
    rescanRequired: true, leaseGeneration: null, leaseReceiptSha256: null, ipcReceiptSha256: null,
    retainedBinarySha256: scope.binarySha256, candidateBinarySha256: 'c'.repeat(64), recovery: null,
    producerReceiptSha256: 'd'.repeat(64), reasonCode: 'update_failed_rollback_required',
    previousReceiptSha256: 'e'.repeat(64), contentSha256: 'f'.repeat(64)
};

describe('closed lifecycle receipt display (#2134, source c962b70)', () => {
    it.each(Object.keys(scope) as (keyof VaultAgentLeaseScope)[])('isolates crossed %s without leaking details', (field) => {
        const expectedScope = { ...scope, [field]: field === 'protocolVersion' ? 2 : `${scope[field]}-crossed` };
        expect(presentVaultAgentLifecycle(report, expectedScope)).toEqual({ availability: 'scope-mismatch', rows: [] });
    });

    it.each(['installed', 'starting', 'running', 'stopping', 'stopped', 'updating', 'rollback-required',
        'crashed', 'reconnecting', 'unlinking', 'removed', 'retained-control-state'] as const)('displays %s without current or command qualification', (newState) => {
        const wrapper = mount(VaultAgentLifecycleDetail, { props: { report: { ...report, newState }, expectedScope: scope } });
        expect(wrapper.get('dl').text()).toContain(newState);
        expect(wrapper.text()).toContain('状态与回执链尚未验证');
        expect(wrapper.text()).toContain('原生 rescan 验证与同步状态未知');
        expect(wrapper.text()).toContain('命令当前不可用');
        expect(wrapper.findAll('button, input, a')).toHaveLength(0);
        expect(wrapper.emitted()).toEqual({});
        wrapper.unmount();
    });

    it('keeps failed-update retained and candidate binary identities distinct', () => {
        const projection = presentVaultAgentLifecycle(report, scope);
        expect(projection.rows.find(row => row.label === '保留 binary SHA-256')?.value).toBe(scope.binarySha256);
        expect(projection.rows.find(row => row.label === '候选 binary SHA-256')?.value).toBe(report.candidateBinarySha256);
        expect(projection.rows.find(row => row.label === '报告原因')?.value).toBe('update_failed_rollback_required');
    });

    it('displays durable recovery references and false rescan flag without asserting native verification', () => {
        const recovery = {
            rootManifestSha256: '1'.repeat(64), sourceTreeSha256: '2'.repeat(64), watcherWatermarkSha256: '3'.repeat(64),
            rescanReceiptSha256: '4'.repeat(64), operationReceiptsSha256: '5'.repeat(64)
        };
        const running: VaultAgentLifecycleReport = {
            ...report, newState: 'running', rescanRequired: false, recovery,
            candidateBinarySha256: null, leaseGeneration: 7, leaseReceiptSha256: '6'.repeat(64), ipcReceiptSha256: '7'.repeat(64)
        };
        const projection = presentVaultAgentLifecycle(running, scope);
        expect(projection.rows.find(row => row.label === '报告要求 rescan')?.value).toContain('不证明 rescan 已通过原生验证');
        for (const digest of Object.values(recovery)) expect(projection.rows.some(row => row.value === digest)).toBe(true);
        expect(projection.rows.find(row => row.label === 'Lifecycle receipt SHA-256（尚未验证）')?.value).toBe(report.contentSha256);
        expect(presentVaultAgentLifecycle({ ...running, recovery: { ...recovery, rescanReceiptSha256: '/private-path' } }, scope).rows).toEqual([]);
    });

    it.each(['linux', 'windows', 'mac-os'] as const)('preserves canonical kebab-case platform %s without platform acceptance', (platform) => {
        expect(presentVaultAgentLifecycle({ ...report, platform }, scope).rows[0]).toEqual({ label: '报告平台（非平台资格）', value: platform });
    });

    it('rejects unsafe display shapes, unknown and noncanonical enums, not using a caller verified flag', () => {
        const invalid = [
            { ...report, newState: 'Running' as VaultAgentLifecycleState },
            { ...report, newState: 'unknown-state' as VaultAgentLifecycleState },
            { ...report, sequence: Number.MAX_SAFE_INTEGER + 1 },
            { ...report, reasonCode: '/private-path' },
            { ...report, candidateBinarySha256: 'unsafe-digest' },
            { ...report, schema: 'unknown-schema' }
        ];
        for (const value of invalid) expect(presentVaultAgentLifecycle(value as VaultAgentLifecycleReport, scope).rows).toEqual([]);
        const display = presentVaultAgentLifecycle({ ...report, verified: true, token: 'token-secret', source: 'source-secret' } as VaultAgentLifecycleReport, scope);
        expect(display.availability).toBe('reported');
        expect(JSON.stringify(display)).not.toMatch(/token-secret|source-secret|session-secret/u);
        expect(presentVaultAgentLifecycle(null, scope).rows).toEqual([]);
        expect(presentVaultAgentLifecycle(report, null).rows).toEqual([]);
    });

    it('keeps supplied lifecycle data within the same unknown status owner and suppresses a new session', async () => {
        const wrapper = mount(VaultStatusUnavailable, { props: { lifecycleReport: report, lifecycleScope: scope } });
        expect(wrapper.get('summary').text()).toBe('Vault：状态未知');
        expect(wrapper.text()).toContain('rollback-required');
        expect(wrapper.text()).not.toContain(scope.userSessionIdentity);
        await wrapper.setProps({ lifecycleScope: { ...scope, userSessionIdentity: 'new-session-secret' } });
        expect(wrapper.text()).toContain('Lifecycle 报告范围不一致');
        expect(wrapper.find('dl').exists()).toBe(false);
        expect(wrapper.text()).not.toContain(scope.binarySha256);
        expect(wrapper.text()).not.toContain('new-session-secret');
        expect(wrapper.get('summary').text()).toBe('Vault：状态未知');
        expect(wrapper.findAll('button')).toHaveLength(0);
        wrapper.unmount();
    });
});
