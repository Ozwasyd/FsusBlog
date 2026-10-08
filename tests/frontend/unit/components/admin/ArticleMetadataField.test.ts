// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { h, nextTick } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { decodeArticlePropertyValueReadResponse, encodeArticlePropertyValueReadResponse, type ArticlePropertyValueReadResponse } from '@/codecs/binary/articlePropertyValueReadCodecs';
import ArticleMetadataField from '@/components/admin/article/ArticleMetadataField.vue';
import { formatArticlePropertyExactDecimal, formatArticlePropertyUtcTicks, parseArticlePropertyExactDecimal,
    parseArticlePropertyUtcTicks } from '@/components/admin/article/articleMetadataExactEdit';
import { FsusUiButton } from '@/fsusui/button';
import { FsusUiInput } from '@/fsusui/input';
import { FsusUiSelect } from '@/fsusui/select';
import { FsusUiSwitch } from '@/fsusui/switch';
import { ArticleDocumentContextAdapter } from '@/services/authoring/articleDocumentContext';

import golden from '../../../../fixtures/protocol/article-property-value-read-wire-golden.json';

function response(): ArticlePropertyValueReadResponse
{
    const fixture = golden.cases.find((candidate) => candidate.name === 'current-8');
    if (!fixture) throw new Error('missing canonical wire fixture');
    return decodeArticlePropertyValueReadResponse(Uint8Array.from(Buffer.from(fixture.payloadHex, 'hex')));
}
function context()
{
    return new ArticleDocumentContextAdapter({ articleId: 7, draftId: 'article-7', editorSessionId: 'editor-7',
        siteScope: 'site:blog.example', userScope: 'user:42', content: 'body' }).context;
}
const labels = {
    unavailable: 'Unavailable field', editorUnavailable: 'Editor port unavailable', commitUnavailable: 'Save unavailable',
    unvalidated: 'Unsubmitted input; not validated; save unavailable', choose: 'Choose option', unknownOption: 'Unavailable option',
    defaultApplied: 'Server default applied', required: 'Required', conflict: 'Refresh changed definition', cancel: 'Cancel', save: 'Save',
    presenceLabel: 'Value presence', presence: ['Missing', 'Null', 'Present'], reconciliation: ['Current', 'Definition unavailable', 'Inactive definition',
        'Changed definition', 'Value rejected', 'Reference authority unavailable', 'Required value missing', 'Default pending'],
    exactEditHints: { number: 'Decimal point; preserve sign and fractional zeros', utc: 'UTC date and time with seven fractional digits' },
    exactEditErrors: { syntax: 'Use the exact edit format', 'coefficient-range': 'Coefficient exceeds decimal96',
        'scale-range': 'Fraction exceeds28 digits', 'calendar-range': 'Invalid UTC calendar value',
        'tick-range': 'UTC value exceeds supported range', 'invalid-value': 'Invalid exact value' },
    definitionSummary: {
        toggle: 'Definition flags and policies', searchEligible: 'Author search', filterable: 'Author filtering', sortable: 'Author sorting',
        required: 'Required policy', missing: 'Missing policy', null: 'Null policy', empty: 'Empty policy',
        visibilityScope: 'Visibility policy', displayPlacement: 'Display placement', yes: 'Yes', no: 'No', absent: 'Not supplied',
        nullValue: 'Null descriptor', unknown: 'Unknown', missingBehavior: ['Preserve missing', 'Apply default'],
        nullBehavior: ['Allow null', 'Reject null'], emptyBehavior: ['Preserve empty', 'Treat as null', 'Reject empty'],
        visibility: ['Author only', 'Site editors', 'Site readers'], placement: ['Hidden', 'Metadata', 'Sidebar']
    }
};
const wrappers: ReturnType<typeof mount>[] = [];
function render(type = 0, overrides = {})
{
    const model = response();
    // Golden bytes witness wire shape only. Simulate the actual service's
    // reconciliation states here; this is not an authenticated server receipt.
    model.reconciliation = model.definitions.map((item) => ({ definitionId: item.definitionId,
        status: item.valueType === 6 ? 5 as const : 0 as const, reasonCode: 'test-server-state' }));
    const definition = model.definitions.find((item) => item.valueType === type);
    if (!definition) throw new Error('missing typed definition');
    const wrapper = mount(ArticleMetadataField, { attachTo: document.body, props: { model, definitionId: definition.definitionId,
        definitionOwnerUserId: '42', context: context(), enabled: true, editable: true, readKey: 'permission-1', locale: 'en-US', labels,
        ...overrides } });
    wrappers.push(wrapper);
    return { wrapper, model, definition };
}
function value(model: ArticlePropertyValueReadResponse, id: string)
{
    const entry = model.current?.snapshot.values.find((item) => item.definitionId === id);
    if (!entry) throw new Error('missing value');
    return entry;
}
function button(wrapper: ReturnType<typeof mount>, name: string)
{
    const found = wrapper.findAllComponents(FsusUiButton).find((item) => item.text() === name);
    if (!found) throw new Error(`missing button ${name}`);
    return found;
}
function presenceSelect(wrapper: ReturnType<typeof mount>)
{
    const control = wrapper.findAllComponents(FsusUiSelect)[0];
    if (!control) throw new Error('missing public presence select');
    return control;
}
function valueSelect(wrapper: ReturnType<typeof mount>)
{
    const control = wrapper.findAllComponents(FsusUiSelect)[1];
    if (!control) throw new Error('missing public typed-value select');
    return control;
}
function inputHandler(wrapper: ReturnType<typeof mount>)
{
    const handler = wrapper.getComponent(FsusUiInput).vm.$.vnode.props?.['onUpdate:modelValue'];
    if (typeof handler !== 'function') throw new Error('missing real input handler');
    return handler as (value: unknown) => void;
}
afterEach(() =>
{
    wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
    document.body.innerHTML = '';
    vi.restoreAllMocks();
});

