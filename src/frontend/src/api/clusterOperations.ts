import { runPrivateRequest } from '@/services/privateRequestRuntime';
import { appErrorFromStatus } from '@/utils/appError';

import type { ApiRequestConfig } from './requestConfig';

const ENDPOINT = '/api/ops/cluster/nodes';

export interface ClusterHealthResponse {
    status: 'healthy' | 'degraded' | 'unhealthy';
    code: string;
    aliveNodes: number;
    suspectNodes: number;
    deadNodes: number;
    drainingNodes: number;
    maintenanceNodes: number;
    unassignedResponsibilities: number;
}

export interface ClusterNodeResourcesResponse {
    cpuUsagePercent: number;
    memoryPressurePercent: number;
    managedHeapBytes: number;
    queueLength: number;
    p95LatencyMilliseconds: number;
    p99LatencyMilliseconds: number;
    recentErrorRate: number;
    ioPressurePercent: number;
    networkReachable: boolean;
    activeLeaseCount: number;
}

export interface ClusterNodeResponse {
    nodeId: string;
    instanceId: string;
    version: string;
    startedAt: string;
    mode: string;
    capabilities: string[];
    status: 'alive' | 'suspect' | 'dead' | 'draining' | 'maintenance';
    lastHeartbeatAt: string;
    resources: ClusterNodeResourcesResponse;
    activeResponsibilities: string[];
}

export interface ClusterAssignmentResponse {
    responsibilityId: string;
    capability: string;
    replica: number;
    nodeId: string;
    assignedAt: string;
    placementScore: number;
    reason: string;
    fencingToken: number | null;
    state: 'active' | 'activating' | 'deactivating' | 'migrating' | 'failed' | 'waitingLease';
}

export interface ClusterSchedulerResponse {
    generation: number;
    observedAt: string;
    mode: string;
    enabled: boolean;
    assignments: ClusterAssignmentResponse[];
    unassigned: string[];
}

export interface ClusterLeaseResponse {
    key: string;
    responsibility: string;
    resource: string;
    leaseId: string;
    holderNodeId: string;
    fencingToken: number;
    ttlMilliseconds: number;
    lastRenewedAt: string;
    expiresAt: string;
}

export interface ClusterCheckpointResponse {
    version: number;
    payloadBytes: number;
    payloadSha256: string;
    updatedAt: string;
}

export interface ClusterTaskResponse {
    key: string;
    leaseKey: string;
    status: string;
    attempt: number;
    writerNodeId: string;
    fencingToken: number;
    checkpoint: ClusterCheckpointResponse | null;
    lastError: string | null;
    updatedAt: string;
}

export interface ClusterEventResponse {
    sequence: number;
    observedAt: string;
    kind: string;
    state: string;
    reason: string;
    nodeId: string | null;
    responsibilityId: string | null;
    sourceNodeId: string | null;
    targetNodeId: string | null;
    traceId: string | null;
}

export interface ClusterMetricResponse {
    nodesAlive: number;
    nodesSuspect: number;
    schedulerAssignments: number;
    schedulerRebalances: number;
    leaseAcquireSuccess: number;
    leaseAcquireFailure: number;
    leaseRenewFailure: number;
    responsibilityMigrations: number;
    responsibilityFailures: number;
}

export interface ClusterOperationsResponse {
    enabled: boolean;
    mode: string;
    currentNodeId: string;
    schedulingAllowed: boolean;
    health: ClusterHealthResponse;
    nodes: ClusterNodeResponse[];
    scheduler: ClusterSchedulerResponse;
    leases: ClusterLeaseResponse[];
    tasks: ClusterTaskResponse[];
    events: ClusterEventResponse[];
    metrics: ClusterMetricResponse;
}

export async function getClusterOperations(
    config?: ApiRequestConfig
): Promise<ClusterOperationsResponse>
{
    return await runPrivateRequest('admin', config?.signal, async (signal) =>
    {
        const response = await fetch(ENDPOINT, {
            method: 'GET',
            credentials: 'include',
            cache: 'no-store',
            signal,
            headers: {
                Accept: 'application/json'
            }
        });
        if (!response.ok)
        {
            const text = await response.text();
            throw appErrorFromStatus(response.status, text || `HTTP ${response.status}`);
        }
        return await response.json() as ClusterOperationsResponse;
    });
}
