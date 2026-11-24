import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFrame, encodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
import { canvasBundle, decodeCanvasBundlePlan, encodeCanvasBundleExecute } from '../../src/Contracts/canvas-bundle.ts';
import {
  canvasGraph, decodeCanvasGraphHistory, decodeCanvasGraphPage, decodeCanvasReferenceResolution, encodeCanvasGraphCommand,
  type CanvasGraphCommand,
} from '../../src/Contracts/canvas-graph.ts';
import { decodeCanvasLinkPlan, encodeCanvasLinkPlan, FrameType, WireLimits, WireRoutes } from '../../src/Contracts/wire.generated.ts';
import {
  captureFetch, fixtureBytes, framedFixture, frameResponse, podFrame, rejectInputs, rejectWrongLength, withI32, withI64,
} from './fixture-source.ts';

const id = (value: number) => `7a7a7a7a-0000-4000-8000-${String(value).padStart(12, '0')}`;
const geometry = { x: 100, y: -200, width: 20_000, height: 10_000 };
const viewport = { x: -300, y: 400, zoom: 1250 };
const revision = 9_007_199_254_740_993n;
const title = 'Private graph 🐈';
const commands = {
  id: id(1), commandId: id(2), expectedRevision: revision, action: 'edit', title, viewport,
  changes: [
    { kind: 'upsert-node', node: { id: id(3), kind: 'plain-text-note', geometry, text: 'note\n行' } },
    { kind: 'upsert-node', node: { id: id(4), kind: 'group-frame', geometry, text: 'Review', memberIds: [id(3)] } },
    { kind: 'upsert-node', node: { id: id(5), kind: 'article-reference', geometry, articleId: 17, pinnedRevision: revision } },
    { kind: 'upsert-node', node: { id: id(6), kind: 'heading-reference', geometry, articleId: 17, anchor: 'stable-anchor', pinnedRevision: null } },
    { kind: 'upsert-node', node: { id: id(7), kind: 'block-reference', geometry, articleId: 18, anchor: 'sub-block', pinnedRevision: 1n } },
    { kind: 'upsert-edge', edge: { id: id(8), kind: 'explicit-reference-note', sourceNodeId: id(5), targetNodeId: id(6), order: 1, label: 'Cite' } },
    { kind: 'remove-edge', id: id(8) },
  ],
} satisfies CanvasGraphCommand;

test('graph command preserves exact wire bytes for all five nodes and stable typed edges', () => {
  assert.deepEqual(encodeFrame(FrameType.CanvasGraphCommand, encodeCanvasGraphCommand(commands)), fixtureBytes('canvas-graph-command.hex'));
  rejectInputs(edit => encodeCanvasGraphCommand({ ...commands, ...edit }), [
    { expectedRevision: 0n }, { action: 'delete' }, { title: 'line\nbreak' }, { title: '<markup>' },
    { changes: [{ kind: 'upsert-node', node: { id: id(3), kind: 'group-frame', text: 'Frame', geometry, memberIds: [id(3)] } }] },
  ] as Partial<CanvasGraphCommand>[]);
});

test('paged Canvas response binds exact scope, revision, membership, and combined sequential offset', async t => {
  const payload = framedFixture('canvas-graph-page-node.hex', FrameType.CanvasGraphPage);
  const first = decodeCanvasGraphPage(payload);
  assert.equal(first.header.id, id(1));
  assert.equal(first.header.revision, revision);
  assert.equal(first.header.title, title);
  assert.deepEqual(first.header.viewport, viewport);
  assert.equal(first.nextOffset, 1);
  assert.deepEqual(first.nodes, [{ id: id(4), kind: 'group-frame', geometry, text: 'Review', memberIds: [id(3)] }]);
  assert.deepEqual(first.edges, []);
  assert.throws(() => decodeCanvasGraphPage(payload.subarray(0, -1)), ProtocolError);
  assert.throws(() => decodeCanvasGraphPage(payload, 1), ProtocolError);

  const last = framedFixture('canvas-graph-page-edge.hex', FrameType.CanvasGraphPage);
  assert.throws(() => decodeCanvasGraphPage(last, 1), ProtocolError);
  assert.throws(() => decodeCanvasGraphPage(last, 3), /page offset/);
  assert.equal(decodeCanvasGraphPage(last, 2).nextOffset, null);
  assert.deepEqual(decodeCanvasGraphPage(last, 2).edges, [commands.changes[5].edge]);

  const calls = captureFetch(t, () => frameResponse(fixtureBytes('canvas-graph-page-edge.hex')));
  const page = await canvasGraph.page(id(1), { revision, offset: 2 });
  assert.equal(page.header.revision, revision);
  assert.equal(page.edges[0]?.id, id(8));
  assert.equal(calls[0].url, `${WireRoutes.CanvasGraphPage.replace(/\{id(?::guid)?\}/, id(1))}?revision=${revision}&offset=2`);
  await assert.rejects(canvasGraph.page(id(2), { revision, offset: 2 }), /page document or revision/);
  assert.throws(() => canvasGraph.page(id(1), { offset: 2 }), /page revision/);
});

