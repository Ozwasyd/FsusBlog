import assert from 'node:assert/strict'
import { test } from 'node:test'
import { savedViewLink } from '../../src/Web/src/authoring/savedViewLink.ts'

const id = 'e50f00d1-519c-4c62-9a3d-1b513b60ee27'

test('the author route resolves only a stable UUID and the current query schema', () => {
  assert.equal(savedViewLink({}), undefined)
  assert.deepEqual(savedViewLink({ view: id.toUpperCase(), viewSchema: '1' }), { id })
  for (const bad of [{ view: id }, { viewSchema: '1' }, { view: id, viewSchema: '01' },
    { view: id, viewSchema: '2' }, { view: id, viewSchema: ['1', '1'] }, { view: [id, id], viewSchema: '1' },
    { view: id, viewSchema: '1', q: 'private' }, { view: '00000000-0000-0000-0000-000000000000', viewSchema: '1' }])
    assert.equal(savedViewLink(bad), 'invalid')
})
