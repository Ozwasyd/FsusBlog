import { describe, expect, it, vi } from 'vitest'
import {
  AuthoringInspectorSession, authoringInspectorSchema,
  computeAuthoringInspectorModelDigest, parseAuthoringInspectorBinding, parseAuthoringInspectorModel,
  type AuthoringInspectorBinding,
} from '@/fsusui/authoringInspector'

import { inspectorBinding, inspectorHost, inspectorModel } from './authoringInspector.fixture'

const result = async (binding: AuthoringInspectorBinding, model = inspectorModel()) => ({
  schema: authoringInspectorSchema, binding, model,
  modelSha256: await computeAuthoringInspectorModelDigest(model),
})

describe('host-owned closed read-only inspector boundary', () => {
  it('accepts all closed nodes, copies data immutably and checks content digest', async () => {
    const session = new AuthoringInspectorSession(inspectorHost())
    const binding = inspectorBinding()
    session.begin(binding)
    const input = await result(binding)
    const accepted = await session.accept(input)
    input.model.nodes[0]!.id = 'changed'
    expect(accepted.model.nodes[0]!.id).toBe('values')
    expect(Object.isFrozen(accepted.model.nodes)).toBe(true)
    await expect(session.accept({ ...await result(binding), modelSha256: 'd'.repeat(64) })).rejects.toThrow('tampered')
    session.cancel()
  })

  it.each(['loading', 'empty', 'error', 'permission', 'unsupported'] as const)('keeps %s host state free of data/actions', (state) => {
    expect(parseAuthoringInspectorModel({ ...inspectorModel(), state, nodes: [], commands: [] }).state).toBe(state)
    expect(() => parseAuthoringInspectorModel({ ...inspectorModel(), state })).toThrow('unavailable')
  })

  it.each(['componentName', 'props', 'html', 'class', 'style', 'token', 'svg', 'font', 'remoteImage', 'metadataPatch', 'sourcePatch', 'domAction'])(
    'refuses arbitrary %s at the model boundary', (field) => {
      expect(() => parseAuthoringInspectorModel({ ...inspectorModel(), [field]: 'injected' })).toThrow('unknown')
    },
  )
  it('rejects unknown nodes, getters, duplicate IDs, oversized fields/tables and payload', () => {
    expect(() => parseAuthoringInspectorModel({ ...inspectorModel(), nodes: [{ kind: 'vue', id: 'x' }] })).toThrow('unknown')
    expect(() => parseAuthoringInspectorModel({ ...inspectorModel(), nodes: Array(33).fill(inspectorModel().nodes[0]) })).toThrow('bound')
    expect(() => parseAuthoringInspectorModel({ ...inspectorModel(), commands: Array(2).fill(inspectorModel().commands[0]) })).toThrow('conflict')
    expect(() => parseAuthoringInspectorModel({ ...inspectorModel(), nodes: [{ kind: 'table', id: 'x', columns: [{ id: 'one', labelReference: 'one' }], rows: [{ id: 'one', cells: ['one', 'two'] }] }] })).toThrow('bound')
    const getter = vi.fn(() => 'inspector.title')
    const value = { ...inspectorModel() }
    Object.defineProperty(value, 'titleReference', { get: getter, enumerable: true })
    expect(() => parseAuthoringInspectorModel(value)).toThrow('closed data')
    expect(getter).not.toHaveBeenCalled()
    expect(() => parseAuthoringInspectorModel({ ...inspectorModel(), nodes: [{ kind: 'list', id: 'x', items: Array(100).fill('x'.repeat(2048)) }] })).toThrow('byte budget')
  })

  it('requires real host approval for minimal/full scope and refuses unavailable command refs', async () => {
    const host = inspectorHost()
    vi.mocked(host.permitsRead).mockReturnValue(false)
    const session = new AuthoringInspectorSession(host)
    expect(() => session.begin(inspectorBinding())).toThrow('unauthorized')
    expect(() => session.begin({ ...inspectorBinding(), scope: { kind: 'document-full' } })).toThrow('unauthorized')
    vi.mocked(host.permitsRead).mockReturnValue(true)
    const binding = inspectorBinding()
    session.begin(binding)
    vi.mocked(host.commandEnabled).mockReturnValue(false)
    await expect(session.accept(await result(binding))).rejects.toThrow('unavailable command')
    expect(session.current).toBeUndefined()
    session.cancel()
  })

  it.each(['documentEpoch', 'sourceRevision', 'lifecycleGeneration'] as const)('rejects %s drift even with equal document text', async (field) => {
    const session = new AuthoringInspectorSession(inspectorHost())
    const binding = inspectorBinding()
    session.begin(binding)
    await expect(session.accept(await result({ ...binding, [field]: binding[field] + 1 }))).rejects.toThrow('stale')
    session.cancel()
  })

  it('cancels superseded/hidden tasks and prevents interrupted, revoked and timed-out results', async () => {
    const hostController = new AbortController()
    const host = inspectorHost(hostController)
    const session = new AuthoringInspectorSession(host)
    const binding = inspectorBinding()
    const first = session.begin(binding)
    const second = session.begin(binding)
    expect(first.aborted).toBe(true)
    const pending = session.accept(await result(binding))
    session.cancel()
    await expect(pending).rejects.toThrow('stale')
    expect(second.aborted).toBe(true)
    const third = session.begin(binding)
    await session.accept(await result(binding))
    hostController.abort()
    expect(third.aborted).toBe(true)
    expect(session.current).toBeUndefined()
    expect(() => session.begin({ ...binding, deadline: Date.now() - 1 })).toThrow('stale')
  })
  it('owns and releases the only deadline timer on hide, repeat and timeout', async () => {
    vi.useFakeTimers()
    try {
      const session = new AuthoringInspectorSession(inspectorHost())
      const binding = inspectorBinding()
      const first = session.begin(binding)
      expect(vi.getTimerCount()).toBe(1)
      const second = session.begin(binding)
      expect(first.aborted).toBe(true)
      expect(vi.getTimerCount()).toBe(1)
      session.cancel()
      expect(second.aborted).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
      const timed = session.begin(binding)
      await vi.advanceTimersByTimeAsync(30000)
      expect(timed.aborted).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
      expect(session.current).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
  it('rejects array subclasses and custom map functions without invoking callbacks', () => {
    const callback = vi.fn(() => [])
    class ForeignArray extends Array {}
    Object.defineProperty(ForeignArray.prototype, 'map', { value: callback })
    const inherited = new ForeignArray()
    Object.defineProperty(inherited, 'map', { value: callback, enumerable: false })
    expect(() => parseAuthoringInspectorModel({ ...inspectorModel(), nodes: inherited })).toThrow()
    expect(callback).not.toHaveBeenCalled()
    const custom = [...inspectorModel().nodes]
    Object.defineProperty(custom, 'map', { value: callback, enumerable: false })
    expect(() => parseAuthoringInspectorModel({ ...inspectorModel(), nodes: custom })).toThrow()
    expect(callback).not.toHaveBeenCalled()
  })
  it('rejects sparse arrays, indexed accessors, symbol keys and hidden properties', () => {
    const holes = Array(1)
    Object.defineProperty(holes, 'fake', { value: 'not an index', enumerable: true })
    expect(() => parseAuthoringInspectorModel({ ...inspectorModel(), nodes: holes })).toThrow()
    const getter = vi.fn(() => inspectorModel().nodes[0])
    const accessor = []
    Object.defineProperty(accessor, '0', { get: getter, enumerable: true })
    expect(() => parseAuthoringInspectorModel({ ...inspectorModel(), nodes: accessor })).toThrow()
    expect(getter).not.toHaveBeenCalled()
    for (const key of ['hidden', Symbol('hidden')]) {
      const value = [...inspectorModel().nodes]
      Object.defineProperty(value, key, { value: 'unregistered', enumerable: false })
      expect(() => parseAuthoringInspectorModel({ ...inspectorModel(), nodes: value })).toThrow()
    }
    const model = inspectorModel()
    Object.defineProperty(model, 'hidden', { value: 'unregistered', enumerable: false })
    expect(() => parseAuthoringInspectorModel(model)).toThrow()
  })
  it('rejects non-string state and severity without coercing attacker objects', () => {
    const coerceState = vi.fn(() => 'ready')
    expect(() => parseAuthoringInspectorModel({ ...inspectorModel(), state: { toString: coerceState } })).toThrow()
    expect(coerceState).not.toHaveBeenCalled()
    const coerceSeverity = vi.fn(() => 'warning')
    expect(() => parseAuthoringInspectorModel({ ...inspectorModel(), nodes: [{ kind: 'diagnostic', id: 'one', code: 'check', messageReference: 'check.message', severity: { toString: coerceSeverity } }] })).toThrow()
    expect(coerceSeverity).not.toHaveBeenCalled()
  })
  it('rejects scope and node accessors before choosing a data variant', () => {
    const scopeGetter = vi.fn(() => 'document-full')
    const scope = {}
    Object.defineProperty(scope, 'kind', { get: scopeGetter, enumerable: true })
    expect(() => parseAuthoringInspectorBinding({ ...inspectorBinding(), scope })).toThrow('closed data')
    expect(scopeGetter).not.toHaveBeenCalled()
    const nodeGetter = vi.fn(() => 'node')
    const node = { kind: 'status', messageReference: 'status' }
    Object.defineProperty(node, 'id', { get: nodeGetter, enumerable: true })
    expect(() => parseAuthoringInspectorModel({ ...inspectorModel(), nodes: [node] })).toThrow('closed data')
    expect(nodeGetter).not.toHaveBeenCalled()
  })
  it('rejects revocation performed by the final host command check', async () => {
    const host = inspectorHost()
    const session = new AuthoringInspectorSession(host)
    const binding = inspectorBinding()
    session.begin(binding)
    let calls = 0
    vi.mocked(host.commandEnabled).mockImplementation(() => {
      calls++
      if (calls === 2) session.cancel()
      return true
    })
    await expect(session.accept(await result(binding))).rejects.toThrow('stale')
    expect(session.current).toBeUndefined()
  })
  it('clears accepted data and owned resources when host authority throws or cancels during a current read', async () => {
    const host = inspectorHost()
    const session = new AuthoringInspectorSession(host)
    const binding = inspectorBinding()
    const signal = session.begin(binding)
    await session.accept(await result(binding))
    vi.mocked(host.isCurrent).mockImplementation(() => { throw new Error('host-read-failed') })
    expect(session.current).toBeUndefined()
    expect(signal.aborted).toBe(true)
    vi.mocked(host.isCurrent).mockReturnValue(true)
    session.begin(binding)
    await session.accept(await result(binding))
    vi.mocked(host.isCurrent).mockImplementation(() => {
      session.cancel()
      return true
    })
    expect(session.current).toBeUndefined()
  })
  it('begin does not attach a stale listener after the host signal callback cancels', () => {
    vi.useFakeTimers()
    const hostController = new AbortController()
    const host = inspectorHost(hostController)
    const session = new AuthoringInspectorSession(host)
    const add = vi.spyOn(hostController.signal, 'addEventListener')
    let calls = 0
    host.signal = () => {
      if (++calls === 2) session.cancel()
      return hostController.signal
    }
    try {
      expect(session.begin(inspectorBinding()).aborted).toBe(true)
      expect(add).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      session.cancel()
      vi.useRealTimers()
    }
  })
  it('begin releases its timer and controller when the host signal callback throws', () => {
    vi.useFakeTimers()
    const host = inspectorHost()
    const originalSignal = host.signal
    const session = new AuthoringInspectorSession(host)
    let calls = 0
    host.signal = (binding) => {
      if (++calls === 2) throw new Error('host-signal-failed')
      return originalSignal(binding)
    }
    try {
      expect(() => session.begin(inspectorBinding())).toThrow('host-signal-failed')
      expect(vi.getTimerCount()).toBe(0)
      expect(session.current).toBeUndefined()
    } finally {
      session.cancel()
      vi.useRealTimers()
    }
  })
  it('begin preserves a replacement generation created by the host signal callback', async () => {
    vi.useFakeTimers()
    const oldHost = new AbortController()
    const replacementHost = new AbortController()
    const host = inspectorHost(oldHost)
    const session = new AuthoringInspectorSession(host)
    const binding = inspectorBinding()
    const replacementBinding = { ...binding, requestId: 'replacement-request' }
    let replacementSignal: AbortSignal | undefined
    let calls = 0
    host.signal = (requested) => {
      if (requested.requestId === replacementBinding.requestId) return replacementHost.signal
      if (++calls === 2) replacementSignal = session.begin(replacementBinding)
      return oldHost.signal
    }
    const oldAdd = vi.spyOn(oldHost.signal, 'addEventListener')
    try {
      const interrupted = session.begin(binding)
      expect(interrupted.aborted).toBe(true)
      expect(interrupted).not.toBe(replacementSignal)
      expect(oldAdd).not.toHaveBeenCalled()
      expect(replacementSignal?.aborted).toBe(false)
      expect(vi.getTimerCount()).toBe(1)
      oldHost.abort()
      expect(replacementSignal?.aborted).toBe(false)
      await session.accept(await result(replacementBinding))
      expect(session.current?.binding.requestId).toBe(replacementBinding.requestId)
      await vi.advanceTimersByTimeAsync(30000)
      expect(replacementSignal?.aborted).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      session.cancel()
      vi.useRealTimers()
    }
  })
  it('begin preserves a replacement created during admission rather than overwriting it', async () => {
    const host = inspectorHost()
    const session = new AuthoringInspectorSession(host)
    const binding = inspectorBinding()
    const replacementBinding = { ...binding, requestId: 'admission-replacement' }
    let replacementSignal: AbortSignal | undefined
    vi.mocked(host.isCurrent).mockImplementation((requested) => {
      if (requested.requestId === binding.requestId) replacementSignal = session.begin(replacementBinding)
      return true
    })
    try {
      expect(session.begin(binding).aborted).toBe(true)
      expect(replacementSignal?.aborted).toBe(false)
      await session.accept(await result(replacementBinding))
      expect(session.current?.binding.requestId).toBe(replacementBinding.requestId)
    } finally {
      session.cancel()
    }
  })
  it('retired host and deadline callbacks cannot revoke a replacement generation', () => {
    vi.useFakeTimers()
    const oldHost = new AbortController()
    const replacementHost = new AbortController()
    const host = inspectorHost(oldHost)
    const session = new AuthoringInspectorSession(host)
    const binding = inspectorBinding()
    const replacementBinding = { ...binding, requestId: 'retired-callback-replacement' }
    host.signal = (requested) => requested.requestId === binding.requestId ? oldHost.signal : replacementHost.signal
    const add = vi.spyOn(oldHost.signal, 'addEventListener')
    const timers = vi.spyOn(globalThis, 'setTimeout')
    try {
      const oldSignal = session.begin(binding)
      const oldRevoke = add.mock.calls[0]![1]
      const oldDeadline = timers.mock.calls[0]![0]
      const replacement = session.begin(replacementBinding)
      expect(oldSignal.aborted).toBe(true)
      expect(typeof oldRevoke).toBe('function')
      expect(typeof oldDeadline).toBe('function')
      if (typeof oldRevoke === 'function') oldRevoke.call(oldHost.signal, new Event('abort'))
      if (typeof oldDeadline === 'function') oldDeadline()
      expect(replacement.aborted).toBe(false)
      expect(vi.getTimerCount()).toBe(1)
    } finally {
      session.cancel()
      timers.mockRestore()
      vi.useRealTimers()
    }
  })
  it.each(['isCurrent', 'permitsRead'] as const)('begin rechecks %s after the host signal callback changes authority', (permission) => {
    vi.useFakeTimers()
    const hostController = new AbortController()
    const host = inspectorHost(hostController)
    const session = new AuthoringInspectorSession(host)
    let calls = 0
    host.signal = () => {
      if (++calls === 2) vi.mocked(host[permission]).mockReturnValue(false)
      return hostController.signal
    }
    const add = vi.spyOn(hostController.signal, 'addEventListener')
    try {
      expect(session.begin(inspectorBinding()).aborted).toBe(true)
      expect(hostController.signal.aborted).toBe(false)
      expect(add).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      session.cancel()
      vi.useRealTimers()
    }
  })
  it('cancel preserves a replacement created synchronously by the old owned abort signal', async () => {
    vi.useFakeTimers()
    const session = new AuthoringInspectorSession(inspectorHost())
    const binding = inspectorBinding()
    const replacementBinding = { ...binding, requestId: 'abort-replacement' }
    const oldSignal = session.begin(binding)
    let replacementSignal: AbortSignal | undefined
    oldSignal.addEventListener('abort', () => {
      replacementSignal = session.begin(replacementBinding)
    }, { once: true })
    try {
      session.cancel()
      expect(oldSignal.aborted).toBe(true)
      expect(replacementSignal?.aborted).toBe(false)
      expect(vi.getTimerCount()).toBe(1)
      await session.accept(await result(replacementBinding))
      expect(session.current?.binding.requestId).toBe(replacementBinding.requestId)
      session.cancel()
      expect(replacementSignal?.aborted).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
      expect(session.current).toBeUndefined()
    } finally {
      session.cancel()
      vi.useRealTimers()
    }
  })
})