test('undo, redo, and history preserve envelopes, revision echoes, and reject malformed fields', async t => {
  for (const action of ['undo', 'redo'] as const) {
    const command = { ...commands, action, title: '', viewport: null, changes: [] };
    assert.deepEqual(encodeFrame(FrameType.CanvasGraphCommand, encodeCanvasGraphCommand(command)), fixtureBytes(`canvas-graph-${action}.hex`));
    rejectInputs(edit => encodeCanvasGraphCommand({ ...command, ...edit }), [{ title: 'x' }, { viewport }, { changes: commands.changes }], /history command shape/);
    assert.throws(() => encodeCanvasGraphCommand({ ...command, expectedRevision: 0n }), /command revision or action/);
  }

  const bytes = fixtureBytes('canvas-graph-history.hex');
  const { payload } = decodeFrame(bytes, FrameType.CanvasGraphHistory);
  const expected = { revision, undoRevision: revision, redoRevision: null };
  assert.deepEqual(decodeCanvasGraphHistory(payload), expected);
  rejectWrongLength(decodeCanvasGraphHistory, payload);
  for (const redo of [-1n, revision, revision + 1n])
    assert.throws(() => decodeCanvasGraphHistory(withI64(payload, 16, redo)), /history revision/);

  const signal = new AbortController().signal;
  const calls = captureFetch(t, ({ url }, init) => {
    assert.equal(init?.signal, signal);
    assert.match(url, new RegExp(`/${id(1)}/history\\.aeds\\?revision=\\d+$`));
    return frameResponse(bytes);
  });
  const read = (at: bigint) => canvasGraph.history(id(1), at, signal);
  assert.deepEqual(await read(revision), expected);
  await assert.rejects(read(revision + 1n), /history revision/);
  rejectInputs(read, [0n, 1n << 63n], /history revision/);
  assert.equal(calls.length, 2);
});

test('reference resolution preserves authorized metadata, redacted states, and exact fetch echoes', async t => {
  const payload = (name: string) => framedFixture(`canvas-reference-${name}.hex`, FrameType.CanvasReferenceResolution);
  const expected = {
    canvasId: id(1), nodeId: id(6), canvasRevision: revision, state: 'resolved', articleId: 17, articleRevision: revision + 1n,
    pinned: true, title: 'Draft title 猫', excerpt: 'Heading\nPlain excerpt', sourceOffset: 0,
  };
  const resolved = payload('resolved');
  assert.deepEqual(decodeCanvasReferenceResolution(resolved), expected);
  assert.deepEqual(decodeCanvasReferenceResolution(payload('missing')), {
    ...expected, state: 'missing-anchor', pinned: false, excerpt: null, sourceOffset: null,
  });
  const redacted = {
    ...expected, state: 'unavailable', articleId: null, articleRevision: null, pinned: false, title: null, excerpt: null, sourceOffset: null,
  };
  assert.deepEqual(decodeCanvasReferenceResolution(payload('unavailable')), redacted);
  const stateOffset = 40;
  assert.deepEqual(decodeCanvasReferenceResolution(withI32(payload('unavailable'), stateOffset, 4)), { ...redacted, state: 'stale-revision' });
  for (const state of [0, 2, 3, 4, 5])
    assert.throws(() => decodeCanvasReferenceResolution(withI32(resolved, stateOffset, state)), ProtocolError);
  assert.throws(() => decodeCanvasReferenceResolution(resolved.subarray(0, -1)), ProtocolError);
  assert.throws(() => decodeCanvasReferenceResolution(withI32(resolved, resolved.length - 4, -1)), /reference excerpt or offset/);

  const signal = new AbortController().signal;
  const calls = captureFetch(t, (_call, init) => {
    assert.equal(init?.signal, signal);
    return frameResponse(fixtureBytes('canvas-reference-resolved.hex'));
  });
  const path = WireRoutes.CanvasReference.replace('{id:guid}', id(1)).replace('{nodeId:guid}', id(6));
  const resolve = (canvas: number, node: number, at: bigint) => canvasGraph.resolve(id(canvas), id(node), at, signal);
  assert.equal((await resolve(1, 6, revision)).title, 'Draft title 猫');
  assert.equal(calls[0].url, `${path}?revision=${revision}`);
  for (const [c, n, rev] of [[2, 6, revision], [1, 7, revision], [1, 6, revision + 1n]] as const)
    await assert.rejects(resolve(c, n, rev), /reference response coordinates/);
  assert.throws(() => resolve(1, 6, 0n), /reference revision/);
  assert.equal(calls.length, 4);
});