describe('ArticleMetadataField public controls and real canonical read states', () =>
{
    it.each([0, 1, 2, 3, 4, 5, 6, 7])('projects type %i without coercion or invented ports', (type) =>
    {
        const { wrapper, model, definition } = render(type);
        const original = structuredClone(model);
        const payload = value(model, definition.definitionId).value;
        expect(wrapper.text()).toContain(labels.presence[value(model, definition.definitionId).presence]);
        if ([0, 7].includes(type))
            expect(wrapper.getComponent(FsusUiInput).props('modelValue')).toBe(payload?.type === 0 ? payload.text : payload?.type === 7 ? payload.url : '');
        else if (type === 1 || type === 3)
        {
            const expected = payload?.type === 1 ? formatArticlePropertyExactDecimal(payload.number)
                : payload?.type === 3 ? formatArticlePropertyUtcTicks(payload.utc) : null;
            expect(expected?.ok).toBe(true);
            expect(wrapper.getComponent(FsusUiInput).props('modelValue')).toBe(expected?.ok ? expected.value : '');
            expect(wrapper.getComponent(FsusUiInput).props('type')).toBe('text');
        }
        else if (type === 2)
            expect(wrapper.getComponent(FsusUiSwitch).props('modelValue')).toBe(payload?.type === 2 && payload.boolean);
        else if ([4, 5].includes(type))
        {
            expect(valueSelect(wrapper).props('modelValue')).toEqual(payload?.type === 4 ? payload.optionId : payload?.type === 5 ? payload.optionIds : undefined);
            expect(valueSelect(wrapper).props('filterable')).toBe(false);
            expect(valueSelect(wrapper).props('allowCreate')).toBe(false);
        }
        else
        {
            expect(wrapper.findAll('input, textarea, [role="switch"], [role="combobox"]')).toHaveLength(0);
            expect(wrapper.text()).toContain(labels.editorUnavailable);
            expect(wrapper.text()).not.toContain('9007199254740993');
        }
        expect(button(wrapper, 'Save').props('disabled')).toBe(true);
        expect(Object.keys(wrapper.emitted()).filter((name) => !['input', 'change', 'click'].includes(name))).toEqual([]);
        expect(model).toEqual(original);
    });

    it.each([0, 7])('stages exact type %i strings, marks them unvalidated and cancels with stale event rejection', async (type) =>
    {
        const { wrapper, model } = render(type);
        const original = structuredClone(model);
        const oldText = wrapper.getComponent(FsusUiInput).props('modelValue');
        const oldHandler = inputHandler(wrapper);
        // Emit directly to avoid native single-line URL input newline sanitization.
        wrapper.getComponent(FsusUiInput).vm.$emit('update:modelValue', '  <script>private</script>\n');
        await nextTick();
        expect(wrapper.getComponent(FsusUiInput).props('modelValue')).toBe('  <script>private</script>\n');
        expect(wrapper.text()).toContain(labels.unvalidated);
        await button(wrapper, 'Cancel').trigger('click');
        oldHandler('late-from-cancelled-control');
        await nextTick();
        expect(wrapper.getComponent(FsusUiInput).props('modelValue')).toBe(oldText);
        expect(wrapper.text()).not.toContain(labels.unvalidated);
        expect(model).toEqual(original);
        expect(Object.keys(wrapper.emitted()).filter((name) => !['input', 'change', 'click'].includes(name))).toEqual([]);
    });

    it('retains false and rejects boolean string coercion', async () =>
    {
        const { wrapper, model, definition } = render(2);
        const initial = value(model, definition.definitionId).value;
        wrapper.getComponent(FsusUiSwitch).vm.$emit('update:modelValue', true);
        await nextTick();
        wrapper.getComponent(FsusUiSwitch).vm.$emit('update:modelValue', 'false');
        await nextTick();
        expect(wrapper.getComponent(FsusUiSwitch).props('modelValue')).toBe(true);
        wrapper.getComponent(FsusUiSwitch).vm.$emit('update:modelValue', false);
        await nextTick();
        expect(wrapper.getComponent(FsusUiSwitch).props('modelValue')).toBe(false);
        await button(wrapper, 'Cancel').trigger('click');
        expect(wrapper.getComponent(FsusUiSwitch).props('modelValue')).toBe(initial?.type === 2 && initial.boolean);
        expect(value(model, definition.definitionId).value).toEqual(initial);
    });

    it.each([4, 5])('preserves type %i missing selected IDs and disabled deprecated/deleted options', async (type) =>
    {
        const { wrapper, model, definition } = render(type);
        const changed = structuredClone(model);
        const missingId = '11111111-1111-4111-8111-111111111111';
        value(changed, definition.definitionId).value = type === 4 ? { type: 4, optionId: missingId } : { type: 5, optionIds: [missingId] };
        changed.definitions = changed.definitions.map((item) => item.definitionId === definition.definitionId
            ? { ...item, options: item.options.map((option, index) => ({ ...option, status: index === 0 ? 1 as const : 2 as const })) } : item);
        await wrapper.setProps({ model: changed });
        const options = valueSelect(wrapper).props('options');
        expect(options.every((item) => 'disabled' in item && item.disabled)).toBe(true);
        expect(options.find((item) => 'value' in item && item.value === missingId)?.label).toBe(labels.unknownOption);
        expect(valueSelect(wrapper).props('modelValue')).toEqual(type === 4 ? missingId : [missingId]);
        valueSelect(wrapper).vm.$emit('update:modelValue', type === 4 ? 42 : [42]);
        await nextTick();
        expect(wrapper.text()).not.toContain(labels.unvalidated);
    });

    it.each([0, 1, 2, 3, 4, 5, 6, 7])('shows safe server reconciliation %i', async (status) =>
    {
        const { wrapper, model, definition } = render();
        const changed = structuredClone(model);
        changed.reconciliation = [{ definitionId: definition.definitionId, status: status as 0, reasonCode: 'private-value-secret' }];
        await wrapper.setProps({ model: changed });
        expect(wrapper.text()).toContain(labels.reconciliation[status]);
        expect(wrapper.text()).not.toContain('private-value-secret');
        expect(wrapper.getComponent(FsusUiInput).props('disabled')).toBe([1, 2, 3, 5].includes(status));
        expect(wrapper.find('textarea').attributes('aria-invalid')).toBe(String([4, 6].includes(status)));
        expect(button(wrapper, 'Save').props('disabled')).toBe(true);
    });

    it.each([0, 1, 2])('distinguishes presence %i, empty text, required and server-applied default', async (presence) =>
    {
        const { wrapper, model, definition } = render();
        const changed = structuredClone(model);
        Object.assign(value(changed, definition.definitionId), { presence, value: presence === 2 ? { type: 0, text: '' } : null, defaultApplied: presence !== 0 });
        changed.definitions = changed.definitions.map((item) => item.definitionId === definition.definitionId ? { ...item, required: true } : item);
        await wrapper.setProps({ model: changed });
        expect(wrapper.find('[data-presence]').attributes('data-presence')).toBe(String(presence));
        expect(wrapper.text()).toContain(labels.presence[presence]);
        expect(wrapper.text()).toContain(labels.required);
        expect(wrapper.text().includes(labels.defaultApplied)).toBe(presence !== 0);
        expect(wrapper.getComponent(FsusUiInput).props('modelValue')).toBe('');
    });


    it('keeps staging unavailable without canonical reconciliation', async () =>
    {
        const { wrapper, model } = render();
        await wrapper.setProps({ model: { ...model, reconciliation: [] } });
        inputHandler(wrapper)('unverified-candidate');
        await nextTick();
        expect(wrapper.getComponent(FsusUiInput).props('disabled')).toBe(true);
        expect(wrapper.text()).toContain(labels.reconciliation[1]);
        expect(wrapper.text()).not.toContain(labels.unvalidated);
    });

    it.each([4, 5])('stages type %i stable IDs and cancels without mutating canonical selections', async (type) =>
    {
        const { wrapper, model, definition } = render(type);
        const before = structuredClone(value(model, definition.definitionId));
        const ids = definition.options.map((option) => option.optionId);
        valueSelect(wrapper).vm.$emit('update:modelValue', type === 4 ? ids[0] : ids);
        await nextTick();
        expect(valueSelect(wrapper).props('modelValue')).toEqual(type === 4 ? ids[0] : ids);
        expect(wrapper.text()).toContain(labels.unvalidated);
        await button(wrapper, 'Cancel').trigger('click');
        expect(value(model, definition.definitionId)).toEqual(before);
        expect(wrapper.text()).not.toContain(labels.unvalidated);
    });

    it.each([1, 2])('blocks definition lifecycle status %i without hiding its stored field', async (status) =>
    {
        const { wrapper, model, definition } = render();
        await wrapper.setProps({ model: { ...model, definitions: model.definitions.map((item) => item.definitionId === definition.definitionId
            ? { ...item, status: status as 1 } : item) } });
        inputHandler(wrapper)('late-inactive');
        await nextTick();
        expect(wrapper.getComponent(FsusUiInput).props('disabled')).toBe(true);
        expect(wrapper.text()).toContain(labels.reconciliation[2]);
        expect(wrapper.text()).not.toContain(labels.unvalidated);
    });

    it('refuses URL side effects and reference disclosure', async () =>
    {
        const fetch = vi.spyOn(globalThis, 'fetch');
        const open = vi.spyOn(window, 'open');
        const storage = vi.spyOn(Storage.prototype, 'setItem');
        const { wrapper } = render(7);
        await wrapper.getComponent(FsusUiInput).find('input').setValue('javascript:alert("private")');
        expect(wrapper.getComponent(FsusUiInput).props('modelValue')).toBe('javascript:alert("private")');
        expect(wrapper.findAll('a, iframe, img, script')).toHaveLength(0);
        expect(button(wrapper, 'Save').props('disabled')).toBe(true);
        const reference = render(6).wrapper;
        expect(reference.findAll('a, input, textarea')).toHaveLength(0);
        expect(reference.text()).toContain(labels.editorUnavailable);
        expect(fetch).not.toHaveBeenCalled();
        expect(open).not.toHaveBeenCalled();
        expect(storage).not.toHaveBeenCalled();
    });
});

