import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildShardPlan,
  normalizeListedTestName,
  parseListedTests,
  parseTrxRecords,
  validateCategoryMembership,
  validateShardRecords
} from '../../tools/test/run-backend-production-shards.mjs'

test('backend production discovery normalizes theory cases to one filterable method', () => {
  assert.equal(normalizeListedTestName('Example.Tests.Rule(value: "a")'), 'Example.Tests.Rule')
  assert.equal(normalizeListedTestName('Example.Tests.Fact'), 'Example.Tests.Fact')
  assert.deepEqual(parseListedTests([
    'The following Tests are available:',
    '    Example.Tests.Fact',
    '    Example.Tests.Rule(value: "a")',
    '    Example.Tests.Rule(value: "b")',
    'Test Run Successful.'
  ].join('\n')), [
    'Example.Tests.Fact',
    'Example.Tests.Rule(value: "a")',
    'Example.Tests.Rule(value: "b")'
  ])
})

test('backend production shard plan is deterministic, mutually exclusive, and exhaustive', () => {
  const names = Array.from({ length: 40 }, (_, index) => `Example.Tests.Case${index}`)
  names.push('Example.Tests.Theory(value: 1)', 'Example.Tests.Theory(value: 2)')
  const first = buildShardPlan(names, 2)
  const second = buildShardPlan([...names].reverse(), 2)
  assert.deepEqual(first.methodsByShard, second.methodsByShard)
  assert.equal(first.testCaseCount, names.length)
  assert.equal(first.methodCounts.get('Example.Tests.Theory'), 2)
  const flattened = first.methodsByShard.flat()
  assert.equal(new Set(flattened).size, flattened.length)
  assert.deepEqual([...flattened].sort(), [...first.methodCounts.keys()].sort())
})

test('backend production shard validation rejects omissions and cross-shard execution', () => {
  const names = Array.from({ length: 30 }, (_, index) => `Example.Tests.Case${index}`)
  names.push('Example.Tests.Theory(value: 1)', 'Example.Tests.Theory(value: 2)')
  const plan = buildShardPlan(names, 2)
  const records = plan.methodsByShard.map((methods) => methods.flatMap((method) => {
    const count = plan.methodCounts.get(method)
    return Array.from({ length: count }, (_, index) => ({
      testName: count === 1 ? method : `${method}(value: ${index})`,
      outcome: 'Passed'
    }))
  }))
  assert.deepEqual(validateShardRecords(plan, records), {
    executedTestCaseCount: names.length,
    executedMethodCount: plan.methodCounts.size
  })
  assert.throws(() => validateShardRecords(plan, records.map((entries, index) => index === 0 ? entries.slice(1) : entries)), /executed .* discovery required/u)
  const foreign = records.map((entries) => [...entries])
  foreign[0][0] = { testName: plan.methodsByShard[1][0], outcome: 'Passed' }
  assert.throws(() => validateShardRecords(plan, foreign), /out-of-partition/u)
})

test('backend production TRX parser retains result names and outcomes', () => {
  const records = parseTrxRecords([
    '<TestRun><Results>',
    '<UnitTestResult testName="Example.Tests.Fact" outcome="Passed" />',
    '<UnitTestResult testName="Example.Tests.Rule(value: &quot;a&quot;)" outcome="Passed" />',
    '</Results></TestRun>'
  ].join(''))
  assert.deepEqual(records, [
    { testName: 'Example.Tests.Fact', outcome: 'Passed' },
    { testName: 'Example.Tests.Rule(value: "a")', outcome: 'Passed' }
  ])
})

test('backend production category discovery binds special tiers to methods inside the union', () => {
  const names = [
    'Example.Tests.Api',
    'Example.Tests.Auth',
    'Example.Tests.Concurrent(value: 1)',
    'Example.Tests.Concurrent(value: 2)',
    'Example.Tests.Property',
    'Example.Tests.Golden',
    'Example.Tests.Unit'
  ]
  const plan = buildShardPlan(names, 2)
  const membership = validateCategoryMembership(plan, {
    ApiIntegration: ['Example.Tests.Api'],
    SecurityStateMachine: ['Example.Tests.Auth'],
    Concurrency: ['Example.Tests.Concurrent(value: 1)', 'Example.Tests.Concurrent(value: 2)'],
    Property: ['Example.Tests.Property'],
    GoldenContract: ['Example.Tests.Golden']
  })
  assert.deepEqual(membership.Concurrency, ['Example.Tests.Concurrent'])
  assert.throws(() => validateCategoryMembership(plan, {
    ApiIntegration: ['Example.Tests.Outside'],
    SecurityStateMachine: ['Example.Tests.Auth'],
    Concurrency: ['Example.Tests.Concurrent'],
    Property: ['Example.Tests.Property'],
    GoldenContract: ['Example.Tests.Golden']
  }), /outside the production union/u)
})
