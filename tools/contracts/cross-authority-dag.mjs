#!/usr/bin/env node

/**
 * Cross-authority DAG analyzer for the terminal Behavior governance chain.
 *
 * Edges point from an authority or evidence producer to its consumer. The
 * analyzer is deliberately independent from the test matrix scheduler: it
 * validates the authority layers that the scheduler and release finalizer
 * consume, but it never executes a producer or discovers an input by mtime.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const authorityDagSchema = 'fsusblog.cross-authority-dag.v1'
export const authorityDagReceiptSchema = 'fsusblog.cross-authority-dag-receipt.v1'

const digestPattern = /^[a-f0-9]{64}$/u
const stableIdPattern = /^[a-z][a-z0-9]*(?:[.:/-][a-z0-9][a-z0-9.-]*)*$/u
const behaviorIdPattern = /^[a-z][a-z0-9-]*$/u

export const authorityLayers = Object.freeze({
  'behavior-catalog': 0,
  'implementation-owner': 1,
  'fact-extractor': 2,
  'document-evidence-producer': 3,
  'test-evidence-producer': 3,
  'mutation-evidence-producer': 4,
  'pre-runtime-joiner': 5,
  'runtime-evidence-producer': 6,
  'post-runtime-joiner': 7,
  'release-finalizer': 8
})

const requiredSingletonKinds = Object.freeze([
  'behavior-catalog',
  'pre-runtime-joiner',
  'post-runtime-joiner',
  'release-finalizer'
])

const requiredKinds = Object.freeze(Object.keys(authorityLayers))

const requiredPredecessorKinds = Object.freeze({
  'behavior-catalog': [],
  'implementation-owner': ['behavior-catalog'],
  'fact-extractor': ['behavior-catalog', 'implementation-owner'],
  'document-evidence-producer': ['implementation-owner', 'fact-extractor'],
  'test-evidence-producer': ['implementation-owner', 'fact-extractor'],
  'mutation-evidence-producer': ['implementation-owner', 'test-evidence-producer'],
  'pre-runtime-joiner': [
    'document-evidence-producer',
    'test-evidence-producer',
    'mutation-evidence-producer'
  ],
  'runtime-evidence-producer': ['pre-runtime-joiner'],
  'post-runtime-joiner': ['pre-runtime-joiner', 'runtime-evidence-producer'],
  'release-finalizer': ['pre-runtime-joiner', 'post-runtime-joiner']
})

const relationByKinds = new Map([
  ['behavior-catalog\0implementation-owner', 'declares-owner'],
  ['behavior-catalog\0fact-extractor', 'declares-extractor'],
  ['implementation-owner\0fact-extractor', 'exposes-implementation'],
  ['implementation-owner\0document-evidence-producer', 'binds-document-evidence'],
  ['fact-extractor\0document-evidence-producer', 'produces-document-facts'],
  ['implementation-owner\0test-evidence-producer', 'binds-test-evidence'],
  ['fact-extractor\0test-evidence-producer', 'produces-test-facts'],
  ['implementation-owner\0mutation-evidence-producer', 'binds-mutation-evidence'],
  ['test-evidence-producer\0mutation-evidence-producer', 'produces-mutation-evidence'],
  ['document-evidence-producer\0pre-runtime-joiner', 'seals-pre-runtime'],
  ['test-evidence-producer\0pre-runtime-joiner', 'seals-pre-runtime'],
  ['mutation-evidence-producer\0pre-runtime-joiner', 'seals-pre-runtime'],
  ['pre-runtime-joiner\0runtime-evidence-producer', 'admits-runtime'],
  ['pre-runtime-joiner\0post-runtime-joiner', 'supplies-pre-runtime'],
  ['runtime-evidence-producer\0post-runtime-joiner', 'seals-post-runtime'],
  ['pre-runtime-joiner\0release-finalizer', 'supplies-pre-runtime'],
  ['post-runtime-joiner\0release-finalizer', 'supplies-post-runtime']
])

const graphKeys = Object.freeze([
  'schema',
  'digestAlgorithm',
  'canonicalSerialization',
  'nodes',
  'edges'
])
const nodeKeys = Object.freeze(['id', 'kind', 'authorityId', 'behaviorIds'])
const edgeKeys = Object.freeze(['from', 'to', 'relation'])

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const fail = (message) =>
{
  throw new Error(`[cross-authority-dag] ${message}`)
}

function stable (value)
{
  if (Array.isArray(value)) return value.map(stable)
  if (!isPlainObject(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
}

export const canonicalizeAuthorityDagValue = (value) => JSON.stringify(stable(value))

export const digestAuthorityDagValue = (value) => createHash('sha256')
  .update(canonicalizeAuthorityDagValue(value), 'utf8')
  .digest('hex')

function exactKeys (value, keys, label)
{
  if (!isPlainObject(value)) fail(`${label} must be an object`)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.join('\0') !== expected.join('\0'))
  {
    fail(`${label} fields must be exactly ${expected.join(', ')}`)
  }
}

function normalizeBehaviorIds (values, label)
{
  if (!Array.isArray(values) || values.length === 0)
  {
    fail(`${label} must be a non-empty behavior ID list`)
  }
  const normalized = values.map((value) => String(value))
  if (normalized.some((value) => !behaviorIdPattern.test(value)))
  {
    fail(`${label} contains an invalid behavior ID`)
  }
  if (new Set(normalized).size !== normalized.length)
  {
    fail(`${label} contains duplicate behavior IDs`)
  }
  return normalized.sort()
}

export function normalizeAuthorityDag (graph)
{
  exactKeys(graph, graphKeys, 'graph')
  if (graph.schema !== authorityDagSchema
    || graph.digestAlgorithm !== 'sha256'
    || graph.canonicalSerialization !== 'json-utf8-v1')
  {
    fail('graph identity contract is invalid')
  }
  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0)
  {
    fail('graph.nodes must be a non-empty list')
  }
  if (!Array.isArray(graph.edges) || graph.edges.length === 0)
  {
    fail('graph.edges must be a non-empty list')
  }

  const nodes = graph.nodes.map((node, index) =>
  {
    exactKeys(node, nodeKeys, `node[${index}]`)
    if (!stableIdPattern.test(String(node.id ?? ''))) fail(`node[${index}].id is invalid`)
    if (!Object.hasOwn(authorityLayers, node.kind)) fail(`node ${node.id} has unknown kind ${node.kind}`)
    if (typeof node.authorityId !== 'string' || node.authorityId.length === 0 || /\s/u.test(node.authorityId))
    {
      fail(`node ${node.id} authorityId is invalid`)
    }
    return {
      id: node.id,
      kind: node.kind,
      authorityId: node.authorityId,
      behaviorIds: normalizeBehaviorIds(node.behaviorIds, `node ${node.id}.behaviorIds`)
    }
  }).sort((left, right) => left.id.localeCompare(right.id))

  const edges = graph.edges.map((edge, index) =>
  {
    exactKeys(edge, edgeKeys, `edge[${index}]`)
    if (!stableIdPattern.test(String(edge.from ?? '')) || !stableIdPattern.test(String(edge.to ?? '')))
    {
      fail(`edge[${index}] endpoints are invalid`)
    }
    if (!stableIdPattern.test(String(edge.relation ?? '')))
    {
      fail(`edge[${index}].relation is invalid`)
    }
    return { from: edge.from, to: edge.to, relation: edge.relation }
  }).sort((left, right) =>
  {
    const from = left.from.localeCompare(right.from)
    if (from !== 0) return from
    const to = left.to.localeCompare(right.to)
    return to !== 0 ? to : left.relation.localeCompare(right.relation)
  })

  return {
    schema: authorityDagSchema,
    digestAlgorithm: 'sha256',
    canonicalSerialization: 'json-utf8-v1',
    nodes,
    edges
  }
}

function reachableFrom (start, adjacency)
{
  const visited = new Set()
  const pending = [start]
  while (pending.length > 0)
  {
    const current = pending.pop()
    if (visited.has(current)) continue
    visited.add(current)
    for (const next of adjacency.get(current) ?? []) pending.push(next)
  }
  return visited
}

function stronglyConnectedComponents (nodeIds, adjacency)
{
  let nextIndex = 0
  const indexByNode = new Map()
  const lowLinkByNode = new Map()
  const stack = []
  const onStack = new Set()
  const components = []

  const visit = (nodeId) =>
  {
    indexByNode.set(nodeId, nextIndex)
    lowLinkByNode.set(nodeId, nextIndex)
    nextIndex += 1
    stack.push(nodeId)
    onStack.add(nodeId)

    for (const target of adjacency.get(nodeId) ?? [])
    {
      if (!indexByNode.has(target))
      {
        visit(target)
        lowLinkByNode.set(nodeId, Math.min(lowLinkByNode.get(nodeId), lowLinkByNode.get(target)))
      }
      else if (onStack.has(target))
      {
        lowLinkByNode.set(nodeId, Math.min(lowLinkByNode.get(nodeId), indexByNode.get(target)))
      }
    }

    if (lowLinkByNode.get(nodeId) !== indexByNode.get(nodeId)) return
    const component = []
    while (stack.length > 0)
    {
      const member = stack.pop()
      onStack.delete(member)
      component.push(member)
      if (member === nodeId) break
    }
    components.push(component.sort())
  }

  for (const nodeId of [...nodeIds].sort())
  {
    if (!indexByNode.has(nodeId)) visit(nodeId)
  }
  return components.sort((left, right) => left.join('\0').localeCompare(right.join('\0')))
}

function pushFailure (failures, code, ...parts)
{
  failures.add([code, ...parts].join(':'))
}

export function analyzeAuthorityDag (input)
{
  const graph = normalizeAuthorityDag(input)
  const failures = new Set()
  const nodesById = new Map()
  const nodesByKind = new Map(requiredKinds.map((kind) => [kind, []]))
  const authorityOwners = new Map()

  for (const node of graph.nodes)
  {
    if (nodesById.has(node.id)) pushFailure(failures, 'duplicate-node', node.id)
    else nodesById.set(node.id, node)
    nodesByKind.get(node.kind).push(node)
    const owners = authorityOwners.get(node.authorityId) ?? []
    owners.push(node.id)
    authorityOwners.set(node.authorityId, owners)
  }

  for (const kind of requiredKinds)
  {
    if (nodesByKind.get(kind).length === 0) pushFailure(failures, 'missing-node-kind', kind)
  }
  for (const kind of requiredSingletonKinds)
  {
    if (nodesByKind.get(kind).length > 1) pushFailure(failures, 'multiple-node-kind', kind)
  }

  const duplicateAuthorities = [...authorityOwners.entries()]
    .filter(([, nodeIds]) => nodeIds.length > 1)
    .map(([authorityId, nodeIds]) => ({ authorityId, nodeIds: [...nodeIds].sort() }))
    .sort((left, right) => left.authorityId.localeCompare(right.authorityId))
  for (const duplicate of duplicateAuthorities)
  {
    pushFailure(failures, 'duplicate-authority', duplicate.authorityId, duplicate.nodeIds.join(','))
  }

  const catalogBehaviors = new Set(nodesByKind.get('behavior-catalog').flatMap((node) => node.behaviorIds))
  for (const node of graph.nodes)
  {
    for (const behaviorId of node.behaviorIds)
    {
      if (!catalogBehaviors.has(behaviorId)) pushFailure(failures, 'unknown-behavior', node.id, behaviorId)
    }
  }

  const adjacency = new Map([...nodesById.keys()].map((id) => [id, []]))
  const reverseAdjacency = new Map([...nodesById.keys()].map((id) => [id, []]))
  const incoming = new Map([...nodesById.keys()].map((id) => [id, []]))
  const edgeKeysSeen = new Set()
  const selfLoops = []
  const backEdges = []
  const invalidEdges = []

  for (const edge of graph.edges)
  {
    const edgeKey = `${edge.from}\0${edge.to}\0${edge.relation}`
    if (edgeKeysSeen.has(edgeKey)) pushFailure(failures, 'duplicate-edge', edge.from, edge.to, edge.relation)
    edgeKeysSeen.add(edgeKey)
    const source = nodesById.get(edge.from)
    const target = nodesById.get(edge.to)
    if (!source || !target)
    {
      pushFailure(failures, 'missing-endpoint', edge.from, edge.to)
      continue
    }
    adjacency.get(source.id).push(target.id)
    reverseAdjacency.get(target.id).push(source.id)
    incoming.get(target.id).push(source)
    if (source.id === target.id)
    {
      selfLoops.push({ ...edge })
      pushFailure(failures, 'self-loop', source.id, edge.relation)
    }
    if (authorityLayers[source.kind] >= authorityLayers[target.kind])
    {
      backEdges.push({ ...edge, fromLayer: authorityLayers[source.kind], toLayer: authorityLayers[target.kind] })
      pushFailure(failures, 'back-edge', source.id, target.id)
    }
    const expectedRelation = relationByKinds.get(`${source.kind}\0${target.kind}`)
    if (edge.relation !== expectedRelation)
    {
      invalidEdges.push({ ...edge, expectedRelation: expectedRelation ?? null })
      pushFailure(failures, 'invalid-edge', source.id, target.id, edge.relation)
    }
    if (!source.behaviorIds.some((behaviorId) => target.behaviorIds.includes(behaviorId)))
    {
      pushFailure(failures, 'behavior-disconnected-edge', source.id, target.id)
    }
  }

  const missingEdges = []
  for (const node of graph.nodes)
  {
    for (const behaviorId of node.behaviorIds)
    {
      const behaviorPredecessorKinds = new Set((incoming.get(node.id) ?? [])
        .filter((entry) => entry.behaviorIds.includes(behaviorId))
        .map((entry) => entry.kind))
      for (const requiredKind of requiredPredecessorKinds[node.kind])
      {
        if (behaviorPredecessorKinds.has(requiredKind)) continue
        const missing = { nodeId: node.id, behaviorId, predecessorKind: requiredKind }
        missingEdges.push(missing)
        pushFailure(failures, 'missing-predecessor', node.id, behaviorId, requiredKind)
      }
    }
  }

  const missingBehaviorLayers = []
  for (const behaviorId of [...catalogBehaviors].sort())
  {
    for (const kind of requiredKinds)
    {
      if (nodesByKind.get(kind).some((node) => node.behaviorIds.includes(behaviorId))) continue
      missingBehaviorLayers.push({ behaviorId, kind })
      pushFailure(failures, 'missing-behavior-layer', behaviorId, kind)
    }
  }

  const components = stronglyConnectedComponents(nodesById.keys(), adjacency)
  const cyclicComponents = components.filter((component) => component.length > 1)
  for (const component of cyclicComponents)
  {
    pushFailure(failures, 'scc', component.join(','))
  }

  const catalogNode = nodesByKind.get('behavior-catalog').length === 1
    ? nodesByKind.get('behavior-catalog')[0]
    : null
  const finalizerNode = nodesByKind.get('release-finalizer').length === 1
    ? nodesByKind.get('release-finalizer')[0]
    : null
  const reachableFromCatalog = catalogNode ? reachableFrom(catalogNode.id, adjacency) : new Set()
  const canReachFinalizer = finalizerNode ? reachableFrom(finalizerNode.id, reverseAdjacency) : new Set()
  const orphanNodeIds = graph.nodes
    .filter((node) => !reachableFromCatalog.has(node.id) || !canReachFinalizer.has(node.id))
    .map((node) => node.id)
    .sort()
  for (const nodeId of orphanNodeIds) pushFailure(failures, 'orphan', nodeId)

  const behaviorOrphans = []
  if (catalogNode && finalizerNode)
  {
    for (const behaviorId of [...catalogBehaviors].sort())
    {
      const behaviorAdjacency = new Map([...nodesById.keys()].map((id) => [id, []]))
      const behaviorReverseAdjacency = new Map([...nodesById.keys()].map((id) => [id, []]))
      for (const edge of graph.edges)
      {
        const source = nodesById.get(edge.from)
        const target = nodesById.get(edge.to)
        if (!source || !target
          || !source.behaviorIds.includes(behaviorId)
          || !target.behaviorIds.includes(behaviorId)) continue
        behaviorAdjacency.get(source.id).push(target.id)
        behaviorReverseAdjacency.get(target.id).push(source.id)
      }
      const behaviorReachableFromCatalog = catalogNode.behaviorIds.includes(behaviorId)
        ? reachableFrom(catalogNode.id, behaviorAdjacency)
        : new Set()
      const behaviorCanReachFinalizer = finalizerNode.behaviorIds.includes(behaviorId)
        ? reachableFrom(finalizerNode.id, behaviorReverseAdjacency)
        : new Set()
      for (const node of graph.nodes)
      {
        if (!node.behaviorIds.includes(behaviorId)) continue
        if (behaviorReachableFromCatalog.has(node.id) && behaviorCanReachFinalizer.has(node.id)) continue
        behaviorOrphans.push({ behaviorId, nodeId: node.id })
        pushFailure(failures, 'behavior-orphan', behaviorId, node.id)
      }
    }
  }

  if (catalogNode && (incoming.get(catalogNode.id) ?? []).length !== 0)
  {
    pushFailure(failures, 'catalog-has-predecessor', catalogNode.id)
  }
  if (finalizerNode && (adjacency.get(finalizerNode.id) ?? []).length !== 0)
  {
    pushFailure(failures, 'finalizer-has-successor', finalizerNode.id)
  }

  const graphDigest = digestAuthorityDagValue(graph)
  const failureReasons = [...failures].sort()
  const payload = {
    schema: authorityDagReceiptSchema,
    graphSchema: authorityDagSchema,
    graphDigest,
    nodes: graph.nodes.map((node) => ({ ...node, layer: authorityLayers[node.kind] })),
    edges: graph.edges,
    stronglyConnectedComponents: cyclicComponents,
    selfLoops: selfLoops.sort((left, right) => left.from.localeCompare(right.from)),
    duplicateAuthorities,
    orphanNodeIds,
    behaviorOrphans: behaviorOrphans.sort((left, right) =>
      `${left.behaviorId}\0${left.nodeId}`.localeCompare(`${right.behaviorId}\0${right.nodeId}`)),
    missingBehaviorLayers: missingBehaviorLayers.sort((left, right) =>
      `${left.behaviorId}\0${left.kind}`.localeCompare(`${right.behaviorId}\0${right.kind}`)),
    missingEdges: missingEdges.sort((left, right) =>
      `${left.nodeId}\0${left.behaviorId}\0${left.predecessorKind}`
        .localeCompare(`${right.nodeId}\0${right.behaviorId}\0${right.predecessorKind}`)),
    backEdges: backEdges.sort((left, right) =>
      `${left.from}\0${left.to}`.localeCompare(`${right.from}\0${right.to}`)),
    invalidEdges: invalidEdges.sort((left, right) =>
      `${left.from}\0${left.to}\0${left.relation}`.localeCompare(`${right.from}\0${right.to}\0${right.relation}`)),
    status: failureReasons.length === 0 ? 'ok' : 'failed',
    failureReasons
  }
  return {
    ...payload,
    contentDigest: digestAuthorityDagValue(payload)
  }
}

export function assertAuthorityDag (graph)
{
  const receipt = analyzeAuthorityDag(graph)
  if (receipt.status !== 'ok')
  {
    fail(`authority graph failed: ${receipt.failureReasons.join('; ')}`)
  }
  return receipt
}

export function validateAuthorityDagReceipt (graph, receipt)
{
  if (!isPlainObject(receipt) || receipt.schema !== authorityDagReceiptSchema)
  {
    fail(`receipt schema must be ${authorityDagReceiptSchema}`)
  }
  if (!digestPattern.test(String(receipt.graphDigest ?? ''))
    || !digestPattern.test(String(receipt.contentDigest ?? '')))
  {
    fail('receipt digests are invalid')
  }
  const expected = analyzeAuthorityDag(graph)
  if (canonicalizeAuthorityDagValue(receipt) !== canonicalizeAuthorityDagValue(expected))
  {
    fail('receipt does not replay from the supplied authority graph')
  }
  if (expected.status !== 'ok')
  {
    fail('replayed authority graph is not qualified; receipt status must be ok')
  }
  return receipt
}

function parseArguments (argv)
{
  const result = { graph: null, receipt: null }
  for (let index = 0; index < argv.length; index += 1)
  {
    const argument = argv[index]
    if (argument === '--graph') result.graph = argv[++index]
    else if (argument === '--receipt') result.receipt = argv[++index]
    else fail(`unknown argument ${argument}`)
  }
  if (!result.graph) fail('--graph is required')
  return result
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
  try
  {
    const options = parseArguments(process.argv.slice(2))
    const graph = JSON.parse(readFileSync(path.resolve(options.graph), 'utf8'))
    const receipt = options.receipt
      ? validateAuthorityDagReceipt(graph, JSON.parse(readFileSync(path.resolve(options.receipt), 'utf8')))
      : assertAuthorityDag(graph)
    console.log(`[cross-authority-dag] ok nodes=${receipt.nodes.length} edges=${receipt.edges.length} digest=${receipt.contentDigest}`)
  }
  catch (error)
  {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