describe('ArticleMetadataField cancellation and stale callback negatives', () =>
{
    it.each([
        ['article', { articleId: 8 }], ['document', { documentId: 'other' }], ['epoch', { documentEpoch: 2 }],
        ['session', { editorSessionId: 'other' }], ['site', { siteScope: 'site:other' }], ['user', { userScope: 'user:43' }],
        ['draft', { draftId: 'other' }], ['draft revision', { draftRevision: '51' }]
    ])('withdraws same-model fields after %s switch and ignores captured handlers', async (_name, changed) =>
    {
        const { wrapper, model } = render();
        const oldHandler = inputHandler(wrapper);
        await wrapper.find('textarea').setValue('unsubmitted-private');
        await wrapper.setProps({ context: { ...context(), ...changed } });
        oldHandler('late-event');
        await nextTick();
        expect(wrapper.findAll('input, textarea')).toHaveLength(0);
        expect(wrapper.text()).toBe(labels.unavailable);
        if (!('articleId' in changed) && !('draftRevision' in changed))
        {
            await wrapper.setProps({ model: structuredClone(model) });
            expect(wrapper.find('textarea').exists()).toBe(true);
            expect(wrapper.getComponent(FsusUiInput).props('modelValue')).not.toBe('late-event');
        }
    });

    it.each([
        ['read permission', { enabled: false }], ['binding release', { context: null }], ['owner', { definitionOwnerUserId: '43' }],
        ['refresh', { readKey: 'permission-2' }], ['loading', { model: null }], ['unknown definition', { definitionId: 'unknown' }]
    ])('withdraws old data and callbacks after %s', async (_name, changed) =>
    {
        const { wrapper } = render();
        const oldHandler = inputHandler(wrapper);
        await wrapper.find('textarea').setValue('private-staged-value');
        await wrapper.setProps(changed);
        oldHandler('late-private-value');
        await nextTick();
        expect(wrapper.text()).toBe(labels.unavailable);
        expect(wrapper.findAll('input, textarea')).toHaveLength(0);
        expect(Object.keys(wrapper.emitted()).filter((name) => !['input', 'change', 'click'].includes(name))).toEqual([]);
    });

    it('requires a fresh canonical model after permission restoration', async () =>
    {
        const { wrapper, model } = render();
        await wrapper.setProps({ enabled: false });
        await wrapper.setProps({ enabled: true });
        expect(wrapper.text()).toBe(labels.unavailable);
        await wrapper.setProps({ model: structuredClone(model) });
        expect(wrapper.find('textarea').exists()).toBe(true);
    });

    it('write permission loss resets input and refuses old handlers', async () =>
    {
        const { wrapper } = render();
        const original = wrapper.getComponent(FsusUiInput).props('modelValue');
        const oldHandler = inputHandler(wrapper);
        await wrapper.find('textarea').setValue('pending');
        await wrapper.setProps({ editable: false });
        oldHandler('late-pending');
        await nextTick();
        expect(wrapper.getComponent(FsusUiInput).props('modelValue')).toBe(original);
        expect(wrapper.getComponent(FsusUiInput).props('disabled')).toBe(true);
        expect(button(wrapper, 'Cancel').props('disabled')).toBe(true);
    });

    it.each(['article', 'property', 'definition', 'digest', 'snapshot', 'option'])('discards input on canonical %s refresh', async (change) =>
    {
        const { wrapper, model, definition } = render();
        const original = wrapper.getComponent(FsusUiInput).props('modelValue');
        const oldHandler = inputHandler(wrapper);
        await wrapper.find('textarea').setValue('pending');
        const changed = structuredClone(model);
        if (change === 'article') changed.currentArticleRevisionId = '9007199254740994';
        if (change === 'property') changed.propertyRevision = '9007199254740994';
        if (change === 'snapshot' && changed.current) changed.current.snapshotId = '22222222-2222-4222-8222-222222222222';
        if (['definition', 'digest', 'option'].includes(change))
            changed.definitions = changed.definitions.map((item) => item.definitionId === definition.definitionId
                ? { ...item, schemaRevision: change === 'definition' ? '2' : item.schemaRevision,
                    contentDigest: change === 'digest' ? 'f'.repeat(64) : item.contentDigest,
                    options: change === 'option' ? [] : item.options } : item);
        await wrapper.setProps({ model: changed });
        oldHandler('late-pending');
        await nextTick();
        expect(wrapper.getComponent(FsusUiInput).props('modelValue')).toBe(original);
        expect(wrapper.text()).not.toContain(labels.unvalidated);
        if (['definition', 'digest'].includes(change))
        {
            expect(wrapper.getComponent(FsusUiInput).props('disabled')).toBe(true);
            expect(wrapper.text()).toContain(labels.conflict);
        }
    });

    it('keeps pending metadata and focus when only body revision/digests change', async () =>
    {
        const { wrapper } = render();
        const input = wrapper.find('textarea');
        (input.element as HTMLTextAreaElement).focus();
        await input.setValue('pending');
        await wrapper.setProps({ context: { ...wrapper.props('context')!, sourceRevision: 99, contentDigest: 'body-change', contextDigest: 'body-context-change' } });
        expect(wrapper.getComponent(FsusUiInput).props('modelValue')).toBe('pending');
        expect(document.activeElement).toBe(input.element);
    });


    it('returns keyboard focus to the current public control after user cancellation', async () =>
    {
        const { wrapper } = render();
        await wrapper.find('textarea').setValue('pending');
        const cancel = button(wrapper, 'Cancel');
        (cancel.element as HTMLButtonElement).focus();
        await cancel.trigger('click');
        expect(document.activeElement).toBe(wrapper.find('textarea').element);
    });

    it.each(['external-focus', 'permission', 'revision', 'unmount'])('refuses cancel focus return after %s invalidation', async (change) =>
    {
        const { wrapper, model } = render();
        await wrapper.find('textarea').setValue('pending');
        const cancel = button(wrapper, 'Cancel');
        (cancel.element as HTMLButtonElement).focus();
        // Native dispatch allows synchronous owner changes before nextTick.
        cancel.element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const external = document.createElement('button');
        external.textContent = 'Owner focus';
        document.body.append(external);
        external.focus();
        if (change === 'permission') await wrapper.setProps({ enabled: false });
        if (change === 'revision') await wrapper.setProps({ model: structuredClone(model) });
        if (change === 'unmount') wrapper.unmount();
        await nextTick();
        expect(document.activeElement).toBe(external);
    });

    it('captured controls cannot act after unmount', async () =>
    {
        const { wrapper, model } = render();
        const original = structuredClone(model);
        const oldHandler = inputHandler(wrapper);
        wrapper.unmount();
        oldHandler('late-after-unmount');
        await nextTick();
        expect(model).toEqual(original);
        expect(Object.keys(wrapper.emitted()).filter((name) => !['input', 'change', 'click'].includes(name))).toEqual([]);
    });
});


