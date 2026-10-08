// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import ArticleWriteInspectorShell from '@/components/admin/article/ArticleWriteInspectorShell.vue'
import { AuthoringInspectorSession, authoringInspectorSchema, computeAuthoringInspectorModelDigest } from '@/fsusui/authoringInspector'
import { inspectorBinding, inspectorHost, inspectorModel } from '../../fsusui/authoringInspector.fixture'

describe('read-only contributions in the existing Inspector shell', () => {
  it('cancels removed sessions while retaining a still-owned session', async () => {
    const removed = new AuthoringInspectorSession(inspectorHost())
    const retained = new AuthoringInspectorSession(inspectorHost())
    const removedSignal = removed.begin(inspectorBinding())
    const retainedSignal = retained.begin(inspectorBinding())
    const wrapper = mount(ArticleWriteInspectorShell, { props: { activeInspector: 'check', inspectorSessions: [removed, retained] }, global: { stubs: { ElIcon: true } } })
    await wrapper.setProps({ inspectorSessions: [retained] })
    expect(removedSignal.aborted).toBe(true)
    expect(retainedSignal.aborted).toBe(false)
    wrapper.unmount()
    expect(retainedSignal.aborted).toBe(true)
  })

  it('renders escaped text with public controls and only emits a registered command reference', async () => {
    const host = inspectorHost()
    const session = new AuthoringInspectorSession(host)
    const binding = inspectorBinding()
    const signal = session.begin(binding)
    const fullModel = inspectorModel()
    // The real public Table is covered by the Chromium fixture. HappyDOM's
    // class-based MutationObserver cannot survive Vue's reactive proxy.
    const model = { ...fullModel, nodes: fullModel.nodes.filter((node) => node.kind !== 'table') }
    const values = model.nodes[0]!
    if (values.kind === 'values') values.rows[0]!.value = '<img src=x onerror=alert(1)>'
    await session.accept({ schema: authoringInspectorSchema, binding, model, modelSha256: await computeAuthoringInspectorModelDigest(model) })
    const wrapper = mount(ArticleWriteInspectorShell, { props: { activeInspector: 'check', inspectorSessions: [session] }, global: { stubs: { ElIcon: true } } })
    expect(wrapper.findAll('aside[role=complementary]')).toHaveLength(1)
    expect(wrapper.findAll('[data-authoring-inspector-model]')).toHaveLength(1)
    expect(wrapper.get('[data-authoring-inspector-model]').text()).toContain('<img src=x onerror=alert(1)>')
    expect(wrapper.find('[data-authoring-inspector-model] img').exists()).toBe(false)
    const button = wrapper.findAll('[data-authoring-inspector-model] button').find((item) => item.text() === 'command.review')!
    await button.trigger('click')
    expect(wrapper.emitted('inspector-command')).toEqual([[binding, 'acme.tools.review']])
    vi.mocked(host.commandEnabled).mockReturnValue(false)
    await button.trigger('click')
    expect(wrapper.emitted('inspector-command')).toHaveLength(1)
    await wrapper.setProps({ activeInspector: null })
    expect(signal.aborted).toBe(true)
    expect(session.current).toBeUndefined()
    expect(wrapper.find('[data-authoring-inspector-model]').exists()).toBe(false)
    wrapper.unmount()
  })
})
