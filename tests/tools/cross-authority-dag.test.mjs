import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BehaviorId } from '../../tools/contracts/behavior-contract-catalog.mjs';
import {
    analyzeAuthorityDag,
    assertAuthorityDag,
    authorityDagReceiptSchema,
    authorityDagSchema,
    authorityLayers,
    validateAuthorityDagReceipt
} from '../../tools/contracts/cross-authority-dag.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const analyzerPath = path.join(root, 'tools/contracts/cross-authority-dag.mjs');
const behaviorId = BehaviorId('browserless-production-correctness');
const secondaryBehaviorId = BehaviorId('release-final-aggregate-contract');

const node = (id, kind, authorityId, behaviorIds = [BehaviorId(behaviorId)]) => ({
    id,
    kind,
    authorityId,
    behaviorIds
});

const edge = (from, to, relation) => ({ from, to, relation });

function completeGraph ()
{
    return {
        schema: authorityDagSchema,
        digestAlgorithm: 'sha256',
        canonicalSerialization: 'json-utf8-v1',
        nodes: [
            node('catalog:behavior', 'behavior-catalog', 'config/contracts/behavior-contracts.json'),
            node('implementation:runtime', 'implementation-owner', 'src/backend/Program.cs#runtime'),
            node('extractor:test-matrix', 'fact-extractor', 'tools/fact-extractors/test-matrix/extract.mjs'),
            node('producer:document', 'document-evidence-producer', 'tools/docs/doc-claim.mjs'),
            node('producer:test', 'test-evidence-producer', 'tools/test-matrix/produce-behavior-test-evidence.mjs'),
            node('producer:mutation', 'mutation-evidence-producer', 'tools/test-matrix/produce-behavior-mutation-qualification.mjs'),
            node('joiner:pre-runtime', 'pre-runtime-joiner', 'tools/test-matrix/behavior-evidence-pre-runtime.mjs'),
            node('producer:runtime', 'runtime-evidence-producer', 'tools/run-test-matrix.mjs#production-correctness'),
            node('joiner:post-runtime', 'post-runtime-joiner', 'tools/test-matrix/behavior-evidence-post-runtime.mjs'),
            node('finalizer:release', 'release-finalizer', 'tools/test/lanes/release-final.sh')
        ],
        edges: [
            edge('catalog:behavior', 'implementation:runtime', 'declares-owner'),
            edge('catalog:behavior', 'extractor:test-matrix', 'declares-extractor'),
            edge('implementation:runtime', 'extractor:test-matrix', 'exposes-implementation'),
            edge('implementation:runtime', 'producer:document', 'binds-document-evidence'),
            edge('extractor:test-matrix', 'producer:document', 'produces-document-facts'),
            edge('implementation:runtime', 'producer:test', 'binds-test-evidence'),
            edge('extractor:test-matrix', 'producer:test', 'produces-test-facts'),
            edge('implementation:runtime', 'producer:mutation', 'binds-mutation-evidence'),
            edge('producer:test', 'producer:mutation', 'produces-mutation-evidence'),
            edge('producer:document', 'joiner:pre-runtime', 'seals-pre-runtime'),
            edge('producer:test', 'joiner:pre-runtime', 'seals-pre-runtime'),
            edge('producer:mutation', 'joiner:pre-runtime', 'seals-pre-runtime'),
            edge('joiner:pre-runtime', 'producer:runtime', 'admits-runtime'),
            edge('joiner:pre-runtime', 'joiner:post-runtime', 'supplies-pre-runtime'),
            edge('producer:runtime', 'joiner:post-runtime', 'seals-post-runtime'),
            edge('joiner:pre-runtime', 'finalizer:release', 'supplies-pre-runtime'),
            edge('joiner:post-runtime', 'finalizer:release', 'supplies-post-runtime')
        ]
    };
}