describe('ArticleMetadataField canonical presence staging and lossless typed buffers', () =>
{
    it.each([0, 1, 2, 3, 4, 5, 7])('stages missing/null for type %i without erasing the typed buffer or Server facts', async (type) =>
    {
        const { wrapper, model } = render(type);
        const before = structuredClone(model);
        const original = [0, 1, 3, 7].includes(type) ? wrapper.getComponent(FsusUiInput).props('modelValue')
            : type === 2 ? wrapper.getComponent(FsusUiSwitch).props('modelValue') : valueSelect(wrapper).props('modelValue');
        const currentValue = (): unknown => [0, 1, 3, 7].includes(type) ? wrapper.getComponent(FsusUiInput).props('modelValue')
            : type === 2 ? wrapper.getComponent(FsusUiSwitch).props('modelValue') : valueSelect(wrapper).props('modelValue');
        for (const presence of [0, 1])
        {
            presenceSelect(wrapper).vm.$emit('update:modelValue', presence);
            await nextTick();
            expect(presenceSelect(wrapper).props('modelValue')).toBe(presence);
            const typedControl = [0, 1, 3, 7].includes(type) ? wrapper.getComponent(FsusUiInput)
                : type === 2 ? wrapper.getComponent(FsusUiSwitch) : valueSelect(wrapper);
            expect(typedControl.vm.$props.disabled).toBe(true);
            const typedHandler = typedControl.vm.$.vnode.props?.['onUpdate:modelValue'];
            if (typeof typedHandler !== 'function') throw new Error('missing typed listener');
            typedHandler(type === 2 ? true : type === 5 ? ['tampered'] : 'tampered');
            await nextTick();
            expect(currentValue()).toEqual(original);
            expect(wrapper.text()).toContain(labels.unvalidated);
            expect(button(wrapper, 'Save').props('disabled')).toBe(true);
            // Server presence/default/reconciliation remain visibly unchanged.
            expect(wrapper.find('[data-presence]').attributes('data-presence')).toBe('2');
            expect(model).toEqual(before);
            presenceSelect(wrapper).vm.$emit('update:modelValue', 2);
            await nextTick();
            expect(currentValue()).toEqual(original);
            expect(typedControl.vm.$props.disabled).toBe(false);
            await button(wrapper, 'Cancel').trigger('click');
            expect(presenceSelect(wrapper).props('modelValue')).toBe(2);
            expect(wrapper.text()).not.toContain(labels.unvalidated);
        }
    });

    it.each([0, 1, 2])('restores observed Server presence %i after an unsubmitted toggle and cancel', async (presence) =>
    {
        const { wrapper, model, definition } = render();
        const changed = structuredClone(model);
        Object.assign(value(changed, definition.definitionId), { presence, value: presence === 2 ? { type: 0, text: '' } : null,
            defaultApplied: false });
        await wrapper.setProps({ model: changed });
        const before = structuredClone(changed);
        expect(presenceSelect(wrapper).props('modelValue')).toBe(presence);
        expect(wrapper.getComponent(FsusUiInput).props('disabled')).toBe(presence !== 2);
        presenceSelect(wrapper).vm.$emit('update:modelValue', presence === 2 ? 0 : 2);
        await nextTick();
        const cancel = button(wrapper, 'Cancel');
        (cancel.element as HTMLButtonElement).focus();
        await cancel.trigger('click');
        expect(presenceSelect(wrapper).props('modelValue')).toBe(presence);
        expect(changed).toEqual(before);
        expect(wrapper.getComponent(FsusUiInput).props('modelValue')).toBe('');
        if (presence !== 2)
        {
            expect(document.activeElement).toBe(presenceSelect(wrapper).get('[role="combobox"]').element);
            expect(cancel.props('disabled')).toBe(false);
        }
    });

    it.each(['0', false, undefined, null, -1, 3, NaN, { value: 0 }])('rejects noncanonical UI presence payload %j without coercion', async (candidate) =>
    {
        const { wrapper } = render();
        presenceSelect(wrapper).vm.$emit('update:modelValue', candidate);
        await nextTick();
        expect(presenceSelect(wrapper).props('modelValue')).toBe(2);
        expect(wrapper.text()).not.toContain(labels.unvalidated);
    });

    it('preserves false, empty text and empty option sets across presence round trips', async () =>
    {
        for (const type of [0, 2, 5])
        {
            const { wrapper, model, definition } = render(type);
            const changed = structuredClone(model);
            value(changed, definition.definitionId).value = type === 0 ? { type: 0, text: '' }
                : type === 2 ? { type: 2, boolean: false } : { type: 5, optionIds: [] };
            await wrapper.setProps({ model: changed });
            const before = structuredClone(changed);
            presenceSelect(wrapper).vm.$emit('update:modelValue', 1);
            await nextTick();
            presenceSelect(wrapper).vm.$emit('update:modelValue', 2);
            await nextTick();
            await button(wrapper, 'Cancel').trigger('click');
            expect(changed).toEqual(before);
            if (type === 0) expect(wrapper.getComponent(FsusUiInput).props('modelValue')).toBe('');
            if (type === 2) expect(wrapper.getComponent(FsusUiSwitch).props('modelValue')).toBe(false);
            if (type === 5) expect(valueSelect(wrapper).props('modelValue')).toEqual([]);
        }
    });

    it.each(['cancel', 'permission', 'context', 'revision', 'unmount'])('refuses captured presence callbacks after %s', async (change) =>
    {
        const { wrapper, model } = render();
        const handler = presenceSelect(wrapper).vm.$.vnode.props?.['onUpdate:modelValue'];
        if (typeof handler !== 'function') throw new Error('missing real presence listener');
        presenceSelect(wrapper).vm.$emit('update:modelValue', 1);
        await nextTick();
        if (change === 'cancel') await button(wrapper, 'Cancel').trigger('click');
        if (change === 'permission') await wrapper.setProps({ editable: false });
        if (change === 'context') await wrapper.setProps({ context: { ...wrapper.props('context')!, editorSessionId: 'next' } });
        if (change === 'revision') await wrapper.setProps({ model: { ...model, propertyRevision: '2' } });
        if (change === 'unmount') wrapper.unmount();
        handler(0);
        await nextTick();
        if (change === 'context') expect(wrapper.text()).toBe(labels.unavailable);
        else if (change !== 'unmount')
        {
            expect(presenceSelect(wrapper).props('modelValue')).toBe(2);
            expect(wrapper.text()).not.toContain(labels.unvalidated);
        }
    });

    it('does not apply a definition default, normalize or validate a missing candidate locally', async () =>
    {
        const { wrapper, model, definition } = render();
        const changed = structuredClone(model);
        value(changed, definition.definitionId).presence = 0;
        value(changed, definition.definitionId).value = null;
        changed.definitions = changed.definitions.map((item) => item.definitionId === definition.definitionId
            ? { ...item, required: true, presence: { missing: 1, null: 1, empty: 2 },
                defaultValue: { kind: 2, value: { type: 0, text: 'private-default' } } } : item);
        await wrapper.setProps({ model: changed });
        presenceSelect(wrapper).vm.$emit('update:modelValue', 2);
        await nextTick();
        expect(wrapper.getComponent(FsusUiInput).props('modelValue')).toBe('');
        expect(wrapper.text()).not.toContain('private-default');
        expect(wrapper.text()).not.toContain(labels.defaultApplied);
        expect(wrapper.text()).toContain(labels.unvalidated);
        expect(button(wrapper, 'Save').props('disabled')).toBe(true);
        expect(value(changed, definition.definitionId).presence).toBe(0);
    });
});


