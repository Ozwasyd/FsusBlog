import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FrameType } from '@wasm/protocol/frame';
import {
    getClusterOperations,
    setClusterNodeState,
    setClusterSchedulerState,
    releaseExpiredClusterLease,
    type ClusterOperationsResponse
} from '@/api/clusterOperations';
import { requestBinaryOnly } from '@/composition/binaryTransport';

vi.mock('@/composition/binaryTransport', () => ({
    requestBinaryOnly: vi.fn()
}));

const binaryMock = vi.mocked(requestBinaryOnly);

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

describe('cluster operations API AEDS binary transport', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('getClusterOperations issues binary GET request with ClusterRuntimeSnapshot frame type', async () => {
        binaryMock.mockResolvedValue(response());

        await expect(getClusterOperations()).resolves.toMatchObject({
            mode: 'adaptive',
            currentNodeId: 'node-a'
        });
        expect(binaryMock).toHaveBeenCalledWith(
            expect.objectContaining({
                binaryUrl: '/api/binary/author/ops/cluster/nodes',
                privateScope: 'admin',
                frameType: FrameType.ClusterRuntimeSnapshot
            })
        );
    });

    it('setClusterNodeState issues binary POST request with ClusterNodeStateRequest frame type', async () => {
        binaryMock.mockResolvedValue({ nodeId: 'node-a', status: 'draining' });

        await expect(setClusterNodeState('node-a', 'draining', 'maintenance')).resolves.toEqual({
            nodeId: 'node-a',
            status: 'draining'
        });
        expect(binaryMock).toHaveBeenCalledWith(
            expect.objectContaining({
                binaryUrl: '/api/binary/author/ops/cluster/nodes/node-a/state',
                privateScope: 'admin',
                frameType: FrameType.ClusterRuntimeSnapshot
            })
        );
    });

    it('setClusterSchedulerState issues binary POST request with ClusterSchedulerStateRequest frame type', async () => {
        binaryMock.mockResolvedValue({ schedulingAllowed: false });

        await expect(setClusterSchedulerState(false, 'pause')).resolves.toEqual({
            schedulingAllowed: false
        });
        expect(binaryMock).toHaveBeenCalledWith(
            expect.objectContaining({
                binaryUrl: '/api/binary/author/ops/cluster/scheduler',
                privateScope: 'admin',
                frameType: FrameType.ClusterRuntimeSnapshot
            })
        );
    });

    it('releaseExpiredClusterLease issues binary POST request with ClusterLeaseReleaseRequest frame type', async () => {
        binaryMock.mockResolvedValue({ released: true });

        await expect(releaseExpiredClusterLease('00000000000000000000000000000001', 'cleanup')).resolves.toEqual({
            released: true
        });
        expect(binaryMock).toHaveBeenCalledWith(
            expect.objectContaining({
                binaryUrl: '/api/binary/author/ops/cluster/leases/00000000000000000000000000000001/release-expired',
                privateScope: 'admin',
                frameType: FrameType.ClusterRuntimeSnapshot
            })
        );
    });
});
