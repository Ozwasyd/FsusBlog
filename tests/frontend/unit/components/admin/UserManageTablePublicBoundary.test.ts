// @vitest-environment happy-dom

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
import {
    ElAutoResizer, ElAvatar, ElButton, ElLoading, ElResponsiveCollection,
    ElSkeleton, ElTableV2, TableV2FixedDir
} from '@ozwasyd/element-plus'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Comment, nextTick } from 'vue'
import UserManageTable from '@/components/admin/users/UserManageTable.vue'
import {
    FsusUiTableV2FixedDir,
    type FsusUiTableV2Column
} from '@/fsusui/tableV2'
import type { UserListViewItem } from '@/composables/useAdminUserManage'
import type { Column } from '@ozwasyd/element-plus'

const repositoryRoot = path.resolve(process.cwd(), '../..')
const componentPath = path.join(repositoryRoot, 'src/frontend/src/components/admin/users/UserManageTable.vue')
const ts = createRequire(path.join(repositoryRoot, 'src/frontend/package.json'))('typescript') as typeof import('../../../../../src/frontend/node_modules/typescript')

// Execute the existing rule verbatim, without starting its repository-wide CLI
// or granting this component test authority over the frozen global inventory.
function runtimeImportFindings(content: string): unknown[] {
    const checker = path.join(repositoryRoot, 'tests/frontend/checks/static/check-fsusui-boundary.mjs')
    const source = readFileSync(checker, 'utf8')
    const ast = ts.createSourceFile(checker, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    const names = new Set(['rel', 'isUnder', 'warn', 'checkRuntimeImports'])
    const declarations = ast.statements.filter((statement) =>
        (ts.isFunctionDeclaration(statement) && names.has(statement.name?.text ?? ''))
        || (ts.isVariableStatement(statement) && statement.declarationList.declarations.some((declaration) =>
            ts.isIdentifier(declaration.name) && declaration.name.text === 'allowedRuntimeImports')))
    expect(declarations).toHaveLength(5)
    const warnings: unknown[] = []
    const context = vm.createContext({
        path, repoRoot: repositoryRoot,
        fsusuiRoot: path.join(repositoryRoot, 'src/frontend/src/fsusui'), warnings,
        componentPath, content
    })
    new vm.Script(`${declarations.map((statement) => statement.getText(ast)).join('\n')}\ncheckRuntimeImports(componentPath, content);`).runInContext(context)
    return warnings
}

function account(accountId: number, status: 0 | 1 | 2 = 0): UserListViewItem {
    return Object.freeze({
        accountId, id: accountId + 1000, identityKind: 'anonymous_account', publicHandle: `reader-${accountId}`,
        passkeyInitialized: true, recoveryInitialized: true, privacyInitializedAt: null,
        anonymousCredentialStatus: 'active', riskFlags: 0, status,
        createTime: '2026-10-08T00:00:00Z', deletedAt: status === 2 ? '2026-10-08T00:00:00Z' : null,
        initials: 'RD', displayHandle: `reader-${accountId}`, identityKindLabel: '匿名账号',
        createdAtText: '2026-10-08', privacyInitializedText: '未初始化', credentialSummary: '凭据可用',
        anonymousCredentialText: '可用', riskFlagsText: '无风险标记',
        statusText: status === 0 ? '正常' : status === 1 ? '已封禁' : '已注销',
        statusLabel: status === 0 ? '正常' : status === 1 ? '已封禁' : '已注销',
        statusCode: status === 0 ? 'NORMAL' : status === 1 ? 'BANNED' : 'DELETED',
        statusClass: '', statusDotClass: '', isDeleted: status === 2
    })
}

const resizeObservers: FixtureResizeObserver[] = []
class FixtureResizeObserver implements ResizeObserver {
    readonly targets = new Set<Element>()
    readonly disconnect = vi.fn(() => this.targets.clear())
    private readonly callback: ResizeObserverCallback
    constructor(callback: ResizeObserverCallback) {
        this.callback = callback
        resizeObservers.push(this)
    }
    observe(target: Element) { this.targets.add(target) }
    unobserve(target: Element) { this.targets.delete(target) }
    deliver() {
        const contentRect = new DOMRect(0, 0, 1200, 500)
        const size = [{ inlineSize: 1200, blockSize: 500 }]
        this.callback([...this.targets].map((target) => ({
            target, contentRect, borderBoxSize: size, contentBoxSize: size, devicePixelContentBoxSize: size
        })), this)
    }
}

const cleanups: Array<() => void> = []
const originalResizeObserver = Object.getOwnPropertyDescriptor(window, 'ResizeObserver')
const networkRequest = vi.fn(() => { throw new Error('Network is forbidden in the isolated account component fixture') })
let compact = true
type FixtureMediaListener = EventListenerOrEventListenerObject | ((event: MediaQueryListEvent) => void)
const mediaListeners = new Set<FixtureMediaListener>()
const collectionMediaListeners = new Set<FixtureMediaListener>()

async function settle() {
    await nextTick()
    resizeObservers.forEach((observer) => observer.deliver())
    await nextTick()
    await nextTick()
}

function renderTable(list: readonly UserListViewItem[], loading = false) {
    const toggleStatus = vi.fn<(row: UserListViewItem) => void>()
    const wrapper = mount(UserManageTable, {
        attachTo: document.body,
        props: {
            list, loading, total: list.length, currentPage: 1, pageSize: 20,
            isProcessing: false, processingId: null, rowMotionClass: (id) => `motion-${id}`,
            hasActiveFilters: true, onToggleStatus: toggleStatus
        },
        global: {
            components: { ElAutoResizer, ElAvatar, ElButton, ElResponsiveCollection, ElSkeleton, ElTableV2 },
            directives: { loading: ElLoading.directive }
        }
    })
    cleanups.push(() => wrapper.unmount())
    return { wrapper, toggleStatus }
}

beforeEach(() => {
    compact = true
    mediaListeners.clear()
    collectionMediaListeners.clear()
    resizeObservers.length = 0
    networkRequest.mockClear()
    vi.stubGlobal('fetch', networkRequest)
    vi.stubGlobal('ResizeObserver', FixtureResizeObserver)
    Object.defineProperty(window, 'ResizeObserver', { value: FixtureResizeObserver, configurable: true })
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
        get matches() { return query === '(max-width: 767px)' && compact }, media: query, onchange: null,
        addListener: vi.fn(), removeListener: vi.fn(),
        addEventListener: (_event: string, listener: FixtureMediaListener | null) => {
            if (listener) {
                mediaListeners.add(listener)
                if (query === '(max-width: 767px)') collectionMediaListeners.add(listener)
            }
        },
        removeEventListener: (_event: string, listener: FixtureMediaListener | null) => {
            if (listener) {
                mediaListeners.delete(listener)
                collectionMediaListeners.delete(listener)
            }
        },
        dispatchEvent: () => true
    }))
})