describe('ArticleMetadataField public control labels', () =>
{
    it.each([0, 1, 2, 3, 4, 5, 7])('labels the real type %i presence combobox through its public label prop', (type) =>
    {
        const { wrapper } = render(type);
        const id = presenceSelect(wrapper).props('label');
        if (!id) throw new Error('missing public presence label ID');
        expect(document.getElementById(id)?.textContent).toBe(labels.presenceLabel);
        expect(presenceSelect(wrapper).find('[role="combobox"]').attributes('aria-labelledby')).toBe(id);
        if (type === 4 || type === 5)
        {
            const valueId = valueSelect(wrapper).props('label');
            if (!valueId) throw new Error('missing public typed label ID');
            expect(document.getElementById(valueId)?.textContent).toContain('property_');
            expect(valueSelect(wrapper).find('[role="combobox"]').attributes('aria-labelledby')).toBe(valueId);
        }
    });
});


describe('ArticleMetadataField released exact editors preserve canonical wire precision', () =>
{
    it.each([
        { lo: 4294967295, mid: 4294967295, hi: 4294967295, scale: 0, negative: false },
        { lo: 4294967295, mid: 4294967295, hi: 4294967295, scale: 28, negative: true },
        { lo: 0, mid: 0, hi: 0, scale: 28, negative: true }
    ])('preserves every decimal96 limb, scale and sign through the real codec and exact editor', async (number) =>
    {
        const { wrapper, model, definition } = render(1);
        const changed = structuredClone(model);
        value(changed, definition.definitionId).value = { type: 1, number };
        // Wire shape witness only, not a persisted/authenticated value receipt.
        const decoded = decodeArticlePropertyValueReadResponse(encodeArticlePropertyValueReadResponse(changed));
        expect(value(decoded, definition.definitionId).value).toEqual({ type: 1, number });
        const before = structuredClone(decoded);
        await wrapper.setProps({ model: decoded });
        const text = wrapper.getComponent(FsusUiInput).props('modelValue');
        expect(parseArticlePropertyExactDecimal(String(text))).toEqual({ ok: true, value: number });
        expect(wrapper.text()).not.toContain(labels.editorUnavailable);
        expect(button(wrapper, 'Save').props('disabled')).toBe(true);
        expect(decoded).toEqual(before);
    });

    it.each(['0', '638954208000000001', '3155378975999999999'])('preserves UTC tick string %s with sub-millisecond precision through the canonical codec', async (utc) =>
    {
        const { wrapper, model, definition } = render(3);
        const changed = structuredClone(model);
        value(changed, definition.definitionId).value = { type: 3, utc };
        const decoded = decodeArticlePropertyValueReadResponse(encodeArticlePropertyValueReadResponse(changed));
        expect(value(decoded, definition.definitionId).value).toEqual({ type: 3, utc });
        await wrapper.setProps({ model: decoded });
        expect(parseArticlePropertyUtcTicks(String(wrapper.getComponent(FsusUiInput).props('modelValue')))).toEqual({ ok: true, value: utc });
        expect(wrapper.text()).not.toContain(labels.editorUnavailable);
        expect(value(decoded, definition.definitionId).value).toEqual({ type: 3, utc });
    });

    it.each([1, 3])('retains missing/null exact type %i without converting it to zero or a date', async (type) =>
    {
        const { wrapper, model, definition } = render(type);
        for (const presence of [0, 1] as const)
        {
            const changed = structuredClone(model);
            Object.assign(value(changed, definition.definitionId), { presence, value: null, defaultApplied: false });
            const decoded = decodeArticlePropertyValueReadResponse(encodeArticlePropertyValueReadResponse(changed));
            await wrapper.setProps({ model: decoded });
            expect(value(decoded, definition.definitionId).presence).toBe(presence);
            expect(value(decoded, definition.definitionId).value).toBeNull();
            expect(wrapper.find('[data-presence]').attributes('data-presence')).toBe(String(presence));
            expect(wrapper.getComponent(FsusUiInput).props('modelValue')).toBe('');
            expect(wrapper.getComponent(FsusUiInput).props('disabled')).toBe(true);
            expect(wrapper.text()).not.toContain(labels.editorUnavailable);
        }
    });

    it.each([
        { type: 1 as const, number: { lo: 4294967296, mid: 0, hi: 0, scale: 0, negative: false } },
        { type: 1 as const, number: { lo: 1, mid: 0, hi: 0, scale: 29, negative: false } },
        { type: 3 as const, utc: '-1' },
        { type: 3 as const, utc: '3155378976000000000' }
    ])('lets the existing canonical codec reject out-of-range payload %j rather than clipping it', (payload) =>
    {
        const { model, definition } = render(payload.type);
        const changed = structuredClone(model);
        value(changed, definition.definitionId).value = payload;
        expect(() => encodeArticlePropertyValueReadResponse(changed)).toThrow(RangeError);
    });
});

