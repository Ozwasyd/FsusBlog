import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { ApiError, encodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
import { encodePublicSearchResult, FrameType, WireHeaders } from '../../src/Contracts/wire.generated.ts';
import { createLocalSearch } from '../../src/Web/src/localSearch.ts';
import { apiErrorResponse, captureFetch, replaceProperty } from './fixture-source.ts';
import { oneHitSearchResult } from './public-search-fixture.ts';

function installServerModeDom(t: TestContext) {
  replaceProperty(t, globalThis, 'document', { head: { querySelector: () => null } });
}

function aedsResponse(status: number, bytes: Uint8Array<ArrayBuffer>, generation?: string): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'no-store',
  };
  if (generation !== undefined) headers[WireHeaders.SearchIndexGeneration] = generation;
  return new Response(bytes, { status, headers });
}

function errorResponse(status: number, message: string, details: string): Response {
  return apiErrorResponse(status, details, message, { 'Cache-Control': 'no-store' });
}

function searchOkResponse(generation: bigint, articleId: number, nextCursor = ''): Response {
  const total = nextCursor ? 15 : 1;
  const payload = oneHitSearchResult({
    id: articleId, publication: 100n + BigInt(articleId),
    publishedAtUnixMs: 1_700_000_000_000n, title: `Article ${articleId}`,
  }, { generation, totalCount: total, primaryCount: total, hasMore: nextCursor.length > 0, nextCursor });
  const frame = encodeFrame(FrameType.PublicSearchResult, encodePublicSearchResult(payload));
  return aedsResponse(200, frame, generation.toString());
}

test('controlled generation change restarts coherently from page 1 at most once', async t => {
  installServerModeDom(t);
  const calls = captureFetch(t, () => calls.length === 1
    ? errorResponse(409, 'The public search index changed.', 'search_generation_changed')
    : searchOkResponse(2002n, 77, 'fresh-cursor-2002'));

  const search = createLocalSearch({ requestTimeoutMs: 5_000 });
  const result = await search.search('alpha', new AbortController().signal, 2, 10, 'relevance', 'stale-cursor-1001');
  assert.equal(calls.length, 2, 'Controlled generation change must perform exactly one automatic restart');
  assert.match(calls[0].url, /cursor=stale-cursor-1001/);
  assert.doesNotMatch(calls[1].url, /cursor=/, 'Automatic restart must drop obsolete cursor and start from page 1');
  assert.equal(result.restartedFromGenerationChange, true);
  assert.equal(result.generation, '2002');
  assert.equal(result.items[0].id, 77);
  assert.equal(result.nextCursor, 'fresh-cursor-2002');
  search.dispose();
});

test('repeated consecutive generation changes stop after one retry without looping', async t => {
  installServerModeDom(t);
  const calls = captureFetch(t, () => errorResponse(409, 'The public search index changed.', 'search_generation_changed'));

  const search = createLocalSearch({ requestTimeoutMs: 5_000 });
  await assert.rejects(
    () => search.search('alpha', new AbortController().signal, 2, 10, 'relevance', 'stale-cursor-1001'),
    (error: unknown) =>
      error instanceof ApiError && error.status === 409 && error.details === 'search_generation_changed',
  );
  assert.equal(calls.length, 2, 'Must stop after a single automatic restart and never enter a retry loop');
  search.dispose();
});

test('malformed frames, cursor errors, auth failures, budget errors, and transport errors never auto-restart', async t => {
  installServerModeDom(t);

  const requestErrors = [
    ['400 search_cursor_invalid', 400, 'Invalid cursor', 'search_cursor_invalid', true],
    ['401 unauthorized', 401, 'Unauthorized', 'unauthorized', false],
    ['403 forbidden', 403, 'Forbidden', 'forbidden', false],
    ['503 budget exceeded', 503, 'Budget exceeded', 'search_budget_exceeded', true],
    ['409 without generation detail', 409, 'Generic conflict', 'other_conflict', true],
  ] as const;
  const cases: { name: string; respond: () => Promise<Response>; check: (error: unknown) => boolean }[] = [
    ...requestErrors.map(([name, status, message, detail, requireDetail]) => ({
      name,
      respond: async () => errorResponse(status, message, detail),
      check: (e: unknown) => e instanceof ApiError && e.status === status && (!requireDetail || e.details === detail),
    })),
    {
      name: 'corrupt AEDS bytes',
      respond: async () => aedsResponse(200, new Uint8Array([0xde, 0xad, 0xbe, 0xef]), '2002'),
      check: e => e instanceof ProtocolError,
    },
    {
      name: 'transport failure',
      respond: async () => { throw new TypeError('network down'); },
      check: e => e instanceof TypeError,
    },
  ];

  let respond = cases[0].respond;
  const calls = captureFetch(t, () => respond());
  for (const tc of cases) {
    respond = tc.respond;
    const previousCalls = calls.length;
    const search = createLocalSearch({ requestTimeoutMs: 5_000 });
    await assert.rejects(
      () => search.search('alpha', new AbortController().signal, 2, 10, 'relevance', 'cursor-1'),
      tc.check,
      `Case ${tc.name} threw unexpected error`,
    );
    assert.equal(calls.length - previousCalls, 1, `Case ${tc.name} must never automatically retry`);
    search.dispose();
  }
});

test('generation restart honors the original request deadline and caller cancellation', async t => {
  installServerModeDom(t);

  // The original deadline expires during the single restart.
  let respond = async (init?: RequestInit): Promise<Response> => {
    if (calls.length === 1) return errorResponse(409, 'Changed', 'search_generation_changed');
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
  };
  const calls = captureFetch(t, (_, init) => respond(init));
  const search = createLocalSearch({ requestTimeoutMs: 40 });
  await assert.rejects(
    () => search.search('alpha', new AbortController().signal, 2, 10, 'relevance', 'cursor-1'),
    (error: unknown) => error instanceof DOMException && error.name === 'TimeoutError',
  );
  assert.equal(calls.length, 2);
  search.dispose();

  // Caller cancellation during the first request suppresses retry completely.
  const previousCalls = calls.length;
  const caller = new AbortController();
  respond = async init => {
    caller.abort(new DOMException('Cancelled by caller', 'AbortError'));
    init?.signal?.throwIfAborted();
    return errorResponse(409, 'Changed', 'search_generation_changed');
  };
  const search2 = createLocalSearch({ requestTimeoutMs: 5_000 });
  await assert.rejects(
    () => search2.search('alpha', caller.signal, 2, 10, 'relevance', 'cursor-1'),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
  );
  assert.equal(calls.length - previousCalls, 1, 'Aborted caller must never trigger a restart request');
  search2.dispose();
});
