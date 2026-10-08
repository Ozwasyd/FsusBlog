// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { ElMarkdownEditor } from '@ozwasyd/element-plus';
import {
    createMarkdownAnchorMap
} from '@ozwasyd/element-plus/markdown-runtime';
import { describe, expect, it } from 'vitest';

import type {
    MarkdownEditorDispatchResult,
    MarkdownEditorTransaction
} from '@ozwasyd/element-plus';

const identity = Object.freeze({ id: 'document:anchor-boundary', epoch: 1 });

interface PublicPositionMap {
    map(offset: number, association: -1 | 1): number;
    mapRange(range: { start: number; end: number; }): {
        deleted: boolean;
        partiallyDeleted: boolean;
        range?: { start: number; end: number; };
    };
}

interface PublicEditorCommands {
    dispatchTransaction(transaction: MarkdownEditorTransaction): MarkdownEditorDispatchResult;
    undo(): MarkdownEditorDispatchResult;
    redo(): MarkdownEditorDispatchResult;
}

// This is a boundary requirement, not an implementation of a position map.
// Unknown is intentional: older public packages must fail at runtime too.
function missingPublicMapFacts(result: unknown): string[]
{
    const value = result as Record<string, unknown>;
    const map = value.positionMap as Partial<PublicPositionMap> | undefined;
    return [
        ['beforeRevision', Number.isSafeInteger(value.beforeRevision)],
        ['documentIdentity', typeof value.documentIdentity === 'object' && value.documentIdentity !== null],
        ['positionMap.map', typeof map?.map === 'function'],
        ['positionMap.mapRange', typeof map?.mapRange === 'function']
    ].filter(([, present]) => !present).map(([name]) => String(name));
}

function requirePublicMap(result: unknown): PublicPositionMap
{
    expect(missingPublicMapFacts(result), 'FsusUI #268 public dispatch result requirements').toEqual([]);
    return (result as { positionMap: PublicPositionMap; }).positionMap;
}

function openEditor(source = 'abcdef')
{
    const wrapper = mount(ElMarkdownEditor, {
        props: { modelValue: source, mode: 'source', documentIdentity: identity }
    });
    const commands = wrapper.vm as unknown as PublicEditorCommands;
    const dispatch = (changes: MarkdownEditorTransaction['changes'], expectedRevision = 0) =>
        commands.dispatchTransaction({
            changes,
            documentIdentity: identity,
            expectedRevision,
            history: 'separate',
            origin: 'programmatic'
        });
    return { wrapper, commands, dispatch };
}

describe('Article anchor public boundary (#2246)', () =>
{
    it('receives identity, before/new revision and a usable map from an actual public transaction', () =>
    {
        const editor = openEditor();
        try
        {
            const result = editor.dispatch([{ from: 0, to: 0, insert: 'X' }]);
            console.info('transaction observation', JSON.stringify(result));
            expect(result.accepted).toBe(true);
            expect(result.value).toBe('Xabcdef');
            const map = requirePublicMap(result);
            expect(result).toMatchObject({ beforeRevision: 0, revision: 1, documentIdentity: identity });
            expect(map.map(0, -1)).toBe(0);
            expect(map.map(0, 1)).toBe(1);
            expect(map.mapRange({ start: 2, end: 4 })).toEqual({
                deleted: false,
                partiallyDeleted: false,
                range: { start: 3, end: 5 }
            });

            for (const field of ['beforeRevision', 'documentIdentity', 'positionMap'])
            {
                const altered = { ...result } as Record<string, unknown>;
                delete altered[field];
                expect(missingPublicMapFacts(altered).length).toBeGreaterThan(0);
            }
            expect(missingPublicMapFacts({ ...result, positionMap: {} })).toEqual([
                'positionMap.map', 'positionMap.mapRange'
            ]);
        }
        finally
        {
            editor.wrapper.unmount();
        }
    });

    it.each([
        { label: 'partial', change: { from: 2, to: 4, insert: '' }, deleted: false, partiallyDeleted: true },
        { label: 'full', change: { from: 1, to: 5, insert: '' }, deleted: true, partiallyDeleted: false }
    ])('reports $label deletion through the committed public map', ({ change, deleted, partiallyDeleted }) =>
    {
        const editor = openEditor();
        try
        {
            const result = editor.dispatch([change]);
            expect(result.accepted).toBe(true);
            expect(requirePublicMap(result).mapRange({ start: 1, end: 5 })).toMatchObject({
                deleted, partiallyDeleted
            });
        }
        finally
        {
            editor.wrapper.unmount();
        }
    });

    it('maps multiple changes and inverse undo/redo using the same public dispatcher', () =>
    {
        const editor = openEditor();
        try
        {
            const result = editor.dispatch([
                { from: 0, to: 0, insert: 'X' },
                { from: 6, to: 6, insert: 'Y' }
            ]);
            expect(result.accepted).toBe(true);
            expect(requirePublicMap(result).mapRange({ start: 2, end: 4 }).range).toEqual({ start: 3, end: 5 });
            const undo = editor.commands.undo();
            expect(undo.accepted).toBe(true);
            expect(undo.value).toBe('abcdef');
            expect(requirePublicMap(undo).mapRange({ start: 3, end: 5 }).range).toEqual({ start: 2, end: 4 });
            const redo = editor.commands.redo();
            expect(redo.accepted).toBe(true);
            expect(requirePublicMap(redo).mapRange({ start: 2, end: 4 }).range).toEqual({ start: 3, end: 5 });
            const stale = editor.dispatch([{ from: 0, to: 0, insert: 'late' }]);
            expect(stale.accepted).toBe(false);
            expect(stale.reason).toBe('stale-revision');
        }
        finally
        {
            editor.wrapper.unmount();
        }
    });

    it.each([0, 100])('consumes semantic maps with %i headings and rejects same-source foreign epochs', (headings) =>
    {
        const source = [
            ...Array.from({ length: headings }, (_, index) => `# Heading ${index}\n`),
            'paragraph\n',
            '- list\n',
            '| a | b |\n|---|---|\n| c | d |\n',
            '```ts\nlet x = 1\n```\n',
            '![alt](https://example.test/a.png)\n',
            '```mermaid\ngraph TD; A-->B;\n```\n',
            '$$x^2$$\n'
        ].join('\n');
        const map = createMarkdownAnchorMap({ identity, source });
        const kinds = map.syntax.map(node => node.id);
        for (const kind of ['paragraph', 'list', 'table', 'code', 'image', 'mermaid', 'latex'])
        {
            expect(kinds.some(id => id.includes(`:${kind}:`)), kind).toBe(true);
        }
        for (const node of map.syntax)
        {
            expect(map.reveal({ anchorId: node.id })).toMatchObject({
                documentIdentity: identity,
                anchorId: node.id,
                range: { start: node.start, end: node.end }
            });
        }
        const visual = map.sourceSelectionToVisual({ anchor: source.length, focus: 0 });
        expect(visual.direction).toBe('backward');
        expect(map.visualAnchorToSourceSelection(visual)).toEqual({ anchor: source.length, focus: 0 });
        const other = createMarkdownAnchorMap({ identity: { ...identity, epoch: 2 }, source });
        expect(() => other.visualAnchorToSourceSelection(visual)).toThrow();
    });
});
