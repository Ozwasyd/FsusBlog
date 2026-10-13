import { describe, it, expect } from 'vitest'
import { createMarkdownEditorProjection, createMarkdownSourceCoordinateMap, stabilizeMarkdownEditorProjection } from '@ozwasyd/element-plus/markdown-runtime'
describe('public projection capability only; no Vault merge/admission', () => {
    it.each([
        ['heading', '\uFEFF# Secret 😀\r\n'],
        ['list', '- Secret 😀\r\n- Two\r\n'],
        ['table', '| A | B |\r\n|---|---|\r\n| Secret 😀 | Two |\r\n'],
        ['code', '```js\r\nconst secret = "😀";\r\n```\r\n']
    ])('exposes original %s ranges and exact UTF8 endpoints', (kind, source) => {
        const projection = createMarkdownEditorProjection(source)
        const coordinates = createMarkdownSourceCoordinateMap(source)
        const nodes = projection.nodes.filter(node => node.kind === kind)
        expect(nodes.length).toBeGreaterThan(0)
        for (const node of nodes) {
            expect(node.blockIdentity).not.toBe('')
            expect(node.rawRange.start).toBeGreaterThanOrEqual(0)
            expect(node.rawRange.end).toBeLessThanOrEqual(source.length)
            expect(coordinates.toRawUtf8Offset(node.rawRange.start)).toBe(new TextEncoder().encode(source.slice(0, node.rawRange.start)).length)
            expect(coordinates.toRawUtf8Offset(node.rawRange.end)).toBe(new TextEncoder().encode(source.slice(0, node.rawRange.end)).length)
        }
    })
    it('tombstones an edited heading and preserves the unaffected heading through an explicit edit', () => {
        const before = '# First\n\n# Second\n'
        const previous = stabilizeMarkdownEditorProjection(createMarkdownEditorProjection(before), { id: 'finite-probe', epoch: 1 })
        const current = stabilizeMarkdownEditorProjection(createMarkdownEditorProjection('# Changed\n\n# Second\n'), { id: 'finite-probe', epoch: 1 }, previous, { from: 2, to: 7, insert: 'Changed' })
        const oldHeadings = previous.nodes.filter(node => node.kind === 'heading')
        const newHeadings = current.nodes.filter(node => node.kind === 'heading')
        expect(newHeadings[0].id).not.toBe(oldHeadings[0].id)
        expect(current.resolve(oldHeadings[0].id).status).toBe('deleted')
        expect(newHeadings[1].id).toBe(oldHeadings[1].id)
    })
    it('exposes malformed fence as a parser refusal', () => {
        expect(createMarkdownEditorProjection('```js\nsecret\n').nodes.some(node => node.status !== 'valid')).toBe(true)
    })
})
