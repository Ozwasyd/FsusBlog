import { describe, expect, it } from 'vitest';
import {
    AuthoringCanvasLegacyAuditor
} from '@/services/authoringCanvasLegacyCleanup';

describe('Authoring Canvas Legacy Cleanup & Denial Verifier (#2493)', () => {
    it('verifies absence of legacy storage, arbitrary nodes, graph reuse, and auto relation writes', async () => {
        // An explicit observer double verifies aggregation only; this is not runtime residue evidence.
        const auditor = new AuthoringCanvasLegacyAuditor({ async observe() { return [
            { target: 'test/localStorage', category: 'storage', status: 'clean', description: 'Test observer input' },
            { target: 'test/document-storage', category: 'storage', status: 'clean', description: 'Test observer input' },
            { target: 'test/closed-nodes', category: 'nodes', status: 'clean', description: 'Test observer input' },
            { target: 'test/references', category: 'references', status: 'clean', description: 'Test observer input' },
            { target: 'test/graph', category: 'graph_isolation', status: 'clean', description: 'Test observer input' },
            { target: 'test/relations', category: 'relation_writes', status: 'clean', description: 'Test observer input' }
        ]; } });
        const audit = await auditor.scanRuntimeState();

        expect(audit.passed).toBe(true);
        expect(audit.activeResidueCount).toBe(0);
        expect(audit.inventory.length).toBeGreaterThanOrEqual(6);

        const storageCheck = audit.inventory.find((i) => i.target.includes('localStorage'));
        expect(storageCheck?.status).toBe('clean');

        const arbitraryNodesCheck = audit.inventory.find((i) => i.category === 'nodes');
        expect(arbitraryNodesCheck?.status).toBe('clean');

        const relationCheck = audit.inventory.find((i) => i.category === 'relation_writes');
        expect(relationCheck?.status).toBe('clean');
    });
});

describe('Authoring Canvas observation refusal controls', () => {
    it('refuses absent observations instead of treating them as clean', async () => {
        const auditor = new AuthoringCanvasLegacyAuditor({ async observe() { return []; } });
        const audit = await auditor.scanRuntimeState();
        expect(audit.passed).toBe(false);
        expect(audit.activeResidueCount).toBe(5);
        expect(audit.inventory.every(item => item.status === 'unknown')).toBe(true);
    });
    it('retains an observed blocked resource and the missing category refusals', async () => {
        const auditor = new AuthoringCanvasLegacyAuditor({ async observe() { return [{ target: 'test/storage', category: 'storage', status: 'blocked', description: 'Observed test refusal' }]; } });
        const audit = await auditor.scanRuntimeState();
        expect(audit.passed).toBe(false);
        expect(audit.activeResidueCount).toBe(5);
        expect(audit.inventory[0].status).toBe('blocked');
    });
});
