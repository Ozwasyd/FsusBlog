// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import OpsHealthWorkbench from '@/components/admin/OpsHealthWorkbench.vue'
import type {
    AdminServiceStatusResponse,
    BackupArtifactResponse,
    OpsHealthResponse,
    RecentOpsErrorResponse
} from '@/api/authoring'

const checkedAt = '2026-07-24T08:30:00.000Z'

const service = (
    key: string,
    status = 'ready'
): AdminServiceStatusResponse => ({
    key,
    label: key,
    status,
    detail: `${key} detail`,
    updatedAt: checkedAt,
    metrics: []
})

const artifact = (
    kind: string,
    status: string,
    detail: string | null,
    path: string | null = null
): BackupArtifactResponse => ({
    kind,
    status,
    detail,
    path,
    updatedAt: checkedAt,
    sizeBytes: null
})

const error = (
    action: string,
    severity: string,
    occurredAt: string,
    detail = `${action} detail`
): RecentOpsErrorResponse => ({
    action,
    severity,
    occurredAt,
    detail,
    message: `${action} message`,
    count: 1
})

const health = (override: Partial<OpsHealthResponse> = {}): OpsHealthResponse => ({
    status: 'ready',
    checkedAt,
    environment: 'Production',
    releaseIdentity: {
        releaseId: 'local-unversioned',
        commitSha: 'local',
        releaseSlot: 'local'
    },
    services: [service('postgres'), service('redis')],
    workers: [service('scheduled-publish')],
    queueBacklog: {
        articleMutationPending: 0,
        articleMutationFailed: 0,
        auditQueued: 0,
        auditDropped: 0
    },
    backup: {
        status: 'ready',
        checkedAt,
        backupRoot: '/srv/fsusblog/backups',
        artifacts: [artifact('database', 'ready', 'latest')],
        restoreDrillCommand: 'restore drill',
        restoreCommand: 'restore'
    },
    recentErrors: [],
    ...override
})

describe('OpsHealthWorkbench', () => {
    it('keeps healthy and optional missing states in one collapsed quiet summary', () => {
        const wrapper = mount(OpsHealthWorkbench, {
            props: {
                health: health({
                    backup: {
                        ...health().backup,
                        artifacts: [
                            artifact('database', 'ready', 'latest'),
                            artifact('restore-drill', 'missing', 'not_run')
                        ]
                    }
                }),
                loading: false
            }
        })

        expect(wrapper.findAll('[data-ops-incident-row]')).toHaveLength(0)
        expect(wrapper.text()).toContain('3 个服务正常 · 1 项可选状态未提供')
        expect(wrapper.find('[data-ops-healthy-summary] details').attributes('open')).toBeUndefined()
        expect(wrapper.findAll('.el-tag')).toHaveLength(0)
    })

    it('sorts incidents by severity and then newest occurrence', () => {
        const wrapper = mount(OpsHealthWorkbench, {
            props: {
                health: health({
                    recentErrors: [
                        error('warning-new', 'warning', '2026-07-24T08:29:00.000Z'),
                        error('critical-old', 'critical', '2026-07-24T08:20:00.000Z'),
                        error('critical-new', 'critical', '2026-07-24T08:28:00.000Z'),
                        error('error-newest', 'error', '2026-07-24T08:30:00.000Z')
                    ]
                }),
                loading: false
            }
        })

        const rows = wrapper.findAll('[data-ops-incident-row]')
        expect(rows.map(row => row.find('h3').text())).toEqual([
            'critical-new',
            'critical-old',
            'error-newest',
            'warning-new'
        ])
        expect(rows.map(row => row.find('[data-ops-severity]').text())).toEqual([
            '!严重',
            '!严重',
            '!错误',
            '△警告'
        ])
    })

    it('truncates a long path until keyboard disclosure and copies full evidence', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined)
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText }
        })
        const path = '/srv/fsusblog/releases/production/data/artifacts/restore/manifest.json'
        const wrapper = mount(OpsHealthWorkbench, {
            props: {
                health: health({
                    backup: {
                        ...health().backup,
                        status: 'failed',
                        artifacts: [artifact('database', 'failed', 'checksum failed', path)]
                    }
                }),
                loading: false
            }
        })

        expect(wrapper.find('[data-ops-evidence-path]').text()).toBe('/srv/…/manifest.json')
        const disclosure = wrapper.find('[data-ops-evidence-disclosure]')
        await disclosure.trigger('click')
        expect(disclosure.attributes('aria-expanded')).toBe('true')
        expect(wrapper.find('[data-ops-evidence-path]').text()).toBe(path)

        await wrapper.get('button[aria-label="复制证据"]').trigger('click')
        expect(writeText).toHaveBeenCalledWith(expect.stringContaining(path))
        expect(wrapper.get('[role="status"]').text()).toBe('证据已复制')
    })
})