describe('ArticleMetadataField on-demand readonly definition summary', () =>
{
    const copy = labels.definitionSummary;
    async function expand(wrapper: ReturnType<typeof mount>)
    {
        const details = wrapper.get('details');
        (details.element as HTMLDetailsElement).open = !(details.element as HTMLDetailsElement).open;
        await details.trigger('toggle');
    }
    function displayed(wrapper: ReturnType<typeof mount>, key: string)
    {
        return wrapper.get(`[data-definition-flag="${key}"]`).text();
    }

    it.each([0, 1, 2, 3, 4, 5, 6, 7])('lazily projects the actual descriptor for type %i without changing typed values', async (type) =>
    {
        const { wrapper, model, definition } = render(type);
        const original = structuredClone(model);
        const controls = wrapper.findAll('input, textarea, [role="switch"]');
        expect(wrapper.find('dl').exists()).toBe(false);
        expect(wrapper.get('summary').attributes('aria-expanded')).toBe('false');
        expect(wrapper.get('summary').attributes('aria-controls')).toBeUndefined();
        await expand(wrapper);
        const list = wrapper.get('dl');
        expect(wrapper.get('summary').attributes('aria-controls')).toBe(list.attributes('id'));
        expect(wrapper.get('summary').attributes('aria-expanded')).toBe('true');
        expect(list.findAll('dt')).toHaveLength(9);
        expect(list.findAll('dd')).toHaveLength(9);
        expect(list.findAll('input, button, select, textarea, a')).toHaveLength(0);
        expect(displayed(wrapper, 'searchEligible')).toBe(definition.searchEligible ? copy.yes : copy.no);
        expect(displayed(wrapper, 'filterable')).toBe(definition.filterable ? copy.yes : copy.no);
        expect(displayed(wrapper, 'sortable')).toBe(definition.sortable ? copy.yes : copy.no);
        expect(displayed(wrapper, 'required')).toBe(definition.required ? copy.yes : copy.no);
        for (const [key, names, code] of [
            ['missing', copy.missingBehavior, definition.presence.missing],
            ['null', copy.nullBehavior, definition.presence.null],
            ['empty', copy.emptyBehavior, definition.presence.empty],
            ['visibilityScope', copy.visibility, definition.visibilityScope],
            ['displayPlacement', copy.placement, definition.displayPlacement]
        ] as const)
            expect(displayed(wrapper, key)).toBe(`${names[code]} (${code})`);
        expect(wrapper.findAll('input, textarea, [role="switch"]').map((item) => item.element)).toEqual(controls.map((item) => item.element));
        await expand(wrapper);
        expect(wrapper.find('dl').exists()).toBe(false);
        expect(model).toEqual(original);
        expect(button(wrapper, 'Save').props('disabled')).toBe(true);
        expect(Object.keys(wrapper.emitted()).filter((name) => !['input', 'change', 'click'].includes(name))).toEqual([]);
    });

    it('distinguishes false, zero, absent, null and unknown without displaying malformed private data', async () =>
    {
        const { wrapper, model, definition } = render();
        const changed = structuredClone(model);
        const descriptor = changed.definitions.find((item) => item.definitionId === definition.definitionId)!;
        Object.assign(descriptor, { searchEligible: false, filterable: undefined, sortable: null, required: 'private-malformed',
            presence: { missing: 0, null: 99, empty: undefined }, visibilityScope: { private: 'secret-descriptor' }, displayPlacement: 99 });
        await wrapper.setProps({ model: changed });
        const original = structuredClone(changed);
        await expand(wrapper);
        expect(displayed(wrapper, 'searchEligible')).toBe(copy.no);
        expect(displayed(wrapper, 'filterable')).toBe(copy.absent);
        expect(displayed(wrapper, 'sortable')).toBe(copy.nullValue);
        expect(displayed(wrapper, 'required')).toBe(copy.unknown);
        expect(displayed(wrapper, 'missing')).toBe('Preserve missing (0)');
        expect(displayed(wrapper, 'null')).toBe('Unknown (99)');
        expect(displayed(wrapper, 'empty')).toBe(copy.absent);
        expect(displayed(wrapper, 'visibilityScope')).toBe(copy.unknown);
        expect(displayed(wrapper, 'displayPlacement')).toBe('Unknown (99)');
        expect(wrapper.text()).not.toContain('private-malformed');
        expect(wrapper.text()).not.toContain('secret-descriptor');
        expect(changed).toEqual(original);
    });

    it('does not infer validation, grants or editing capability from descriptor flags', async () =>
    {
        const { wrapper, model, definition } = render();
        const changed = structuredClone(model);
        Object.assign(changed.definitions.find((item) => item.definitionId === definition.definitionId)!, {
            searchEligible: true, filterable: true, sortable: true, required: true,
            presence: { missing: 1, null: 1, empty: 2 }, visibilityScope: 2, displayPlacement: 0
        });
        await wrapper.setProps({ model: changed, editable: false });
        await expand(wrapper);
        expect(displayed(wrapper, 'visibilityScope')).toBe('Site readers (2)');
        expect(displayed(wrapper, 'displayPlacement')).toBe('Hidden (0)');
        expect(wrapper.getComponent(FsusUiInput).props('disabled')).toBe(true);
        expect(presenceSelect(wrapper).props('disabled')).toBe(true);
        expect(button(wrapper, 'Save').props('disabled')).toBe(true);
        expect(displayed(wrapper, 'missing')).toBe('Apply default (1)');
        expect(value(changed, definition.definitionId)).toEqual(value(model, definition.definitionId));
    });

    it.each([0, 1, 2] as const)('displays policy code %i exactly without applying it to the value', async (code) =>
    {
        const { wrapper, model, definition } = render();
        const changed = structuredClone(model);
        Object.assign(changed.definitions.find((item) => item.definitionId === definition.definitionId)!, {
            presence: { missing: code === 2 ? 0 : code, null: code === 2 ? 0 : code, empty: code },
            visibilityScope: code, displayPlacement: code
        });
        await wrapper.setProps({ model: changed });
        await expand(wrapper);
        expect(displayed(wrapper, 'empty')).toBe(`${copy.emptyBehavior[code]} (${code})`);
        expect(displayed(wrapper, 'visibilityScope')).toBe(`${copy.visibility[code]} (${code})`);
        expect(displayed(wrapper, 'displayPlacement')).toBe(`${copy.placement[code]} (${code})`);
        const binaryCode = code === 2 ? 0 : code;
        expect(displayed(wrapper, 'missing')).toBe(`${copy.missingBehavior[binaryCode]} (${binaryCode})`);
        expect(displayed(wrapper, 'null')).toBe(`${copy.nullBehavior[binaryCode]} (${binaryCode})`);
        expect(value(changed, definition.definitionId)).toEqual(value(model, definition.definitionId));
    });

    it('cannot extend closed code meanings through extra caller labels or fill absent policy values', async () =>
    {
        const { wrapper, model, definition } = render();
        const changed = structuredClone(model);
        Object.assign(changed.definitions.find((item) => item.definitionId === definition.definitionId)!, {
            presence: undefined, visibilityScope: 3, displayPlacement: 3
        });
        await wrapper.setProps({ model: changed, labels: { ...labels, definitionSummary: { ...copy,
            visibility: [...copy.visibility, 'invented visibility'], placement: [...copy.placement, 'invented placement'] } } });
        await expand(wrapper);
        for (const key of ['missing', 'null', 'empty']) expect(displayed(wrapper, key)).toBe(copy.absent);
        expect(displayed(wrapper, 'visibilityScope')).toBe('Unknown (3)');
        expect(displayed(wrapper, 'displayPlacement')).toBe('Unknown (3)');
        expect(wrapper.text()).not.toContain('invented');
    });

    it('preserves staged input, presence and cancellation while opening or closing the summary', async () =>
    {
        const { wrapper } = render();
        const observed = wrapper.getComponent(FsusUiInput).props('modelValue');
        wrapper.getComponent(FsusUiInput).vm.$emit('update:modelValue', 'exact pending');
        await nextTick();
        presenceSelect(wrapper).vm.$emit('update:modelValue', 1);
        await nextTick();
        await expand(wrapper);
        await expand(wrapper);
        expect(presenceSelect(wrapper).props('modelValue')).toBe(1);
        expect(wrapper.getComponent(FsusUiInput).props('modelValue')).toBe('exact pending');
        expect(wrapper.text()).toContain(labels.unvalidated);
        await expand(wrapper);
        await button(wrapper, 'Cancel').trigger('click');
        expect(wrapper.getComponent(FsusUiInput).props('modelValue')).toBe(observed);
        expect(presenceSelect(wrapper).props('modelValue')).toBe(2);
        expect(wrapper.find('dl').exists()).toBe(true);
    });

    it('keeps toggle focus stable and has distinct control IDs for sibling fields', async () =>
    {
        const model = response();
        const parent = mount({ render: () => h('div', model.definitions.slice(0, 2).map((definition) => h(ArticleMetadataField, {
            model, definitionId: definition.definitionId, definitionOwnerUserId: '42', context: context(),
            enabled: true, editable: true, readKey: 'permission-1', locale: 'en-US', labels
        }))) }, { attachTo: document.body });
        wrappers.push(parent);
        const [first, second] = parent.findAllComponents(ArticleMetadataField);
        const toggle = first.get('summary').element as HTMLElement;
        toggle.focus();
        await expand(first);
        expect(document.activeElement).toBe(toggle);
        await expand(second);
        expect(first.get('dl').attributes('id')).not.toBe(second.get('dl').attributes('id'));
        await expand(first);
        expect(document.activeElement).toBe(toggle);
        expect(first.find('dl').exists()).toBe(false);
    });

    it.each(['model', 'definition', 'context', 'grant', 'readKey', 'editable'])('withdraws expanded summary after %s changes', async (change) =>
    {
        const { wrapper, model } = render();
        await expand(wrapper);
        if (change === 'model') await wrapper.setProps({ model: structuredClone(model) });
        if (change === 'definition') await wrapper.setProps({ definitionId: model.definitions[2].definitionId });
        if (change === 'context') await wrapper.setProps({ context: { ...context(), editorSessionId: 'new-session' } });
        if (change === 'grant') await wrapper.setProps({ enabled: false });
        if (change === 'readKey') await wrapper.setProps({ readKey: 'new-grant' });
        if (change === 'editable') await wrapper.setProps({ editable: false });
        expect(wrapper.find('dl').exists()).toBe(false);
        if (['context', 'grant', 'readKey'].includes(change))
            expect(wrapper.text()).not.toContain(copy.toggle);
        else
            expect(wrapper.get('summary').attributes('aria-expanded')).toBe('false');
    });

    it('ignores a queued toggle from a withdrawn disclosure after a fresh read', async () =>
    {
        const { wrapper, model } = render();
        await expand(wrapper);
        const previous = wrapper.get('details').element as HTMLDetailsElement;
        await wrapper.setProps({ enabled: false });
        await wrapper.setProps({ enabled: true });
        await wrapper.setProps({ model: structuredClone(model) });
        expect(wrapper.get('details').element).not.toBe(previous);
        previous.open = true;
        previous.dispatchEvent(new Event('toggle'));
        await nextTick();
        expect(wrapper.find('dl').exists()).toBe(false);
        expect(wrapper.get('summary').attributes('aria-expanded')).toBe('false');
    });

    it('uses caller localization reactively and escapes display text', async () =>
    {
        const { wrapper } = render();
        await expand(wrapper);
        await wrapper.setProps({ locale: 'zh-CN', labels: { ...labels, definitionSummary: { ...copy,
            toggle: '定义标志与策略', searchEligible: '作者搜索', no: '否', missingBehavior: ['保留缺失', '使用默认值'],
            placement: ['隐藏', '<script>display-copy</script>', '侧栏'] } } });
        expect(wrapper.get('summary').text()).toBe('定义标志与策略');
        expect(wrapper.get('dl').text()).toContain('作者搜索');
        expect(wrapper.find('script').exists()).toBe(false);
        expect(wrapper.find('dl').exists()).toBe(true);
    });
});

