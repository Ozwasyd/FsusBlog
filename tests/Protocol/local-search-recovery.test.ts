import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { ApiError, encodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
import {
  encodePublicSearchResult,
  FrameType,
  PublicSearchMatchTier,
  PublicSearchSnippetField,
  PublicSearchTotalRelation,
  WireHeaders,
  WireLimits,
  type PublicSearchResult,
} from '../../src/Contracts/wire.generated.ts';
import { createLocalSearch } from '../../src/Web/src/localSearch.ts';
import { apiErrorResponse, captureFetch, replaceProperty } from './fixture-source.ts';

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
  const payload: PublicSearchResult = {
    generation,
    profileVersion: WireLimits.SearchFas4Profile,
    analyzerVersion: WireLimits.SearchAnalyzerVersion,
    totalCount: nextCursor ? 15 : 1,
    totalRelation: PublicSearchTotalRelation.Exact,
    primaryCount: nextCursor ? 15 : 1,
    relaxedCount: 0,
    hasMore: nextCursor.length > 0,
    nextCursor,
    items: [
      {
        id: articleId,
        revision: 1n,
        revisionNo: 1,
        publication: 100n + BigInt(articleId),
        publicationNo: 1,
        publishedAtUnixMs: 1_700_000_000_000n,
        createdAtUnixMs: 1_700_000_000_000n,
        views: 0,
        categoryId: 0,
        categoryName: '',
        tags: [],
        title: `Article ${articleId}`,
        summary: 'Summary',
        matchTier: PublicSearchMatchTier.Primary,
        snippetField: PublicSearchSnippetField.Title,
        snippet: `Article ${articleId}`,
        highlights: [],
      },
    ],
  };
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

  const cases: { name: string; respond: () => Promise<Response>; check: (error: unknown) => boolean }[] = [
    {
      name: '400 search_cursor_invalid',
      respond: async () => errorResponse(400, 'Invalid cursor', 'search_cursor_invalid'),
      check: e => e instanceof ApiError && e.status === 400 && e.details === 'search_cursor_invalid',
    },
    {
      name: '401 unauthorized',
      respond: async () => errorResponse(401, 'Unauthorized', 'unauthorized'),
      check: e => e instanceof ApiError && e.status === 401,
    },
    {
      name: '403 forbidden',
      respond: async () => errorResponse(403, 'Forbidden', 'forbidden'),
      check: e => e instanceof ApiError && e.status === 403,
    },
    {
      name: '503 budget exceeded',
      respond: async () => errorResponse(503, 'Budget exceeded', 'search_budget_exceeded'),
      check: e => e instanceof ApiError && e.status === 503 && e.details === 'search_budget_exceeded',
    },
    {
      name: '409 without generation detail',
      respond: async () => errorResponse(409, 'Generic conflict', 'other_conflict'),
      check: e => e instanceof ApiError && e.status === 409 && e.details === 'other_conflict',
    },
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
