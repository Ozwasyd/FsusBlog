import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    checkAuthoringCanvasReferenceAuthority
} from '../../tools/governance/check-authoring-canvas-reference-authority.mjs';

const root = path.resolve(import.meta.dirname, '../..');

function write(repositoryRoot, relative, source)
{
    const absolute = path.join(repositoryRoot, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, source);
}

function fixture(t)
{
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-canvas-reference-'));
    t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
    write(repositoryRoot, 'src/backend/Services/Authoring/AuthoringCanvasReferenceResolver.cs', `
public sealed class AuthoringCanvasReferenceResolver
{
    public void Resolve() => factSource.ReadBatchAsync();
}
public sealed class AuthoringCanvasReferenceProjectionCache {}
`);
    write(repositoryRoot, 'src/backend/Services/Authoring/AuthoringCanvasReferenceFactSource.cs', `
public sealed class AuthoringCanvasReferenceFactSource {}
public sealed class PostgresAuthoringCanvasArticleReferenceReader {}
`);
    write(repositoryRoot, 'src/backend/Services/Authoring/AuthoringCanvasReferenceVerifier.cs', `
public sealed class AuthoringCanvasReferenceVerifier
{
    public void Verify()
    {
        factSource.ReadAuthorityCoordinateAsync();
        factSource.ReadBatchAsync();
    }
}
`);
    return repositoryRoot;
}

function violations(repositoryRoot)
{
    return checkAuthoringCanvasReferenceAuthority(repositoryRoot).join('\n');
}

test('repository canvas reference authority satisfies the static boundary', () =>
{
    assert.deepEqual(checkAuthoringCanvasReferenceAuthority(root), []);
});

test('inline minimal authority has exact-one bounded resolver and independent verifier', (t) =>
{
    assert.equal(violations(fixture(t)), '');
});

test('rejects second resolver, fact source, reader, cache, and verifier authorities', (t) =>
{
    const repositoryRoot = fixture(t);
    write(repositoryRoot, 'src/backend/Services/Authoring/SecondAuthority.cs', `
public class AuthoringCanvasReferenceResolver {}
public class AuthoringCanvasReferenceFactSource {}
public class PostgresAuthoringCanvasArticleReferenceReader {}
public class AuthoringCanvasReferenceProjectionCache {}
public class AuthoringCanvasReferenceVerifier {}
`);

    const result = violations(repositoryRoot);
    for (const name of [
        'AuthoringCanvasReferenceResolver',
        'AuthoringCanvasReferenceFactSource',
        'PostgresAuthoringCanvasArticleReferenceReader',
        'AuthoringCanvasReferenceProjectionCache',
        'AuthoringCanvasReferenceVerifier'
    ])
    {
        assert.match(result, new RegExp(`expected exact-one ${name}`, 'u'));
    }
});

test('rejects verifier reuse of resolver, cache, or non-bounded fact reads', (t) =>
{
    const repositoryRoot = fixture(t);
    write(repositoryRoot, 'src/backend/Services/Authoring/AuthoringCanvasReferenceVerifier.cs', `
public sealed class AuthoringCanvasReferenceVerifier
{
    public void Verify()
    {
        factSource.ReadAuthorityCoordinateAsync();
        factSource.ReadBatchAsync();
        resolver.ResolveAsync();
        projectionCache.TryGet(key);
        targets.Select(async target => await factSource.ReadBatchAsync());
    }
}
`);

    const result = violations(repositoryRoot);
    assert.match(result, /independently read exact-one authority and fact batch/u);
    assert.match(result, /must not call the resolver or projection cache/u);
    assert.match(result, /must not issue N\+1 batch reads/u);
});

test('rejects body payloads and title or hash identity fallback', (t) =>
{
    const repositoryRoot = fixture(t);
    write(repositoryRoot, 'src/backend/Services/Authoring/AuthoringCanvasReferenceFactSource.cs', `
public sealed class AuthoringCanvasReferenceFactSource
{
    private string ArticleBody = string.Empty;
    public object Find() => candidates.FirstOrDefault(candidate => candidate.Title == requestedTitle);
}
public sealed class PostgresAuthoringCanvasArticleReferenceReader {}
`);

    const result = violations(repositoryRoot);
    assert.match(result, /must not admit article body, HTML, or DOM payloads/u);
    assert.match(result, /must not fall back to title or hash matching/u);
});

test('rejects replacement of a pinned revision with latest', (t) =>
{
    const repositoryRoot = fixture(t);
    write(repositoryRoot, 'src/backend/Services/Authoring/LatestPinned.cs', `
public sealed class LatestPinned
{
    public object Replace() => node with { PinnedTargetRevision = fact.CurrentRevision };
}
`);

    assert.match(violations(repositoryRoot), /must not be silently replaced with the latest revision/u);
});

test('rejects client-side permission filtering of canvas references', (t) =>
{
    const repositoryRoot = fixture(t);
    write(repositoryRoot, 'src/frontend/canvas-reference.ts', `
export const canvasReference = references.filter(reference => reference.permission === 'article-read');
`);

    assert.match(violations(repositoryRoot), /client-side canvas reference permission filtering is forbidden/u);
});