describe('ArticleMetadataField exact numeric and UTC staging', () =>
{
    it.each([
        [1, '-7.9228162514264337593543950335', '0.00000000000000000000000000000', 'scale-range'],
        [3, '9999-12-31T23:59:59.9999999Z', '1900-02-29T00:00:00.0000000Z', 'calendar-range']
    ] as const)('stages type %i exact text and localized structural errors without Server validation or writes', async (type, valid, invalid, error) =>
    {
        const { wrapper, model } = render(type);
        const before = structuredClone(model);
        const control = wrapper.getComponent(FsusUiInput);
        const original = control.props('modelValue');
        expect(control.props('type')).toBe('text');
        expect(control.get('input').attributes('inputmode')).toBe(type === 1 ? 'decimal' : 'text');
        control.vm.$emit('update:modelValue', valid);
        await nextTick();
        expect(control.props('modelValue')).toBe(valid);
        expect(wrapper.text()).toContain(labels.unvalidated);
        expect(control.get('input').attributes('aria-invalid')).toBe('false');
        expect(model).toEqual(before);
        const previous = inputHandler(wrapper);
        control.vm.$emit('update:modelValue', invalid);
        await nextTick();
        expect(control.props('modelValue')).toBe(invalid);
        expect(control.get('input').attributes('aria-invalid')).toBe('true');
        expect(wrapper.text()).toContain(labels.exactEditErrors[error]);
        const description = control.get('input').attributes('aria-describedby');
        if (!description) throw new Error('missing actual input description');
        const ids = description.split(' ');
        expect(ids.every((id) => document.getElementById(id))).toBe(true);
        expect(ids.map((id) => document.getElementById(id)?.textContent).join(' ')).toContain(labels.exactEditErrors[error]);
        presenceSelect(wrapper).vm.$emit('update:modelValue', 1);
        await nextTick();
        expect(wrapper.text()).not.toContain(labels.exactEditErrors[error]);
        expect(control.props('modelValue')).toBe(invalid);
        presenceSelect(wrapper).vm.$emit('update:modelValue', 2);
        await nextTick();
        expect(wrapper.text()).toContain(labels.exactEditErrors[error]);
        const cancel = button(wrapper, 'Cancel');
        (cancel.element as HTMLButtonElement).focus();
        await cancel.trigger('click');
        previous('late exact input');
        await nextTick();
        expect(control.props('modelValue')).toBe(original);
        expect(document.activeElement?.tagName).toBe('INPUT');
        expect(wrapper.text()).not.toContain(labels.exactEditErrors[error]);
        expect(button(wrapper, 'Save').props('disabled')).toBe(true);
        expect(model).toEqual(before);
        expect(wrapper.emitted('focusin')?.every(([event]) => event instanceof FocusEvent)).toBe(true);
        expect(wrapper.emitted('focusout')?.every(([event]) => event instanceof FocusEvent)).toBe(true);
        expect(Object.keys(wrapper.emitted()).filter((name) => !['input', 'change', 'click', 'focusin', 'focusout'].includes(name))).toEqual([]);
    });

    it.each([1, 3])('does not use definition constraints or defaults to normalize exact type %i staging', async (type) =>
    {
        const { wrapper, model, definition } = render(type);
        const changed = structuredClone(model);
        Object.assign(changed.definitions.find((item) => item.definitionId === definition.definitionId)!, {
            required: true, presence: { missing: 1, null: 1, empty: 2 }
        });
        Object.assign(value(changed, definition.definitionId), { presence: 0, value: null, defaultApplied: false });
        await wrapper.setProps({ model: changed });
        const before = structuredClone(changed);
        presenceSelect(wrapper).vm.$emit('update:modelValue', 2);
        await nextTick();
        expect(wrapper.getComponent(FsusUiInput).props('modelValue')).toBe('');
        expect(wrapper.text()).toContain(labels.exactEditErrors.syntax);
        expect(value(changed, definition.definitionId).value).toBeNull();
        expect(changed).toEqual(before);
    });

    it.each([1, 3])('withdraws exact type %i pending input and structural errors on schema/context changes', async (type) =>
    {
        const { wrapper, model, definition } = render(type);
        wrapper.getComponent(FsusUiInput).vm.$emit('update:modelValue', 'private-not-a-number-or-time');
        await nextTick();
        expect(wrapper.text()).toContain(labels.exactEditErrors.syntax);
        const changed = structuredClone(model);
        changed.definitions.find((item) => item.definitionId === definition.definitionId)!.schemaRevision = '2';
        await wrapper.setProps({ model: changed });
        expect(wrapper.getComponent(FsusUiInput).props('modelValue')).not.toBe('private-not-a-number-or-time');
        expect(wrapper.text()).not.toContain(labels.exactEditErrors.syntax);
        await wrapper.setProps({ context: { ...context(), editorSessionId: 'withdrawn' } });
        expect(wrapper.text()).toBe(labels.unavailable);
    });
});

