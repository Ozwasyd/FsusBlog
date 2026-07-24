// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClusterOperationsResponse } from '@/api/clusterOperations';

const mocks = vi.hoisted(() => ({
    getClusterOperations: vi.fn(),
    showErrorToast: vi.fn()
}));

vi.mock('@/api/clusterOperations', () => ({
    getClusterOperations: mocks.getClusterOperations
}));

vi.mock('@/utils/errorPresentation', () => ({
    showErrorToast: mocks.showErrorToast
}));

import ClusterRuntime from '@/views/admin/ClusterRuntime.vue';

const SectionStub = defineComponent({
    props: { title: { type: String, default: '' } },
    setup(props, { slots })
    {
        return () => h('section', [
            h('h2', props.title),
            slots.actions?.(),
            slots.default?.()
        ]);
    }
});

const TableStub = defineComponent({
    props: {
        data: { type: Array, default: () => [] }
    },
    setup(props, { slots })
    {
        return () => h('div', { class: 'table-stub' }, [
            JSON.stringify(props.data),
            props.data.length === 0 ? slots.empty?.() : slots.default?.()
        ]);
    }
});

const EmptyStateStub = defineComponent({
    props: {
        title: { type: String, default: '' },
        content: { type: String, default: '' }
    },
    setup(props, { slots })
    {
        return () => h('div', { class: 'empty-state-stub' }, [
            props.title,
            props.content,
            slots.actions?.()
        ]);
    }
});

const snapshot = (): ClusterOperationsResponse => ({
    enabled: true,
    mode: 'adaptive',
    currentNodeId: 'node-a',
    schedulingAllowed: true,
    health: {
        status: 'degraded',
        code: 'cluster_attention_required',
        aliveNodes: 2,
        suspectNodes: 1,
        deadNodes: 0,
        drainingNodes: 0,
        maintenanceNodes: 0,
        unassignedResponsibilities: 0
    },
    nodes: [{
        nodeId: 'node-a',
        instanceId: 'instance-a',
        version: '1.3.0',
        startedAt: '2026-07-24T07:00:00.000Z',
        mode: 'adaptive',
        capabilities: ['web.api'],
        status: 'alive',
        lastHeartbeatAt: '2026-07-24T08:00:00.000Z',
        resources: {
            cpuUsagePercent: 12,
            memoryPressurePercent: 24,
            managedHeapBytes: 1024,
            queueLength: 0,
            p95LatencyMilliseconds: 8,
            p99LatencyMilliseconds: 12,
            recentErrorRate: 0,
            ioPressurePercent: 3,
            networkReachable: true,
            activeLeaseCount: 1
        },
        activeResponsibilities: ['web.api']
    }],
    scheduler: {
        generation: 4,
        observedAt: '2026-07-24T08:00:00.000Z',
        mode: 'adaptive',
        enabled: true,
        assignments: [{
            responsibilityId: 'web.api.listener',
            capability: 'web.api',
            replica: 0,
            nodeId: 'node-a',
            assignedAt: '2026-07-24T08:00:00.000Z',
            placementScore: 0.1,
            reason: 'adaptive-load',
            fencingToken: 7,
            state: 'active'
        }],
        unassigned: []
    },
    leases: [{
        key: 'responsibility:web.api.listener.0',
        responsibility: 'responsibility',
        resource: 'web.api.listener.0',
        leaseId: '5810baed49ee4d83a70b291d71cf5873',
        holderNodeId: 'node-a',
        fencingToken: 7,
        ttlMilliseconds: 30000,
        lastRenewedAt: '2026-07-24T08:00:00.000Z',
        expiresAt: '2026-07-24T08:00:30.000Z'
    }],
    tasks: [],
    events: [{
        sequence: 1,
        observedAt: '2026-07-24T08:00:00.000Z',
        kind: 'responsibility-transition',
        state: 'active',
        reason: 'responsibility-lease-acquired',
        nodeId: 'node-a',
        responsibilityId: 'web.api.listener',
        sourceNodeId: null,
        targetNodeId: 'node-a',
        traceId: 'abcdef'
    }],
    metrics: {
        nodesAlive: 2,
        nodesSuspect: 1,
        schedulerAssignments: 1,
        schedulerRebalances: 0,
        leaseAcquireSuccess: 1,
        leaseAcquireFailure: 0,
        leaseRenewFailure: 0,
        responsibilityMigrations: 0,
        responsibilityFailures: 0
    }
});

const mountPage = () => mount(ClusterRuntime, {
    global: {
        directives: {
            loading: () => undefined
        },
        stubs: {
            AdminInlineEmptyState: EmptyStateStub,
            ElButton: true,
            ElTable: TableStub,
            ElTableColumn: true,
            ElTag: true,
            FsusUiKeyValueGrid: defineComponent({
                setup: (_, { slots }) => () => h('div', slots.default?.())
            }),
            FsusUiKeyValueItem: defineComponent({
                props: { label: { type: String, default: '' } },
                setup: (props, { slots }) => () => h('span', [props.label, slots.default?.()])
            }),
            FsusUiSettingsSection: SectionStub,
            FsusUiTaskPageHeader: defineComponent({
                props: { title: { type: String, default: '' } },
                setup: props => () => h('h1', props.title)
            })
        }
    }
});

beforeEach(() =>
{
    vi.clearAllMocks();
    mocks.getClusterOperations.mockResolvedValue(snapshot());
});

describe('ClusterRuntime', () =>
{
    it('renders node, responsibility, lease and lifecycle evidence', async () =>
    {
        const wrapper = mountPage();
        await flushPromises();

        expect(wrapper.text()).toContain('集群与运行时');
        expect(wrapper.text()).toContain('需要关注');
        expect(wrapper.text()).toContain('node-a');
        expect(wrapper.text()).toContain('web.api.listener');
        expect(wrapper.text()).toContain('responsibility-lease-acquired');
        expect(mocks.showErrorToast).not.toHaveBeenCalled();
    });

    it('keeps a retryable empty state when the endpoint is unavailable', async () =>
    {
        const error = new Error('cluster unavailable');
        mocks.getClusterOperations.mockRejectedValueOnce(error);

        const wrapper = mountPage();
        await flushPromises();

        expect(wrapper.text()).toContain('集群状态待加载');
        expect(wrapper.text()).toContain('集群运行状态暂不可用，请重试。');
        expect(mocks.showErrorToast).toHaveBeenCalledWith(error, '集群与运行时加载失败');
    });
});
