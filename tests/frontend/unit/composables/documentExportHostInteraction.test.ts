// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { decodeDocumentExportSourceChoicesResponse } from '@/codecs/binary/documentExportSourceOptionsWire.generated';
import { FsusUiButton } from '@/fsusui/button';
import { FsusUiClassicSelect } from '@/fsusui/classicSelect';
import { privateRequestRuntime } from '@/services/privateRequestRuntime';
import DocumentExportHost from '@/views/admin/article/DocumentExportHost.vue';

import goldens from '../../../backend/Fixtures/document-export-source-options-payload-goldens-v1.json';

const capture = vi.hoisted(() => vi.fn());
vi.mock('@/api/documentExportSourceOptions', () => ({ captureDocumentExportRevisionChoices: capture }));
const response = () => decodeDocumentExportSourceChoicesResponse(Uint8Array.from(
    goldens.vectors.find(vector => vector.name === 'exact-version-choices')!.hex.match(/../gu)!, value => Number.parseInt(value, 16)));
const mounted: ReturnType<typeof mount>[] = [];
beforeEach(() => { privateRequestRuntime.resetForTests(); capture.mockReset(); });
afterEach(() => { mounted.splice(0).forEach(wrapper => wrapper.unmount()); privateRequestRuntime.resetForTests(); document.body.innerHTML = ''; });
async function openHost()
{
    const wrapper = mount(DocumentExportHost, { props: { articles: [{ id: 42, title: 'Actual article fixture' }] }, attachTo: document.body });
    mounted.push(wrapper);
    await wrapper.findComponent(FsusUiButton).trigger('click');
    await flushPromises();
    return wrapper;
}
async function selectArticle(wrapper: Awaited<ReturnType<typeof openHost>>)
{
    wrapper.findAllComponents(FsusUiClassicSelect)[0]!.vm.$emit('update:modelValue', 42);
    await flushPromises();
}
function readButton(wrapper: Awaited<ReturnType<typeof openHost>>)
{
    return wrapper.findAllComponents(FsusUiButton).find(button => button.text() === '读取修订')!;
}

it('uses an explicit article and revision selection while missing authorities prevent export-port construction', async () =>
{
    capture.mockResolvedValue(response());
    const wrapper = await openHost();
    expect(capture).not.toHaveBeenCalled();
    expect(readButton(wrapper).props('disabled')).toBe(true);
    await selectArticle(wrapper);
    await readButton(wrapper).trigger('click');
    await flushPromises();
    expect(capture).toHaveBeenCalledOnce();
    expect(capture.mock.calls[0]![0]).toEqual({ articleId: 42 });
    const revisions = wrapper.findAllComponents(FsusUiClassicSelect)[1]!;
    expect(revisions.props('modelValue')).toBeUndefined();
    revisions.vm.$emit('update:modelValue', response().choices[0]!.choiceId);
    await flushPromises();
    const next = wrapper.findAllComponents(FsusUiButton).find(button => button.text() === '继续导出')!;
    expect(next.props('disabled')).toBe(true);
    expect(wrapper.findComponent({ name: 'ExportCenter' }).exists()).toBe(false);
    expect(wrapper.text()).toContain('运行资格和该来源的隐私判定尚未提供');
});
it('keeps an uncertain acquisition visible and never retries without another explicit read', async () =>
{
    capture.mockRejectedValue(new Error('controlled uncertain acquisition'));
    const wrapper = await openHost();
    await selectArticle(wrapper);
    await readButton(wrapper).trigger('click');
    await flushPromises();
    expect(capture).toHaveBeenCalledOnce();
    expect(wrapper.text()).toContain('没有自动重试');
    await flushPromises();
    expect(capture).toHaveBeenCalledOnce();
    await readButton(wrapper).trigger('click');
    await flushPromises();
    expect(capture).toHaveBeenCalledTimes(2);
});
it('aborts pending acquisition when the host unmounts and does not publish late choices', async () =>
{
    let complete!: (value: ReturnType<typeof response>) => void;
    capture.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const wrapper = await openHost();
    await selectArticle(wrapper);
    await readButton(wrapper).trigger('click');
    const signal = capture.mock.calls[0]![1] as AbortSignal;
    expect(signal.aborted).toBe(false);
    wrapper.unmount();
    mounted.pop();
    expect(signal.aborted).toBe(true);
    complete(response());
    await flushPromises();
    expect(capture).toHaveBeenCalledOnce();
});
