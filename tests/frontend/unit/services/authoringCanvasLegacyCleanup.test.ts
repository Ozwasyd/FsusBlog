import { describe, expect, it } from 'vitest';
import {
    authoringCanvasLegacyAuditor
} from '@/services/authoringCanvasLegacyCleanup';

describe('Authoring Canvas Legacy Cleanup & Denial Verifier (#2493)', () => {
    it('verifies absence of legacy storage, arbitrary nodes, graph reuse, and auto relation writes', () => {
        const audit = authoringCanvasLegacyAuditor.scanRuntimeState();

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
