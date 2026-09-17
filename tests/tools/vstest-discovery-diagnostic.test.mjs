import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseVstestDiscoveryDiagnostic,
  projectTraitMembership
} from '../../tools/test/vstest-discovery-diagnostic.mjs'

const source = '/repo/tests/backend/bin/Release/net10.0/FsusBlog.Server.Tests.dll'

function testCase(id, name, traits = []) {
  return {
    Id: id,
    FullyQualifiedName: name.replace(/\(.*/u, ''),
    DisplayName: name,
    Source: source,
    Properties: traits.length === 0 ? [] : [{
      Key: { Id: 'TestObject.Traits' },
      Value: traits.map(([Key, Value]) => ({ Key, Value }))
    }]
  }
}

function message(MessageType, Payload) {
  return `TpTrace Verbose: TestRequestHandler.SendData: sending data from testhost: ${JSON.stringify({ Version: 7, MessageType, Payload })}`
}

function diagnostic({ aborted = false, total = 3, first = null, last = null } = {}) {
  const discovered = first ?? [
    testCase('one', 'Example.Tests.Api.Case', [
      ['Category', 'ApiIntegration'],
      ['ShardAffinity', 'EndpointContractApplication'],
      ['Dependency', 'Docker']
    ]),
    testCase('two', 'Example.Tests.State.Theory(value: 1)', [['Category', 'SecurityStateMachine'], ['Category', 'Concurrency']])
  ]
  const completed = last ?? [
    testCase('three', 'Example.Tests.Golden.Case', [['Category', 'GoldenContract'], ['Category', 'Property']])
  ]
  return [
    message('TestDiscovery.TestFound', discovered),
    message('TestDiscovery.Completed', {
      TotalTests: total,
      LastDiscoveredTests: completed,
      IsAborted: aborted,
      FullyDiscoveredSources: [source],
      PartiallyDiscoveredSources: [],
      NotDiscoveredSources: [],
      SkippedDiscoverySources: []
    })
  ].join('\n')
}

test('VSTest protocol diagnostic projects adapter-authored traits from one complete discovery', () => {
  const records = parseVstestDiscoveryDiagnostic(diagnostic(), { expectedSource: source })
  assert.equal(records.length, 3)
  assert.deepEqual(records[1], {
    id: 'two',
    fullyQualifiedName: 'Example.Tests.State.Theory',
    displayName: 'Example.Tests.State.Theory(value: 1)',
    source,
    traits: { Category: ['Concurrency', 'SecurityStateMachine'] }
  })
  assert.deepEqual(projectTraitMembership(records, 'Category', [
    'ApiIntegration', 'SecurityStateMachine', 'Concurrency', 'Property', 'GoldenContract'
  ]), {
    ApiIntegration: ['Example.Tests.Api.Case'],
    SecurityStateMachine: ['Example.Tests.State.Theory(value: 1)'],
    Concurrency: ['Example.Tests.State.Theory(value: 1)'],
    Property: ['Example.Tests.Golden.Case'],
    GoldenContract: ['Example.Tests.Golden.Case']
  })
  assert.deepEqual(projectTraitMembership(records, 'ShardAffinity', ['EndpointContractApplication']), {
    EndpointContractApplication: ['Example.Tests.Api.Case']
  })
  assert.deepEqual(projectTraitMembership(records, 'Dependency', ['Docker']), {
    Docker: ['Example.Tests.Api.Case']
  })
})

test('VSTest protocol diagnostic fails closed for incomplete, aborted, duplicate and empty projections', () => {
  assert.throws(() => parseVstestDiscoveryDiagnostic('unrelated log line'), /missing TestDiscovery.Completed/u)
  assert.throws(() => parseVstestDiscoveryDiagnostic(diagnostic({ aborted: true })), /was aborted/u)
  assert.throws(() => parseVstestDiscoveryDiagnostic(diagnostic({ total: 4 })), /count mismatch/u)
  const duplicate = testCase('one', 'Example.Tests.Duplicate.Case')
  assert.throws(() => parseVstestDiscoveryDiagnostic(diagnostic({ last: [duplicate] })), /repeated test ID/u)
  const records = parseVstestDiscoveryDiagnostic(diagnostic())
  assert.throws(
    () => projectTraitMembership(records, 'Category', ['ApiIntegration', 'Missing']),
    /returned no tests for Category=Missing/u
  )
})