afterEach(() => {
    cleanups.splice(0).forEach((cleanup) => cleanup())
    expect(networkRequest).not.toHaveBeenCalled()
    expect(mediaListeners.size).toBe(0)
    expect(collectionMediaListeners.size).toBe(0)
    expect(resizeObservers.every((observer) => observer.targets.size === 0)).toBe(true)
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    if (originalResizeObserver) Object.defineProperty(window, 'ResizeObserver', originalResizeObserver)
    else Reflect.deleteProperty(window, 'ResizeObserver')
    document.body.replaceChildren()
})

describe('UserManageTable public boundary and real collection/table delegation', () => {
    it('preserves the public fixed-direction object and Column type identity', () => {
        expect(FsusUiTableV2FixedDir).toBe(TableV2FixedDir)
        const column: FsusUiTableV2Column<UserListViewItem> = {
            key: 'actions', width: 128, fixed: FsusUiTableV2FixedDir.RIGHT
        }
        const publicColumn: Column<UserListViewItem> = column
        expect(publicColumn.fixed).toBe(TableV2FixedDir.RIGHT)
    })

    it('passes the canonical runtime-import rule and rejects a restored direct import', () => {
        const source = readFileSync(componentPath, 'utf8')
        expect(runtimeImportFindings(source)).toEqual([])
        const regression = source.replace(
            "import { FsusUiTableV2FixedDir as TableV2FixedDir } from '@/fsusui/tableV2';",
            "import { TableV2FixedDir } from '@ozwasyd/element-plus';"
        )
        expect(regression).not.toBe(source)
        expect(runtimeImportFindings(regression)).toEqual([{
            file: 'src/frontend/src/components/admin/users/UserManageTable.vue',
            rule: 'runtime-import-outside-boundary', detail: 'imports runtime from @ozwasyd/element-plus'
        }])
    })

    it('projects frozen compact rows through the actual collection and emits original account objects', async () => {
        const list = Object.freeze([account(31), account(32, 1), account(33, 2)])
        const { wrapper, toggleStatus } = renderTable(list)
        await settle()
        const collection = wrapper.getComponent(ElResponsiveCollection)
        expect(collection.props('rowKey')).toBe('accountId')
        expect(collection.props('items')).not.toBe(list)
        const items = collection.props('items')
        if (!items) throw new Error('Expected the actual collection items')
        items.forEach((row, index) => expect(row).toBe(list[index]))
        expect(collection.findAll('[role="listitem"]')).toHaveLength(3)
        expect(wrapper.findComponent(ElTableV2).isVisible()).toBe(false)
        await wrapper.get('[role="listitem"] button[aria-label="变更匿名账号状态：reader-31"]').trigger('click')
        await wrapper.get('[role="listitem"] button[aria-label="变更匿名账号状态：reader-32"]').trigger('click')
        expect(toggleStatus.mock.calls[0]?.[0]).toBe(list[0])
        expect(toggleStatus.mock.calls[1]?.[0]).toBe(list[1])
        expect(wrapper.find('button[aria-label="变更匿名账号状态：reader-33"]').exists()).toBe(false)
        expect(Object.isFrozen(list)).toBe(true)
        expect(list.every(Object.isFrozen)).toBe(true)
    })

    it('reacts to compact response replacement and emits the new object for the same accountId', async () => {
        const original = account(31)
        const { wrapper, toggleStatus } = renderTable(Object.freeze([original, account(32)]))
        await settle()
        const replacement = Object.freeze({ ...original, displayHandle: 'replacement' })
        await wrapper.setProps({ list: Object.freeze([replacement]) })
        await settle()
        expect(wrapper.findAll('[role="listitem"]')).toHaveLength(1)
        expect(wrapper.find('[role="listitem"] button[aria-label="变更匿名账号状态：reader-32"]').exists()).toBe(false)
        await wrapper.get('[role="listitem"] button[aria-label="变更匿名账号状态：replacement"]').trigger('click')
        expect(toggleStatus.mock.calls[0]?.[0]).toBe(replacement)
        expect(toggleStatus.mock.calls[0]?.[0]).not.toBe(original)
    })

    it('keeps compact processing local to the selected account and refuses its activation', async () => {
        const list = Object.freeze([account(31), account(32)])
        const { wrapper, toggleStatus } = renderTable(list)
        await settle()
        await wrapper.setProps({ isProcessing: true, processingId: 31 })
        const processing = wrapper.get('[role="listitem"] button[aria-label="变更匿名账号状态：reader-31"]')
        expect(processing.attributes('disabled')).toBeDefined()
        await processing.trigger('click')
        expect(toggleStatus).not.toHaveBeenCalled()
        await wrapper.get('[role="listitem"] button[aria-label="变更匿名账号状态：reader-32"]').trigger('click')
        expect(toggleStatus.mock.calls[0]?.[0]).toBe(list[1])
    })

    it('emits the replacement object when a single compact row keeps every field unchanged', async () => {
        const original = account(31)
        const { wrapper, toggleStatus } = renderTable(Object.freeze([original]))
        await settle()
        const replacement = Object.freeze({ ...original })
        expect(replacement).toEqual(original)
        expect(replacement).not.toBe(original)
        await wrapper.setProps({ list: Object.freeze([replacement]) })
        await settle()
        expect(wrapper.findAll('[role="listitem"]')).toHaveLength(1)
        expect(wrapper.getComponent(ElResponsiveCollection).props('items')?.[0]).toBe(replacement)
        await wrapper.get('[role="listitem"] button[aria-label="变更匿名账号状态：reader-31"]').trigger('click')
        expect(toggleStatus).toHaveBeenCalledTimes(1)
        expect(toggleStatus.mock.calls[0]?.[0]).toBe(replacement)
        expect(toggleStatus.mock.calls[0]?.[0]).not.toBe(original)
    })

    it('updates a single compact row through processing selection, release and repeated toggles', async () => {
        const row = account(31)
        const list = Object.freeze([row])
        const { wrapper, toggleStatus } = renderTable(list)
        await settle()
        const button = () => wrapper.get('[role="listitem"] button[aria-label="变更匿名账号状态：reader-31"]')
        const assertState = async (disabled: boolean, calls: number) => {
            expect(wrapper.findAll('[role="listitem"]')).toHaveLength(1)
            expect(wrapper.getComponent(ElResponsiveCollection).props('items')?.[0]).toBe(row)
            if (disabled) expect(button().attributes('disabled')).toBeDefined()
            else expect(button().attributes('disabled')).toBeUndefined()
            await button().trigger('click')
            expect(toggleStatus).toHaveBeenCalledTimes(calls)
        }
        await assertState(false, 1)
        await wrapper.setProps({ isProcessing: true, processingId: 31 })
        await settle()
        await assertState(true, 1)
        await wrapper.setProps({ processingId: 32 })
        await settle()
        await assertState(false, 2)
        await wrapper.setProps({ processingId: 31 })
        await settle()
        await assertState(true, 2)
        await wrapper.setProps({ isProcessing: false })
        await settle()
        await assertState(false, 3)
        await wrapper.setProps({ isProcessing: true })
        await settle()
        await assertState(true, 3)
        await wrapper.setProps({ isProcessing: false, processingId: null })
        await settle()
        await assertState(false, 4)
        expect(toggleStatus.mock.calls.every(([payload]) => payload === row)).toBe(true)
    })

    it('uses the real desktop table with accountId keys, right-fixed actions and original frozen rows', async () => {
        compact = false
        const list = Object.freeze([account(31), account(32, 1), account(33, 2)])
        const { wrapper, toggleStatus } = renderTable(list)
        await settle()
        const table = wrapper.getComponent(ElTableV2)
        expect(table.props('rowKey')).toBe('accountId')
        expect(table.props('width')).toBe(1200)
        expect(table.props('height')).toBe(500)
        expect(table.props('data')).not.toBe(list)
        table.props('data').forEach((row, index) => expect(row).toBe(list[index]))
        expect(table.props('columns').find((column) => column.key === 'actions')?.fixed).toBe(FsusUiTableV2FixedDir.RIGHT)
        await wrapper.get('button[aria-label="变更匿名账号状态：reader-31"]').trigger('click')
        expect(toggleStatus.mock.calls[0]?.[0]).toBe(list[0])
        expect(wrapper.find('button[aria-label="变更匿名账号状态：reader-33"]').exists()).toBe(false)
        expect(list.every(Object.isFrozen)).toBe(true)
    })

    it('updates desktop responses while preserving each replacement row identity', async () => {
        compact = false
        const original = account(31)
        const { wrapper, toggleStatus } = renderTable(Object.freeze([original, account(32)]))
        await settle()
        const replacement = Object.freeze({ ...original, displayHandle: 'desktop-replacement' })
        await wrapper.setProps({ list: Object.freeze([account(34), replacement]) })
        await settle()
        expect(wrapper.getComponent(ElTableV2).props('data')[1]).toBe(replacement)
        expect(wrapper.find('button[aria-label="变更匿名账号状态：reader-32"]').exists()).toBe(false)
        await wrapper.get('button[aria-label="变更匿名账号状态：desktop-replacement"]').trigger('click')
        expect(toggleStatus.mock.calls[0]?.[0]).toBe(replacement)
    })

    it('delegates desktop processing to the actual public button', async () => {
        compact = false
        const { wrapper, toggleStatus } = renderTable(Object.freeze([account(31)]))
        await settle()
        await wrapper.setProps({ isProcessing: true, processingId: 31 })
        const button = wrapper.get('button[aria-label="变更匿名账号状态：reader-31"]')
        expect(button.attributes('disabled')).toBeDefined()
        await button.trigger('click')
        expect(toggleStatus).not.toHaveBeenCalled()
    })

    it('refuses foreign, null and primitive public slots and stale row-motion callbacks', async () => {
        compact = false
        const original = account(31)
        const { wrapper } = renderTable(Object.freeze([original]))
        await settle()
        const table = wrapper.getComponent(ElTableV2)
        const rowClass = table.props('rowClass')
        if (typeof rowClass !== 'function') throw new Error('Expected the actual table row-class callback')
        const rowParams = (rowData: unknown) => ({ rowData, rowIndex: 0, columns: table.props('columns') })
        expect(rowClass(rowParams(original))).toBe('motion-31')
        for (const row of [{ ...original }, null, 31]) {
            expect(rowClass(rowParams(row))).toBe('')
            const nodes = table.vm.$slots.cell?.({ rowData: row, column: { key: 'actions' } }) ?? []
            expect(nodes.every((node) => node.type === Comment)).toBe(true)
        }
        await wrapper.setProps({ list: Object.freeze([account(31)]) })
        expect(rowClass(rowParams(original))).toBe('')
    })

    it('renders desktop empty state through the real table and emits only reset-filters', async () => {
        compact = false
        const { wrapper, toggleStatus } = renderTable(Object.freeze([]))
        await settle()
        expect(wrapper.getComponent(ElTableV2).props('data')).toHaveLength(0)
        expect(wrapper.text()).toContain('暂无匿名账号记录')
        const reset = wrapper.findAllComponents(ElButton).find((button) => button.text() === '清除筛选' && button.isVisible())
        expect(reset).toBeDefined()
        await reset?.trigger('click')
        expect(wrapper.emitted('reset-filters')).toEqual([[]])
        expect(toggleStatus).not.toHaveBeenCalled()
    })

    it('delegates viewport changes to the actual collection and removes its listener on unmount', async () => {
        const { wrapper } = renderTable(Object.freeze([account(31)]))
        await settle()
        expect(collectionMediaListeners.size).toBe(1)
        compact = false
        const event = new MediaQueryListEvent('change', { matches: compact, media: '(max-width: 767px)' })
        collectionMediaListeners.forEach((listener) => {
            if (typeof listener === 'function') listener(event)
            else listener.handleEvent(event)
        })
        await settle()
        expect(wrapper.getComponent(ElResponsiveCollection).classes()).not.toContain('is-compact')
        expect(wrapper.getComponent(ElTableV2).props('data')[0]?.accountId).toBe(31)
    })

    it('shows the real initial skeleton and transitions to the empty filtered collection', async () => {
        const { wrapper } = renderTable(Object.freeze([]), true)
        expect(wrapper.getComponent(ElSkeleton).props('animated')).toBe(true)
        expect(wrapper.findComponent(ElResponsiveCollection).exists()).toBe(false)
        await wrapper.setProps({ loading: false })
        await settle()
        expect(wrapper.findComponent(ElSkeleton).exists()).toBe(false)
        const reset = wrapper.findAllComponents(ElButton).find((button) => button.text() === '清除筛选' && button.isVisible())
        expect(reset).toBeDefined()
        await reset?.trigger('click')
        expect(wrapper.emitted('reset-filters')).toEqual([[]])
        await wrapper.setProps({ loading: true })
        expect(wrapper.findComponent(ElSkeleton).exists()).toBe(false)
    })

    it('keeps populated loading rows and removes the filter action when filters are inactive', async () => {
        const { wrapper } = renderTable(Object.freeze([account(31)]), true)
        await settle()
        expect(wrapper.findComponent(ElSkeleton).exists()).toBe(false)
        expect(wrapper.getComponent(ElResponsiveCollection).props('items')).toHaveLength(1)
        await wrapper.setProps({ list: Object.freeze([]), loading: false, hasActiveFilters: false })
        await settle()
        expect(wrapper.text()).toContain('暂无匿名账号记录')
        expect(wrapper.findAllComponents(ElButton)).toHaveLength(0)
    })
})
