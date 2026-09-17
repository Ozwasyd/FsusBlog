import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeRuntimeStateAccess } from '../../tools/test-matrix/runtime-state-domain-catalog.mjs'
test('analyzer identifies independent database Redis and fixture access', () => assert.deepEqual(analyzeRuntimeStateAccess('psql postgres -c "SELECT 1"\nredis-cli scan\nrm -rf fixture'), ['fixture.public-content','postgres.schema','redis.cache.public']))
test('analyzer does not make host topology access conflict-free', () => assert.notDeepEqual(analyzeRuntimeStateAccess('docker run --network host'), []))