function completeTwoBehaviorGraph ()
{
    const both = [behaviorId, secondaryBehaviorId];
    return {
        schema: authorityDagSchema,
        digestAlgorithm: 'sha256',
        canonicalSerialization: 'json-utf8-v1',
        nodes: [
            node('catalog:behavior', 'behavior-catalog', 'config/contracts/behavior-contracts.json', both),
            node('implementation:runtime-a', 'implementation-owner', 'src/backend/Program.cs#runtime-a'),
            node('implementation:runtime-b', 'implementation-owner', 'src/backend/Program.cs#runtime-b', [secondaryBehaviorId]),
            node('extractor:test-matrix-a', 'fact-extractor', 'tools/fact-extractors/test-matrix/extract-a.mjs'),
            node('extractor:test-matrix-b', 'fact-extractor', 'tools/fact-extractors/test-matrix/extract-b.mjs', [secondaryBehaviorId]),
            node('producer:document-a', 'document-evidence-producer', 'tools/docs/doc-claim-a.mjs'),
            node('producer:document-b', 'document-evidence-producer', 'tools/docs/doc-claim-b.mjs', [secondaryBehaviorId]),
            node('producer:test-a', 'test-evidence-producer', 'tools/test-matrix/produce-test-a.mjs'),
            node('producer:test-b', 'test-evidence-producer', 'tools/test-matrix/produce-test-b.mjs', [secondaryBehaviorId]),
            node('producer:mutation-a', 'mutation-evidence-producer', 'tools/test-matrix/produce-mutation-a.mjs'),
            node('producer:mutation-b', 'mutation-evidence-producer', 'tools/test-matrix/produce-mutation-b.mjs', [secondaryBehaviorId]),
            node('joiner:pre-runtime', 'pre-runtime-joiner', 'tools/test-matrix/behavior-evidence-pre-runtime.mjs', both),
            node('producer:runtime-a', 'runtime-evidence-producer', 'tools/run-test-matrix.mjs#runtime-a'),
            node('producer:runtime-b', 'runtime-evidence-producer', 'tools/run-test-matrix.mjs#runtime-b', [secondaryBehaviorId]),
            node('joiner:post-runtime', 'post-runtime-joiner', 'tools/test-matrix/behavior-evidence-post-runtime.mjs', both),
            node('finalizer:release', 'release-finalizer', 'tools/test/lanes/release-final.sh', both)
        ],
        edges: [
            edge('catalog:behavior', 'implementation:runtime-a', 'declares-owner'),
            edge('catalog:behavior', 'implementation:runtime-b', 'declares-owner'),
            edge('catalog:behavior', 'extractor:test-matrix-a', 'declares-extractor'),
            edge('catalog:behavior', 'extractor:test-matrix-b', 'declares-extractor'),
            edge('implementation:runtime-a', 'extractor:test-matrix-a', 'exposes-implementation'),
            edge('implementation:runtime-b', 'extractor:test-matrix-b', 'exposes-implementation'),
            edge('implementation:runtime-a', 'producer:document-a', 'binds-document-evidence'),
            edge('implementation:runtime-b', 'producer:document-b', 'binds-document-evidence'),
            edge('extractor:test-matrix-a', 'producer:document-a', 'produces-document-facts'),
            edge('extractor:test-matrix-b', 'producer:document-b', 'produces-document-facts'),
            edge('implementation:runtime-a', 'producer:test-a', 'binds-test-evidence'),
            edge('implementation:runtime-b', 'producer:test-b', 'binds-test-evidence'),
            edge('extractor:test-matrix-a', 'producer:test-a', 'produces-test-facts'),
            edge('extractor:test-matrix-b', 'producer:test-b', 'produces-test-facts'),
            edge('implementation:runtime-a', 'producer:mutation-a', 'binds-mutation-evidence'),
            edge('implementation:runtime-b', 'producer:mutation-b', 'binds-mutation-evidence'),
            edge('producer:test-a', 'producer:mutation-a', 'produces-mutation-evidence'),
            edge('producer:test-b', 'producer:mutation-b', 'produces-mutation-evidence'),
            edge('producer:document-a', 'joiner:pre-runtime', 'seals-pre-runtime'),
            edge('producer:document-b', 'joiner:pre-runtime', 'seals-pre-runtime'),
            edge('producer:test-a', 'joiner:pre-runtime', 'seals-pre-runtime'),
            edge('producer:test-b', 'joiner:pre-runtime', 'seals-pre-runtime'),
            edge('producer:mutation-a', 'joiner:pre-runtime', 'seals-pre-runtime'),
            edge('producer:mutation-b', 'joiner:pre-runtime', 'seals-pre-runtime'),
            edge('joiner:pre-runtime', 'producer:runtime-a', 'admits-runtime'),
            edge('joiner:pre-runtime', 'producer:runtime-b', 'admits-runtime'),
            edge('joiner:pre-runtime', 'joiner:post-runtime', 'supplies-pre-runtime'),
            edge('producer:runtime-a', 'joiner:post-runtime', 'seals-post-runtime'),
            edge('producer:runtime-b', 'joiner:post-runtime', 'seals-post-runtime'),
            edge('joiner:pre-runtime', 'finalizer:release', 'supplies-pre-runtime'),
            edge('joiner:post-runtime', 'finalizer:release', 'supplies-post-runtime')
        ]
    };
}

