import assert from 'node:assert/strict';
import test from 'node:test';
import { auditBinaryRouteCalls } from './binary-route-call-audit.mjs';
const operations = new Set(['binary_get_category', 'binary_get_auth_me', 'binary_get_admin_article']);
const check = source => auditBinaryRouteCalls(source, 'worker.ts', operations);

test('accepts generated requests through imported aliases', () => {
    assert.deepEqual(check(`import {requestBinaryOnly as load} from '@/composition/binaryTransport'; load({binaryRoute:{operationId:'binary_get_category'},frameType:1});`), []);
});
for (const [name, source] of [
    ['absolute URL', `requestBinaryOnly({binaryUrl:'https://evil.example',frameType:1})`],
    ['binary URL', `requestBinaryOnly({binaryUrl:'/api/binary/category',frameType:1})`],
    ['unknown operation', `requestBinaryOnly({binaryRoute:{operationId:'binary_missing'},frameType:1})`],
    ['admin credentials', `requestBinaryOnly({binaryRoute:{operationId:'binary_get_admin_article'},requestOptions:{credentials:'omit'},frameType:1})`],
    ['manual scope', `requestBinaryOnly({binaryRoute:{operationId:'binary_get_auth_me'},privateScope:'public',frameType:1})`],
    ['renamed escape', `requestBinaryOnly({binaryRoute:{operationId:'binary_get_category',resourceUrl:'/api/binary/custom'},frameType:1})`],
    ['new wrapper', `function requestBinaryUrl(url:string){ return fetch(url) }`],
    ['direct fetch', `fetch('/api/binary/category')`],
    ['aliased direct fetch', `const prefix='/api/binary'; const path=prefix+'/category'; fetch(path)`],
    ['renamed fetch', `const load=fetch;load('/api/binary/category')`],
    ['property fetch alias', `const load=globalThis.fetch;load('/api/binary/category')`],
    ['generic resource wrapper', `function loadResource(url:string){return fetch(url)};loadResource('/api/binary/category')`],
    ['raw import alias', `import {binaryRequest as load} from '@/api/binaryApiClient';load('/api/binary/category')`],
    ['missing descriptor', `requestBinaryOnly({frameType:1})`]
]) test(`rejects ${name}`, () => assert.ok(check(source).length > 0));

test('rejects raw paths passed to a typed operation helper', () => {
    assert.ok(auditBinaryRouteCalls(`import { requestAuthoringBinary as load } from './authoring'; load('/api/binary/custom');`, 'api.ts', operations,
        { routeCallNames: new Set(['requestAuthoringBinary']) }).length > 0);
});
test('rejects non-imported aliases of requestBinaryOnly', () => {
    assert.ok(check(`const load=requestBinaryOnly; load({url:'https://evil.example',frameType:1})`).length > 0);
});