test('canvas bundle plan, preflight, execution, and import enforce digests and fresh receipts', async t => {
  const digest = '1b784b422a40ce408a17deb133dcb419f5d1528b906ab1b97f72a9a87364fdc8';
  const raw = new TextEncoder().encode('{"kind":"authoring-canvas","demo":"检验"}\n');
  const command = {
    canvasId: id(1), commandId: id(2), digest, bundle: raw,
    mappings: [{ slot: 1, articleId: 17, pinnedRevision: null }, { slot: 2, articleId: 21, pinnedRevision: revision + 1n }],
  };
  const planPayload = framedFixture('canvas-bundle-plan.hex', FrameType.CanvasBundlePlan);
  assert.deepEqual(decodeCanvasBundlePlan(planPayload), {
    digest, sourceRevision: revision, title: 'Private notes 猫', nodeCount: 3, edgeCount: 1,
    references: [{ slot: 1, kind: 'article-reference', pinned: false, anchor: null }, { slot: 2, kind: 'block-reference', pinned: true, anchor: 'named-block' }],
  });
  assert.throws(() => decodeCanvasBundlePlan(planPayload.subarray(0, -1)), ProtocolError);
  const firstSlotOffset = 92 + new TextEncoder().encode('Private notes 猫').length;
  assert.throws(() => decodeCanvasBundlePlan(withI32(planPayload, firstSlotOffset, 2)), /bundle reference/);

  const executeFixture = fixtureBytes('canvas-bundle-execute.hex');
  assert.deepEqual(encodeFrame(FrameType.CanvasBundleExecute, encodeCanvasBundleExecute(command)), executeFixture);
  assert.throws(() => encodeCanvasBundleExecute({ ...command, mappings: command.mappings.slice(1) }), /bundle mapping/);
  assert.throws(() => encodeCanvasBundleExecute({ ...command, digest: digest.toUpperCase() }), /bundle digest/);
  rejectInputs(bundle => encodeCanvasBundleExecute({ ...command, bundle }), [new Uint8Array(0), new Uint8Array(WireLimits.CanvasBundleBytes + 1)], /bundle byte length/);

  const signal = new AbortController().signal;
  const planCalls = captureFetch(t, ({ url, method }, init) => {
    assert.equal(url, WireRoutes.CanvasBundlePlan);
    assert.equal(init?.signal, signal);
    assert.equal(method, 'POST');
    return frameResponse(fixtureBytes('canvas-bundle-plan.hex'));
  });
  assert.equal((await canvasBundle.plan(raw, signal)).digest, digest);
  assert.deepEqual(planCalls[0].body, fixtureBytes('canvas-bundle-intake.hex'));
  await assert.rejects(canvasBundle.plan(Uint8Array.of(42), signal), /bundle plan digest/);
  assert.equal(canvasBundle.downloadHref(id(1), revision), `${WireRoutes.CanvasBundleExport.replace('{id:guid}', id(1))}?revision=${revision}`);
  assert.throws(() => canvasBundle.downloadHref(id(1), 0n), /export revision/);

  let [receiptId, receiptRevision] = [id(1), 1n];
  captureFetch(t, ({ url, method, body }) => {
    assert.equal(url, WireRoutes.CanvasBundleExecute);
    assert.equal(method, 'POST');
    assert.deepEqual(body, executeFixture);
    return frameResponse(podFrame(FrameType.CanvasGraphReceipt, w => {
      w.uuid(receiptId); w.i64(receiptRevision); w.text('Private notes 猫', WireLimits.TitleBytes);
      w.i32(0); w.i32(0); w.i32(1000); w.bool(false); w.i32(3); w.i32(1); w.i64(1_700_000_000_000n);
    }));
  });
  assert.equal((await canvasBundle.import(command)).revision, 1n);
  receiptRevision = 2n;
  await assert.rejects(canvasBundle.import(command), /bundle import receipt/);
  receiptRevision = 1n;
  receiptId = id(2);
  await assert.rejects(canvasBundle.import(command), /bundle import receipt/);
});

test('Canvas link plan matches independently assembled Unicode, UUID and 64-bit coordinates', () => {
  const vector = fixtureBytes('canvas-link-plan.hex');
  const plan = {
    planId: '76aff0f0-ba5e-4bd3-ab12-a42d29b9131a', canvasRevision: 3n, hostArticleId: 8,
    hostRevision: 12n, targetArticleId: 21, targetRevision: 9n, sourceOffset: 30,
    insertedMarkdown: '\r\n\r\n[规划 🐝](/article/21)', expiresAtUnixSeconds: 1794680000n,
  };
  assert.deepEqual(encodeFrame(FrameType.CanvasLinkPlan, encodeCanvasLinkPlan(plan)), vector);
  assert.deepEqual(decodeCanvasLinkPlan(decodeFrame(vector, FrameType.CanvasLinkPlan).payload), plan);
  assert.throws(() => decodeCanvasLinkPlan(decodeFrame(vector).payload.subarray(0, -1)), ProtocolError);
  assert.throws(() => decodeFrame(vector, FrameType.CanvasConfirm), ProtocolError);
});