const failureCodes = (receipt) => receipt.failureReasons.map((reason) => reason.split(':')[0]);

test('complete cross-authority graph is a canonical acyclic chain', () =>
{
    const receipt = assertAuthorityDag(completeGraph());
    assert.equal(receipt.schema, authorityDagReceiptSchema);
    assert.equal(receipt.status, 'ok');
    assert.equal(receipt.nodes.length, 10);
    assert.equal(receipt.edges.length, 17);
    assert.deepEqual(receipt.stronglyConnectedComponents, []);
    assert.deepEqual(receipt.selfLoops, []);
    assert.deepEqual(receipt.duplicateAuthorities, []);
    assert.deepEqual(receipt.orphanNodeIds, []);
    assert.deepEqual(receipt.behaviorOrphans, []);
    assert.deepEqual(receipt.missingBehaviorLayers, []);
    assert.deepEqual(receipt.missingEdges, []);
    assert.deepEqual(receipt.backEdges, []);
    assert.match(receipt.graphDigest, /^[a-f0-9]{64}$/u);
    assert.match(receipt.contentDigest, /^[a-f0-9]{64}$/u);
    assert.deepEqual(
        receipt.nodes.map(({ kind, layer }) => [kind, layer]),
        receipt.nodes.map(({ kind }) => [kind, authorityLayers[kind]])
    );
});

test('every catalog behavior must remain closed through every authority layer', () =>
{
    const graph = completeGraph();
    graph.nodes.find(({ kind }) => kind === 'behavior-catalog').behaviorIds.push(secondaryBehaviorId);
    const receipt = analyzeAuthorityDag(graph);
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.missingBehaviorLayers.length, Object.keys(authorityLayers).length - 1);
    assert.ok(receipt.missingBehaviorLayers.some(({ behaviorId, kind }) =>
        behaviorId === BehaviorId(secondaryBehaviorId) && kind === 'release-finalizer'));
    assert.ok(failureCodes(receipt).includes('missing-behavior-layer'));
    assert.throws(() => assertAuthorityDag(graph), /missing-behavior-layer/u);
});

test('two catalog behaviors pass only with independent complete edge closure', () =>
{
    const receipt = assertAuthorityDag(completeTwoBehaviorGraph());
    assert.equal(receipt.status, 'ok');
    assert.deepEqual(receipt.missingBehaviorLayers, []);
    assert.deepEqual(receipt.missingEdges, []);
    assert.deepEqual(receipt.behaviorOrphans, []);
});

test('required predecessor edges are checked per behavior rather than by kind intersection', () =>
{
    const graph = completeTwoBehaviorGraph();
    graph.edges = graph.edges.filter(({ from, to }) =>
        !(from === 'extractor:test-matrix-b' && to === 'producer:test-b'));
    const receipt = analyzeAuthorityDag(graph);
    assert.equal(receipt.status, 'failed');
    assert.ok(receipt.missingEdges.some(({ nodeId, behaviorId, predecessorKind }) =>
        nodeId === 'producer:test-b'
    && behaviorId === BehaviorId(secondaryBehaviorId)
    && predecessorKind === 'fact-extractor'));
    assert.ok(failureCodes(receipt).includes('missing-predecessor'));
});

test('Tarjan analysis reports an SCC and a finalizer-to-catalog back edge', () =>
{
    const graph = completeGraph();
    graph.edges.push(edge('finalizer:release', 'catalog:behavior', 'reruns-producer'));
    const receipt = analyzeAuthorityDag(graph);
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.stronglyConnectedComponents.length, 1);
    assert.deepEqual(receipt.stronglyConnectedComponents[0], receipt.nodes.map(({ id }) => id).sort());
    assert.deepEqual(receipt.backEdges.map(({ from, to }) => [from, to]), [
        ['finalizer:release', 'catalog:behavior']
    ]);
    assert.ok(failureCodes(receipt).includes('scc'));
    assert.ok(failureCodes(receipt).includes('back-edge'));
    assert.throws(() => assertAuthorityDag(graph), /authority graph failed/u);
});

