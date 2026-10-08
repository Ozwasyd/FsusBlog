// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { effectScope, nextTick, ref, shallowRef } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import MarkdownTextEditor from '@/components/ui/MarkdownTextEditor.vue';
import { useArticleAuthorCommandPalette } from '@/composables/useArticleAuthorCommandPalette';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach(fn => fn()));

it('consumes auto-repeated Mod+P within its active shortcut scope without re-opening', () => {
  const host = document.createElement('section');
  const textarea = document.createElement('textarea');
  host.append(textarea);
  document.body.append(host);
  const openCommandPalette = vi.fn();
  const scope = effectScope();
  scope.run(() => useArticleAuthorCommandPalette({
    editor: shallowRef({ openCommandPalette }), shortcutScope: shallowRef(host), enabled: ref(true)
  }));
  cleanup.push(() => { scope.stop(); host.remove(); });
  textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true, cancelable: true }));
  const repeated = new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, repeat: true, bubbles: true, cancelable: true });
  textarea.dispatchEvent(repeated);
  expect(openCommandPalette).toHaveBeenCalledTimes(1);
  expect(repeated.defaultPrevented).toBe(true);
});

it.each(['control', 'meta'])('consumes a second %s+P when the delegated palette owns keyboard focus', async (modifier) => {
  const host = document.createElement('section');
  document.body.append(host);
  const editor = mount(MarkdownTextEditor, { attachTo: host, props: {
    modelValue: 'Unchanged source', documentIdentity: { id: 'review:repeated', epoch: 1 },
    commandSurfaces: { commandPalette: true }
  }});
  const scope = effectScope();
  scope.run(() => useArticleAuthorCommandPalette({
    editor: shallowRef(editor.vm), shortcutScope: shallowRef(host), enabled: ref(true)
  }));
  cleanup.push(() => { editor.unmount(); scope.stop(); host.remove(); });
  const textarea = editor.get('textarea').element as HTMLTextAreaElement;
  textarea.focus();
  textarea.setSelectionRange(2, 8, 'backward');
  const options = { key: 'p', ctrlKey: modifier === 'control', metaKey: modifier === 'meta', bubbles: true, cancelable: true };
  const first = new KeyboardEvent('keydown', options);
  textarea.dispatchEvent(first);
  expect(first.defaultPrevented).toBe(true);
  await nextTick();
  const input = document.body.querySelector<HTMLInputElement>('[role="dialog"] [role="combobox"]')!;
  expect(input).toBe(document.activeElement);
  expect(host.contains(input)).toBe(false);
  const second = new KeyboardEvent('keydown', options);
  input.dispatchEvent(second);
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(document.activeElement).toBe(textarea));
  expect([textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection]).toEqual([2, 8, 'backward']);
  expect(second.defaultPrevented).toBe(true);
});