describe('ArticleMetadataField consumes released SelectV2 public focus contract', () =>
{
    it.each([4, 5])('returns cancellation focus through the real type %i public expose', async (type) =>
    {
        const { wrapper, model } = render(type);
        const original = structuredClone(model);
        valueSelect(wrapper).vm.$emit('update:modelValue', type === 4 ? 'pending-option' : ['pending-option']);
        await nextTick();
        const publicControl = valueSelect(wrapper);
        const focus = vi.spyOn(publicControl.vm, 'focus');
        const cancel = button(wrapper, 'Cancel');
        (cancel.element as HTMLButtonElement).focus();
        await cancel.trigger('click');
        expect(focus).toHaveBeenCalledOnce();
        expect(document.activeElement).toBe(publicControl.get('[role="combobox"]').element);
        expect(model).toEqual(original);
        expect(button(wrapper, 'Save').props('disabled')).toBe(true);
    });

    it('executes actual public presence focus/blur and consumes real option/listbox roles', async () =>
    {
        const { wrapper } = render();
        const selector = presenceSelect(wrapper);
        selector.vm.focus();
        await nextTick();
        expect(document.activeElement).toBe(selector.get('[role="combobox"]').element);
        await selector.get('[role="combobox"]').trigger('keydown', { code: 'ArrowDown' });
        await nextTick();
        const listboxId = selector.get('[role="combobox"]').attributes('aria-controls');
        expect(listboxId).toBeTruthy();
        const listbox = document.getElementById(listboxId!);
        expect(listbox?.getAttribute('role')).toBe('listbox');
        const options = listbox?.querySelectorAll('[role="option"]');
        expect(options?.length).toBe(3);
        expect(Array.from(options ?? []).map((item) => item.textContent?.trim())).toEqual(labels.presence);
        selector.vm.blur();
        await nextTick();
        expect(selector.get('[role="combobox"]').attributes('aria-expanded')).toBe('false');
        expect(document.activeElement).not.toBe(selector.get('[role="combobox"]').element);
    });

    it.each([0, 1, 2, 3, 4, 5, 7])('returns Missing and Null type %i focus through public presence focus without erasing facts', async (type) =>
    {
        const { wrapper, model, definition } = render(type);
        for (const presence of [0, 1] as const)
        {
            const changed = structuredClone(model);
            Object.assign(value(changed, definition.definitionId), { presence, value: null, defaultApplied: false });
            await wrapper.setProps({ model: changed });
            const before = structuredClone(changed);
            presenceSelect(wrapper).vm.$emit('update:modelValue', 2);
            await nextTick();
            const selector = presenceSelect(wrapper);
            const focus = vi.spyOn(selector.vm, 'focus');
            const cancel = button(wrapper, 'Cancel');
            (cancel.element as HTMLButtonElement).focus();
            await cancel.trigger('click');
            expect(focus).toHaveBeenCalledOnce();
            focus.mockRestore();
            expect(document.activeElement).toBe(selector.get('[role="combobox"]').element);
            expect(selector.props('modelValue')).toBe(presence);
            expect(changed).toEqual(before);
        }
    });

    it.each([4, 5])('refuses type %i public focus return after permission/revision/external focus changes', async (type) =>
    {
        for (const change of ['external', 'permission', 'revision', 'unmount'])
        {
            const { wrapper, model } = render(type);
            const selector = valueSelect(wrapper);
            const focus = vi.spyOn(selector.vm, 'focus');
            const cancel = button(wrapper, 'Cancel');
            (cancel.element as HTMLButtonElement).focus();
            cancel.element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            const external = document.createElement('button');
            document.body.append(external);
            external.focus();
            if (change === 'permission') await wrapper.setProps({ enabled: false });
            if (change === 'revision') await wrapper.setProps({ model: structuredClone(model) });
            if (change === 'unmount') wrapper.unmount();
            await nextTick();
            expect(focus).not.toHaveBeenCalled();
            expect(document.activeElement).toBe(external);
        }
    });
});