test('self cycles fail independently from multi-node SCCs', () =>
{
    const graph = completeGraph();
    graph.edges.push(edge('producer:test', 'producer:test', 'produces-test-facts'));
    const receipt = analyzeAuthorityDag(graph);
    assert.equal(receipt.status, 'failed');
    assert.deepEqual(receipt.selfLoops.map(({ from }) => from), ['producer:test']);
    assert.ok(failureCodes(receipt).includes('self-loop'));
    assert.ok(failureCodes(receipt).includes('back-edge'));
});

test('duplicate node, edge and authority identities fail closed', () =>
{
    const graph = completeGraph();
    graph.nodes.push(structuredClone(graph.nodes.find(({ id }) => id === 'producer:test')));
    graph.nodes.find(({ id }) => id === 'producer:runtime').authorityId = 'tools/test-matrix/produce-behavior-test-evidence.mjs';
    graph.edges.push(structuredClone(graph.edges[0]));
    const receipt = analyzeAuthorityDag(graph);
    assert.equal(receipt.status, 'failed');
    assert.ok(failureCodes(receipt).includes('duplicate-node'));
    assert.ok(failureCodes(receipt).includes('duplicate-edge'));
    assert.equal(receipt.duplicateAuthorities.length, 1);
    assert.ok(failureCodes(receipt).includes('duplicate-authority'));
});

test('orphan, missing endpoint and missing required predecessor edges are explicit', () =>
{
    const graph = completeGraph();
    graph.edges = graph.edges.filter(({ from, to }) => !(from === 'extractor:test-matrix' && to === 'producer:test'));
    graph.edges.push(edge('missing:producer', 'joiner:pre-runtime', 'seals-pre-runtime'));
    graph.nodes.push(node('producer:orphan-document', 'document-evidence-producer', 'tools/docs/orphan.mjs'));
    const receipt = analyzeAuthorityDag(graph);
    assert.equal(receipt.status, 'failed');
    assert.ok(receipt.missingEdges.some(({ nodeId, predecessorKind }) =>
        nodeId === 'producer:test' && predecessorKind === 'fact-extractor'));
    assert.ok(receipt.orphanNodeIds.includes('producer:orphan-document'));
    assert.ok(failureCodes(receipt).includes('missing-endpoint'));
    assert.ok(failureCodes(receipt).includes('missing-predecessor'));
    assert.ok(failureCodes(receipt).includes('orphan'));
});

test('cross-layer and same-layer reverse dependencies are rejected', () =>
{
    const graph = completeGraph();
    graph.edges.push(edge('joiner:post-runtime', 'producer:runtime', 'seals-post-runtime'));
    graph.edges.push(edge('producer:test', 'producer:document', 'produces-document-facts'));
    const receipt = analyzeAuthorityDag(graph);
    assert.equal(receipt.status, 'failed');
    assert.deepEqual(receipt.backEdges.map(({ from, to }) => [from, to]), [
        ['joiner:post-runtime', 'producer:runtime'],
        ['producer:test', 'producer:document']
    ]);
});

test('mutation suite kills authority, kind, edge and behavior identity drift', () =>
{
    const baseline = assertAuthorityDag(completeGraph());
    const mutations = [
        (graph) =>
        {
            graph.nodes.find(({ id }) => id === 'producer:runtime').authorityId = graph.nodes[4].authorityId;
        },
        (graph) =>
        {
            graph.nodes.find(({ id }) => id === 'producer:runtime').kind = 'test-evidence-producer';
        },
        (graph) =>
        {
            graph.edges = graph.edges.filter(({ to }) => to !== 'finalizer:release');
        },
        (graph) =>
        {
            graph.edges.find(({ to }) => to === 'producer:runtime').relation = 'supplies-post-runtime';
        },
        (graph) =>
        {
            graph.nodes.find(({ id }) => id === 'producer:runtime').behaviorIds = [BehaviorId(secondaryBehaviorId)];
        },
        (graph) =>
        {
            graph.nodes.find(({ kind }) => kind === 'behavior-catalog').behaviorIds.push(secondaryBehaviorId);
        }
    ];
    for (const mutate of mutations)
    {
        const graph = completeGraph();
        mutate(graph);
        const receipt = analyzeAuthorityDag(graph);
        assert.equal(receipt.status, 'failed');
        assert.notEqual(receipt.graphDigest, baseline.graphDigest);
        assert.notEqual(receipt.contentDigest, baseline.contentDigest);
    }
});

