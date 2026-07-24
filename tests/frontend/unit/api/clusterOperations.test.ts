import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    getClusterOperations,
    type ClusterOperationsResponse
} from '@/api/clusterOperations';
import { privateRequestRuntime } from '@/services/privateRequestRuntime';

const fetchMock = vi.fn<typeof fetch>();

const response = (): ClusterOperationsResponse => ({
    enabled: true,
    mode: 'adaptive',
    currentNodeId: 'node-a',
    schedulingAllowed: true,
    health: {
        status: 'healthy',
        code: 'cluster_ready',
        aliveNodes: 1,
        suspectNodes: 0,
        deadNodes: 0,
        drainingNodes: 0,
        maintenanceNodes: 0,
        unassignedResponsibilities: 0
    },
    nodes: [],
    scheduler: {
        generation: 3,
        observedAt: '2026-07-24T08:00:00.000Z',
        mode: 'adaptive',
        enabled: true,
        assignments: [],
        unassigned: []
    },
    leases: [],
    tasks: [],
    events: [],
    metrics: {
        nodesAlive: 1,
        nodesSuspect: 0,
        schedulerAssignments: 7,
        schedulerRebalances: 0,
        leaseAcquireSuccess: 7,
        leaseAcquireFailure: 0,
        leaseRenewFailure: 0,
        responsibilityMigrations: 0,
        responsibilityFailures: 0
    }
});

beforeEach(() =>
{
    privateRequestRuntime.resetForTests();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() =>
{
    vi.unstubAllGlobals();
});

describe('cluster operations API', () =>
{
    it('uses the admin private generation and no-store JSON endpoint', async () =>
    {
        fetchMock.mockResolvedValue(new Response(JSON.stringify(response()), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        }));

        await expect(getClusterOperations()).resolves.toMatchObject({
            mode: 'adaptive',
            currentNodeId: 'node-a'
        });
        expect(fetchMock).toHaveBeenCalledWith(
            '/api/ops/cluster/nodes',
            expect.objectContaining({
                cache: 'no-store',
                credentials: 'include',
                method: 'GET'
            })
        );
    });

    it('rejects a stale response after the admin generation changes', async () =>
    {
        let resolveResponse!: (value: Response) => void;
        fetchMock.mockReturnValue(new Promise(resolve =>
        {
            resolveResponse = resolve;
        }));

        const pending = getClusterOperations();
        privateRequestRuntime.advance('admin');
        resolveResponse(new Response(JSON.stringify(response()), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        }));

        await expect(pending).rejects.toMatchObject({
            name: 'AbortError',
            scope: 'admin'
        });
    });
});
