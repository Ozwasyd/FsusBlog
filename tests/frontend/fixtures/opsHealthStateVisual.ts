import { createApp, nextTick } from 'vue'

import '@fsusblog/fsusui-base-style.scss'
import '@ozwasyd/element-plus/dist/el-fsus-theme.css'
import '@/assets/main.css'
import { encodeAedsFrame } from '@/api/binaryFrame'
import type { OpsHealthResponse } from '@/api/authoring'
import { FrameType } from '@wasm/protocol/frame'

type FixtureState = 'initial-loading' | 'failure' | 'retry-loading' | 'retry-failure' | 'retry-success'
type FixtureTheme = 'light' | 'dark'
type FixtureMode = 'default' | 'zoom-200' | 'forced-colors'

const params = new URL(window.location.href).searchParams
const fixtureState = (params.get('state') ?? 'failure') as FixtureState
const theme = (params.get('theme') === 'dark' ? 'dark' : 'light') as FixtureTheme
const mode = (params.get('mode') ?? 'default') as FixtureMode
const originalFetch = window.fetch.bind(window)
const encoder = new TextEncoder()
const health: OpsHealthResponse = {
    status: 'ready',
    checkedAt: '2026-08-05T08:00:00.000Z',
    environment: 'Production',
    releaseIdentity: {
        releaseId: '20260805-0800-contract',
        commitSha: '0123456789abcdef0123456789abcdef01234567',
        releaseSlot: 'blue'
    },
    services: [],
    workers: [],
    queueBacklog: {
        articleMutationPending: 0,
        articleMutationFailed: 0,
        auditQueued: 0,
        auditDropped: 0
    },
    backup: {
        status: 'ready',
        checkedAt: '2026-08-05T08:00:00.000Z',
        backupRoot: '/srv/fsusblog/backups',
        artifacts: [],
        restoreDrillCommand: 'fsus restore drill',
        restoreCommand: 'fsus restore latest'
    },
    recentErrors: []
}

document.documentElement.classList.toggle('dark', theme === 'dark')
document.documentElement.dataset.themeMode = theme
document.documentElement.dataset.themeResolved = theme
document.documentElement.dataset.opsHealthFixtureState = fixtureState
document.documentElement.dataset.opsHealthFixtureMode = mode
document.documentElement.dataset.opsHealthAssertiveAnnouncementCount = '0'
document.documentElement.dataset.opsHealthToastCount = '0'
document.body.className = 'account-shell admin-workspace-frame'
if (mode === 'zoom-200') {
    document.documentElement.style.zoom = '2'
}

function healthResponse(): Response {
    const frame = encodeAedsFrame(FrameType.OpsHealth, encoder.encode(JSON.stringify(health)))
    return new Response(frame, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' }
    })
}

function pendingResponse(signal?: AbortSignal | null): Promise<Response> {
    return new Promise((_resolve, reject) => {
        signal?.addEventListener(
            'abort',
            () => {
                reject(new DOMException('The operation was aborted.', 'AbortError'))
            },
            { once: true }
        )
    })
}

let opsRequestCount = 0
let assertiveAnnouncementCount = 0
let toastCount = 0
const recountAnnouncements = () => {
    // Toast auto-dismisses; keep peak counts so slow mount cannot miss evidence.
    const liveAssertive = document.querySelectorAll('[aria-live="assertive"]').length
    const liveToast = document.querySelectorAll('.el-message, .fsusblog-motion-toast').length
    assertiveAnnouncementCount = Math.max(assertiveAnnouncementCount, liveAssertive)
    toastCount = Math.max(toastCount, liveToast)
    document.documentElement.dataset.opsHealthAssertiveAnnouncementCount = String(assertiveAnnouncementCount)
    document.documentElement.dataset.opsHealthToastCount = String(toastCount)
}
const announcementObserver = new MutationObserver(() => {
    recountAnnouncements()
})
announcementObserver.observe(document.documentElement, { childList: true, subtree: true })

window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    // Authoring health is the sole product path under test; all other binary
    // traffic is rejected so the fixture cannot accidentally depend on a live
    // backend or hang on PoW / auth bootstrap endpoints.
    if (!url.includes('/api/binary/author/ops/health')) {
        if (url.includes('/api/binary/')) {
            throw new TypeError('Failed to fetch')
        }
        return originalFetch(input, init)
    }

    opsRequestCount += 1
    document.documentElement.dataset.opsHealthRequestCount = String(opsRequestCount)

    if (fixtureState === 'initial-loading') {
        return pendingResponse(init?.signal)
    }
    if (fixtureState === 'failure') {
        throw new TypeError('fixture upstream unavailable')
    }
    if (opsRequestCount === 1) {
        throw new TypeError('fixture initial request failed')
    }
    if (fixtureState === 'retry-loading') {
        return pendingResponse(init?.signal)
    }
    if (fixtureState === 'retry-failure') {
        throw new TypeError('fixture retry request failed')
    }
    return healthResponse()
}

const fixtureHost = document.getElementById('ops-health-state-fixture')
if (!fixtureHost) {
    throw new Error('ops_health_state_fixture_host_missing')
}
fixtureHost.style.width = 'min(calc(100% - 2rem), 76rem)'
fixtureHost.style.margin = '1.5rem auto'

const { default: OpsHealth } = await import('@/views/admin/OpsHealth.vue')
const app = createApp(OpsHealth)
app.mount(fixtureHost)
await nextTick()

if (
    fixtureState === 'failure' ||
    fixtureState === 'retry-loading' ||
    fixtureState === 'retry-failure' ||
    fixtureState === 'retry-success'
) {
    await waitFor(() => Boolean(document.querySelector('[data-ops-health-retry]')))
}
if (fixtureState === 'retry-loading' || fixtureState === 'retry-failure' || fixtureState === 'retry-success') {
    const retry = document.querySelector<HTMLButtonElement>('[data-ops-health-retry]')
    retry?.click()
}
if (fixtureState === 'retry-success') {
    await waitFor(() => Boolean(document.querySelector('[data-ops-health-workbench]')))
}
// Poll peaks continuously so auto-dismissed toasts remain counted.
if (fixtureState === 'failure' || fixtureState === 'retry-loading' || fixtureState === 'retry-success') {
    await waitFor(() => {
        recountAnnouncements()
        return assertiveAnnouncementCount >= 1 && toastCount >= 1
    })
}
if (fixtureState === 'retry-failure') {
    await waitFor(() => {
        recountAnnouncements()
        return assertiveAnnouncementCount >= 2 && toastCount >= 2
    })
}

document.documentElement.dataset.opsHealthFixtureReady = 'true'

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = performance.now() + 15000
    while (!predicate()) {
        if (performance.now() > deadline) {
            throw new Error(
                `ops_health_state_fixture_timeout state=${fixtureState} assertive=${assertiveAnnouncementCount} toast=${toastCount} requests=${opsRequestCount}`
            )
        }
        await new Promise((resolve) => window.setTimeout(resolve, 16))
    }
}