test('canonical replay ignores input ordering but rejects semantic or receipt drift', () =>
{
    const graph = completeGraph();
    const receipt = assertAuthorityDag(graph);
    const reordered = {
        edges: [...graph.edges].reverse().map(({ relation, to, from }) => ({ relation, to, from })),
        nodes: [...graph.nodes].reverse().map(({ behaviorIds, authorityId, kind, id }) => ({
            behaviorIds: [...behaviorIds].reverse().map((behaviorId) => BehaviorId(behaviorId)), authorityId, kind, id
        })),
        canonicalSerialization: graph.canonicalSerialization,
        digestAlgorithm: graph.digestAlgorithm,
        schema: graph.schema
    };
    assert.deepEqual(assertAuthorityDag(reordered), receipt);
    assert.equal(validateAuthorityDagReceipt(reordered, receipt), receipt);

    const tamperedReceipt = structuredClone(receipt);
    tamperedReceipt.status = 'failed';
    assert.throws(() => validateAuthorityDagReceipt(graph, tamperedReceipt), /does not replay/u);

    const semanticDrift = completeGraph();
    semanticDrift.nodes.find(({ id }) => id === 'producer:runtime').authorityId += '#v2';
    assert.throws(() => validateAuthorityDagReceipt(semanticDrift, receipt), /does not replay/u);

    const failedGraph = completeGraph();
    failedGraph.edges.push(edge('finalizer:release', 'catalog:behavior', 'reruns-producer'));
    const failedReceipt = analyzeAuthorityDag(failedGraph);
    assert.equal(failedReceipt.status, 'failed');
    assert.throws(
        () => validateAuthorityDagReceipt(failedGraph, failedReceipt),
        /receipt status must be ok/u
    );
});

test('CLI validates a sealed replay without executing any producer', () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-authority-dag-'));
    try
    {
        const graph = completeGraph();
        const receipt = assertAuthorityDag(graph);
        const graphPath = path.join(directory, 'graph.json');
        const receiptPath = path.join(directory, 'receipt.json');
        writeFileSync(graphPath, `${JSON.stringify(graph)}\n`);
        writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
        const result = spawnSync('node', [analyzerPath, '--graph', graphPath, '--receipt', receiptPath], {
            cwd: root,
            encoding: 'utf8'
        });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /ok nodes=10 edges=17 digest=[a-f0-9]{64}/u);

        const failedGraph = completeGraph();
        failedGraph.edges.push(edge('finalizer:release', 'catalog:behavior', 'reruns-producer'));
        const failedReceipt = analyzeAuthorityDag(failedGraph);
        writeFileSync(graphPath, `${JSON.stringify(failedGraph)}\n`);
        writeFileSync(receiptPath, `${JSON.stringify(failedReceipt)}\n`);
        const failed = spawnSync('node', [analyzerPath, '--graph', graphPath, '--receipt', receiptPath], {
            cwd: root,
            encoding: 'utf8'
        });
        assert.notEqual(failed.status, 0);
        assert.doesNotMatch(failed.stdout, /\bok\b/u);
        assert.match(failed.stderr, /receipt status must be ok/u);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('graph and receipt schemas preserve strict identities and closed records', () =>
{
    const graphSchema = JSON.parse(readFileSync(path.join(root, 'config/schemas/cross-authority-dag.schema.json'), 'utf8'));
    const receiptSchema = JSON.parse(readFileSync(path.join(root, 'config/schemas/cross-authority-dag-receipt.schema.json'), 'utf8'));
    assert.equal(graphSchema.$id, authorityDagSchema);
    assert.equal(receiptSchema.$id, authorityDagReceiptSchema);
    assert.equal(graphSchema.additionalProperties, false);
    assert.equal(graphSchema.$defs.node.additionalProperties, false);
    assert.equal(graphSchema.$defs.edge.additionalProperties, false);
    assert.equal(receiptSchema.additionalProperties, false);
    assert.equal(receiptSchema.$defs.analyzedNode.additionalProperties, false);
    assert.equal(receiptSchema.$defs.analyzedEdge.additionalProperties, false);
    assert.deepEqual(graphSchema.$defs.node.properties.kind.enum, Object.keys(authorityLayers));
});

test('unknown graph, node and edge fields are rejected before analysis', () =>
{
    const graph = completeGraph();
    graph.warning = true;
    assert.throws(() => analyzeAuthorityDag(graph), /graph fields must be exactly/u);
    delete graph.warning;
    graph.nodes[0].approved = true;
    assert.throws(() => analyzeAuthorityDag(graph), /node\[0\] fields must be exactly/u);
    delete graph.nodes[0].approved;
    graph.edges[0].optional = true;
    assert.throws(() => analyzeAuthorityDag(graph), /edge\[0\] fields must be exactly/u);
});
