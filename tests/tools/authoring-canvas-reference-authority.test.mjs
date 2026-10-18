import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const {checkAuthoringCanvasReferenceAuthority} = await import(new URL('../../tools/governance/check-authoring-canvas-reference-authority.mjs', import.meta.url));
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

const domAuthorityViolation = /DOM-derived canvas reference identity or selection authority is forbidden/u;

for (const [name, field, expression] of [
    ['article attribute', 'targetArticleId', 'Number(document.querySelector("[data-article-id]")?.getAttribute("data-article-id"))'],
    ['heading DOM id', 'targetHeadingIdentity', 'document.querySelector("[data-anchor]")?.id'],
    ['block dataset', 'targetBlockIdentity', 'document.getElementById("block")?.dataset.blockIdentity'],
    ['selection anchor', 'targetHeadingIdentity', 'window.getSelection()?.anchorNode?.parentElement?.id'],
    ['range container', 'targetBlockIdentity', 'document.createRange().startContainer.parentElement?.id']
])
{
    test(`rejects frontend DOM-derived ${name} assigned as target identity`, (t) =>
    {
        const repositoryRoot = fixture(t);
        write(repositoryRoot, 'src/frontend/canvas-reference.ts', `
export const canvasReferenceTarget = {
    ${field}: ${expression}
};
`);

        assert.match(violations(repositoryRoot), domAuthorityViolation);
    });
}

test('rejects the original frontend DOM identity probe independently of payload and permission gates', (t) =>
{
    const repositoryRoot = fixture(t);
    write(repositoryRoot, 'src/frontend/canvas-reference.ts', `
export const canvasReferenceTarget = {
    targetArticleId: Number(document.querySelector("[data-article-id]")?.getAttribute("data-article-id")),
    targetHeadingIdentity: document.querySelector("[data-anchor]")?.id
};
`);

    assert.match(violations(repositoryRoot), domAuthorityViolation);
    assert.equal(checkAuthoringCanvasReferenceAuthority(repositoryRoot).length, 1);
});

test('rejects a DOM alias written through a typed frontend identity declaration', (t) =>
{
    const repositoryRoot = fixture(t);
    write(repositoryRoot, 'src/frontend/canvas-reference.ts', `
const observed = document.getElementById("heading")?.id ?? "";
export const targetHeadingIdentity: string = observed;
`);

    assert.match(violations(repositoryRoot), domAuthorityViolation);
});

test('rejects frontend DOM aliases used for reference selection', (t) =>
{
    const repositoryRoot = fixture(t);
    write(repositoryRoot, 'src/frontend/canvas-reference.ts', `
type Reference = { targetHeadingIdentity: string };
export function canvasReference(references: Reference[]) {
    const element = document.querySelector("[data-anchor]");
    const observed = element?.id;
    const copied = observed;
    return references.find(reference => reference.targetHeadingIdentity === copied);
}
`);

    assert.match(violations(repositoryRoot), domAuthorityViolation);
});

for (const comparison of [
    'candidate.TargetHeadingIdentity == observed',
    'observed == candidate.TargetHeadingIdentity',
    'candidate.TargetHeadingIdentity.Equals(observed)',
    'string.Equals(candidate.TargetHeadingIdentity, observed, StringComparison.Ordinal)'
])
{
    test(`rejects backend DOM selection via ${comparison}`, (t) =>
    {
        const repositoryRoot = fixture(t);
        write(repositoryRoot, 'src/backend/Services/Authoring/AuthoringCanvasReferenceDomSelection.cs', `
public sealed class AuthoringCanvasReferenceDomSelection
{
    public object Find(System.Xml.XmlDocument document, IEnumerable<AuthoringCanvasReferenceTarget> candidates)
    {
        var element = document.SelectSingleNode("//*[@id]");
        var observed = element?.Attributes?["id"]?.Value;
        return candidates.FirstOrDefault(candidate => ${comparison});
    }
}
`);

        assert.match(violations(repositoryRoot), domAuthorityViolation);
        assert.equal(checkAuthoringCanvasReferenceAuthority(repositoryRoot).length, 1);
    });
}

test('rejects backend DOM identity in a reference object initializer', (t) =>
{
    const repositoryRoot = fixture(t);
    write(repositoryRoot, 'src/backend/Services/Authoring/AuthoringCanvasReferenceDomIdentity.cs', `
public sealed class AuthoringCanvasReferenceDomIdentity
{
    public object Create(System.Xml.XmlDocument document, AuthoringCanvasReferenceTarget target)
        => target with { TargetBlockIdentity = document.SelectSingleNode("//*[@id]")?.Attributes?["id"]?.Value };
}
`);

    assert.match(violations(repositoryRoot), domAuthorityViolation);
});

test('rejects backend expression-bodied DOM target identity', (t) =>
{
    const repositoryRoot = fixture(t);
    write(repositoryRoot, 'src/backend/Services/Authoring/AuthoringCanvasReferenceDomIdentity.cs', `
public sealed class AuthoringCanvasReferenceDomIdentity(System.Xml.XmlDocument document)
{
    public string TargetBlockIdentity => document.SelectSingleNode("//*[@id]")?.Attributes?["id"]?.Value;
}
`);

    assert.match(violations(repositoryRoot), domAuthorityViolation);
});

test('rejects backend DOM identity passed through positional target constructor arguments', (t) =>
{
    const repositoryRoot = fixture(t);
    write(repositoryRoot, 'src/backend/Services/Authoring/AuthoringCanvasReferenceDomIdentity.cs', `
public sealed class AuthoringCanvasReferenceDomIdentity
{
    public object Create(System.Xml.XmlElement element, AuthoringCanvasReferenceTarget target)
    {
        var observed = element.GetAttribute("id");
        return new AuthoringCanvasReferenceTarget(
            target.NodeId, target.NodeType, target.TargetArticleId, observed, null, null, null);
    }
}
`);

    assert.match(violations(repositoryRoot), domAuthorityViolation);
});

test('rejects frontend identity derived from a DOM attribute without a selector call', (t) =>
{
    const repositoryRoot = fixture(t);
    write(repositoryRoot, 'src/frontend/canvas-reference.ts', `
export function canvasReference(element: HTMLElement) {
    return { targetArticleId: Number(element.getAttribute("data-article-id")) };
}
`);

    assert.match(violations(repositoryRoot), domAuthorityViolation);
});

test('accepts canonical backend identity selection and bounded display facts', (t) =>
{
    const repositoryRoot = fixture(t);
    write(repositoryRoot, 'src/backend/Services/Authoring/AuthoringCanvasReferenceCanonical.cs', `
public sealed class AuthoringCanvasReferenceCanonical
{
    public object Find(AuthoringCanvasReferenceTarget target, IEnumerable<AuthoringCanvasReferenceTarget> candidates)
    {
        if (!BlockAnchorId.IsCanonical(target.TargetHeadingIdentity)) { return null; }
        var selected = candidates.SingleOrDefault(candidate => candidate.TargetHeadingIdentity == target.TargetHeadingIdentity);
        return new { target.TargetArticleId, target.TargetHeadingIdentity, Title = "bounded title", ContextSnippet = "bounded snippet" };
    }
}
`);

    assert.equal(violations(repositoryRoot), '');
});

test('accepts frontend canonical identities alongside DOM rendering and visual measurements', (t) =>
{
    const repositoryRoot = fixture(t);
    write(repositoryRoot, 'src/frontend/canvas-reference.ts', `
type Reference = { targetArticleId: number; targetHeadingIdentity: string };
export function canvasReference(target: Reference, references: Reference[]) {
    const element = document.getElementById(target.targetHeadingIdentity);
    const bounds = element?.getBoundingClientRect();
    const measured = document.querySelector("[data-reference]")?.getBoundingClientRect();
    const elements = references.map(({ targetHeadingIdentity }) => document.getElementById(targetHeadingIdentity));
    const paint = (targetHeadingIdentity: string) => document.getElementById(targetHeadingIdentity);
    const selected = references.find(reference => reference.targetArticleId === target.targetArticleId);
    return {
        targetArticleId: target.targetArticleId,
        targetHeadingIdentity: target.targetHeadingIdentity,
        height: bounds?.height,
        width: measured?.width,
        label: element?.textContent,
        selected, elements, paint
    };
}
`);
    write(repositoryRoot, 'tests/frontend/canvas-reference.visual.ts', `
const canvasReferenceMeasurement = document.querySelector("[data-article-id]")?.getBoundingClientRect();
`);

    assert.equal(violations(repositoryRoot), '');
});

test('accepts DOM examples in comments and strings and independent local alias scopes', (t) =>
{
    const repositoryRoot = fixture(t);
    write(repositoryRoot, 'src/frontend/canvas-reference.ts', `
// targetHeadingIdentity = document.querySelector("[data-anchor]")?.id;
/* references.find(reference => reference.targetHeadingIdentity === document.getElementById("block")?.id); */
export const canvasReferenceExample = 'targetArticleId: Number(document.querySelector("article")?.id)';
export function measure() {
    const observed = document.querySelector("article")?.id;
    return observed;
}
export function canonical(target: { targetHeadingIdentity: string }) {
    const observed = target.targetHeadingIdentity;
    return { targetHeadingIdentity: observed };
}
`);

    assert.equal(violations(repositoryRoot), '');
});

test('accepts canonical selection with a separate DOM presence guard and rendering assertions', (t) =>
{
    const repositoryRoot = fixture(t);
    write(repositoryRoot, 'src/frontend/canvas-reference.ts', `
type Reference = { targetHeadingIdentity: string };
export function canvasReference(target: Reference, references: Reference[]) {
    const element = document.getElementById(target.targetHeadingIdentity);
    const selected = references.find(reference => reference.targetHeadingIdentity === target.targetHeadingIdentity && element !== null);
    console.assert(element?.id === target.targetHeadingIdentity);
    return { targetHeadingIdentity: selected?.targetHeadingIdentity };
}
`);

    assert.equal(violations(repositoryRoot), '');
});

const reviewedLocalFlows = [
    ['canonical Equals with a separate DOM presence guard', 'cs', false, `
public sealed class AuthoringCanvasReferenceLocalFlow
{
    public object Find(System.Xml.XmlDocument document, AuthoringCanvasReferenceTarget target, IEnumerable<AuthoringCanvasReferenceTarget> candidates)
    {
        var observed = document.SelectSingleNode("//*[@id]");
        return candidates.FirstOrDefault(candidate => string.Equals(candidate.TargetHeadingIdentity, target.TargetHeadingIdentity, StringComparison.Ordinal) && observed != null);
    }
}
`],
    ['DOM-derived instance Equals receiver', 'cs', true, `
public sealed class AuthoringCanvasReferenceLocalFlow
{
    public object Find(System.Xml.XmlDocument document, IEnumerable<AuthoringCanvasReferenceTarget> candidates)
    {
        var element = document.SelectSingleNode("//*[@id]");
        var observed = element?.Attributes?["id"]?.Value;
        return candidates.FirstOrDefault(candidate => observed.Equals(candidate.TargetHeadingIdentity));
    }
}
`],
    ['DOM-derived conditional second branch in a scalar alias', 'ts', true, `
export function canvasReference(element: HTMLElement, allow: boolean) {
    const observed = allow ? "" : element.getAttribute("id");
    return { targetHeadingIdentity: observed };
}
`],
    ['DOM-derived conditional second branch in an identity write', 'ts', true, `
export function canvasReference(element: HTMLElement, allow: boolean) {
    const observed = element.getAttribute("id");
    return { targetHeadingIdentity: allow ? "" : observed };
}
`],
    ['backend DOM-derived conditional second branch', 'cs', true, `
public sealed class AuthoringCanvasReferenceLocalFlow
{
    public object Create(System.Xml.XmlElement element, bool allow, AuthoringCanvasReferenceTarget target)
    {
        var observed = allow ? "" : element.GetAttribute("id");
        return target with { TargetHeadingIdentity = observed };
    }
}
`],
    ['nested-block reassignment introducing DOM identity', 'ts', true, `
export function canvasReference(element: HTMLElement) {
    let observed = "";
    { observed = element.getAttribute("id") ?? ""; }
    return { targetHeadingIdentity: observed };
}
`],
    ['nested-block reassignment restoring canonical identity', 'ts', false, `
export function canvasReference(element: HTMLElement, target: { targetHeadingIdentity: string }) {
    let observed = element.getAttribute("id") ?? "";
    { observed = target.targetHeadingIdentity; }
    return { targetHeadingIdentity: observed };
}
`],
    ['true block-local declaration preserving the outer canonical binding', 'ts', false, `
export function canvasReference(element: HTMLElement, target: { targetHeadingIdentity: string }) {
    const observed = target.targetHeadingIdentity;
    { const observed = element.getAttribute("id"); console.log(observed); }
    return { targetHeadingIdentity: observed };
}
`]
];

for (const [name, extension, rejected, source] of reviewedLocalFlows)
{
    test(`reviewed local flow: ${name}`, (t) =>
    {
        const repositoryRoot = fixture(t);
        write(repositoryRoot, extension === 'cs'
            ? 'src/backend/Services/Authoring/AuthoringCanvasReferenceLocalFlow.cs'
            : 'src/frontend/canvas-reference.ts', source);

        const result = checkAuthoringCanvasReferenceAuthority(repositoryRoot);
        if (rejected)
        {
            assert.equal(result.length, 1);
            assert.match(result[0], domAuthorityViolation);
        }
        else
        {
            assert.deepEqual(result, []);
        }
    });
}

for (const [name, initial, replacement, rejected] of [
    ['introduces DOM identity', 'target.targetHeadingIdentity', 'element.getAttribute("id") ?? ""', true],
    ['restores canonical identity', 'element.getAttribute("id") ?? ""', 'target.targetHeadingIdentity', false]
])
{
    test(`frontend var redeclaration in a nested block ${name}`, (t) =>
    {
        const repositoryRoot = fixture(t);
        write(repositoryRoot, 'src/frontend/canvas-reference.ts', `
export function canvasReference(element: HTMLElement, target: { targetHeadingIdentity: string }) {
    var observed = ${initial};
    { var observed = ${replacement}; }
    return { targetHeadingIdentity: observed };
}
`);

        const result = checkAuthoringCanvasReferenceAuthority(repositoryRoot);
        if (rejected)
        {
            assert.equal(result.length, 1);
            assert.match(result[0], domAuthorityViolation);
        }
        else
        {
            assert.deepEqual(result, []);
        }
    });
}

for (const [name, rejected, source] of [
    ['a conditional canonical write cannot erase the unexecuted DOM path', true, `
export function canvasReference(element: HTMLElement, target: { targetHeadingIdentity: string }, allow: boolean) {
    let observed = element.getAttribute("id");
    if (allow) { observed = target.targetHeadingIdentity; }
    return { targetHeadingIdentity: observed };
}
`],
    ['an uncalled function cannot erase the outer DOM binding', true, `
let observed = document.querySelector("article")?.id;
function paint(target: { targetHeadingIdentity: string }) { observed = target.targetHeadingIdentity; }
export const canvasReferenceTarget = { targetHeadingIdentity: observed };
`],
    ['a canonical write is visible within its conditional block', false, `
export function canvasReference(element: HTMLElement, target: { targetHeadingIdentity: string }, allow: boolean) {
    let observed = element.getAttribute("id");
    if (allow) {
        observed = target.targetHeadingIdentity;
        return { targetHeadingIdentity: observed };
    }
    return null;
}
`]
])
{
    test(`binding flow preserves refusal boundaries: ${name}`, (t) =>
    {
        const repositoryRoot = fixture(t);
        write(repositoryRoot, 'src/frontend/canvas-reference.ts', source);
        const result = checkAuthoringCanvasReferenceAuthority(repositoryRoot);
        if (rejected)
        {
            assert.equal(result.length, 1);
            assert.match(result[0], domAuthorityViolation);
        }
        else
        {
            assert.deepEqual(result, []);
        }
    });
}

const reviewedExpressionFlows = [
    ['canonical frontend conditional comparisons with a DOM presence guard', 'ts', false, `
type Reference = { targetHeadingIdentity: string };
export function canvasReference(target: Reference, references: Reference[], allow: boolean) {
    const present = document.querySelector('h2') !== null;
    return references.some(r => allow ? r.targetHeadingIdentity === target.targetHeadingIdentity && present : r.targetHeadingIdentity === target.targetHeadingIdentity);
}
`],
    ...['c.TargetHeadingIdentity.Equals(target.TargetHeadingIdentity)', 'c.TargetHeadingIdentity == target.TargetHeadingIdentity']
        .map(comparison => [`canonical backend conditional comparison ${comparison}`, 'cs', false, `
public sealed class AuthoringCanvasReferenceExpressionFlow
{
    public object Find(System.Xml.XmlDocument document, AuthoringCanvasReferenceTarget target, IEnumerable<AuthoringCanvasReferenceTarget> candidates, bool allow)
    {
        var present = document.SelectSingleNode("//*[@id]") != null;
        return candidates.Any(c => allow ? c.TargetHeadingIdentity == target.TargetHeadingIdentity && present : ${comparison});
    }
}
`]),
    ...[
        ['DOM binding survives an uncalled annotated function', 'element.getAttribute("id")', 'target.targetHeadingIdentity', true],
        ['canonical binding survives an uncalled annotated function', 'target.targetHeadingIdentity', 'element.getAttribute("id")', false]
    ].map(([name, initial, replacement, rejected]) => [name, 'ts', rejected, `
export function canvasReference(element: HTMLElement, target: { targetHeadingIdentity: string }) {
    let observed = ${initial};
    function paint(): void { observed = ${replacement}; }
    return { targetHeadingIdentity: observed };
}
`]),
    ...[
        ['DOM binding survives an uncalled expression arrow', 'element.getAttribute("id")', 'target.targetHeadingIdentity', true],
        ['canonical binding survives an uncalled expression arrow', 'target.targetHeadingIdentity', 'element.getAttribute("id")', false]
    ].map(([name, initial, replacement, rejected]) => [name, 'ts', rejected, `
export function canvasReference(element: HTMLElement, target: { targetHeadingIdentity: string }) {
    let observed = ${initial};
    const paint = () => (observed = ${replacement});
    return { targetHeadingIdentity: observed };
}
`])
];

for (const [name, extension, rejected, source] of reviewedExpressionFlows)
{
    test(`reviewed expression flow: ${name}`, (t) =>
    {
        const repositoryRoot = fixture(t);
        write(repositoryRoot, extension === 'cs'
            ? 'src/backend/Services/Authoring/AuthoringCanvasReferenceExpressionFlow.cs'
            : 'src/frontend/canvas-reference.ts', source);
        const result = checkAuthoringCanvasReferenceAuthority(repositoryRoot);
        if (rejected)
        {
            assert.equal(result.length, 1);
            assert.match(result[0], domAuthorityViolation);
        }
        else
        {
            assert.deepEqual(result, []);
        }
    });
}

const expressionBoundaryControls = [
    ...[true, false].map(domFirst => [`DOM identity in the ${domFirst ? 'first' : 'second'} comparison arm remains rejected`, 'ts', true, `
type Reference = { targetHeadingIdentity: string };
export function canvasReference(target: Reference, references: Reference[], allow: boolean) {
    const observed = document.querySelector('h2')?.id;
    return references.some(r => allow ? r.targetHeadingIdentity === ${domFirst ? 'observed' : 'target.targetHeadingIdentity'} : r.targetHeadingIdentity === ${domFirst ? 'target.targetHeadingIdentity' : 'observed'});
}
`]),
    ['DOM Equals receiver in a conditional arm remains rejected', 'cs', true, `
public sealed class AuthoringCanvasReferenceExpressionFlow
{
    public object Find(System.Xml.XmlElement element, AuthoringCanvasReferenceTarget target, IEnumerable<AuthoringCanvasReferenceTarget> candidates, bool allow)
    {
        var observed = element.GetAttribute("id");
        return candidates.Any(c => allow ? c.TargetHeadingIdentity == target.TargetHeadingIdentity : observed.Equals(c.TargetHeadingIdentity));
    }
}
`],
    ...[
        ['annotated function', 'function paint(): void { const targetHeadingIdentity = element.getAttribute("id"); }'],
        ['expression arrow', 'const paint = () => ({ targetHeadingIdentity: element.getAttribute("id") });']
    ].map(([name, definition]) => [`actual identity writes inside an uncalled ${name} remain scanned`, 'ts', true, `
export function canvasReference(element: HTMLElement, target: { targetHeadingIdentity: string }) {
    ${definition}
    return { targetHeadingIdentity: target.targetHeadingIdentity };
}
`]),
    ...['function paint() { observed = REPLACEMENT; }', 'const paint = () => observed = REPLACEMENT;']
        .flatMap(definition => [true, false].map(domInitial => [`${definition} preserves ${domInitial ? 'DOM' : 'canonical'} outer binding`, 'ts', domInitial, `
export function canvasReference(element: HTMLElement, target: { targetHeadingIdentity: string }) {
    let observed = ${domInitial ? 'element.getAttribute("id")' : 'target.targetHeadingIdentity'};
    ${definition.replace('REPLACEMENT', domInitial ? 'target.targetHeadingIdentity' : 'element.getAttribute("id")')}
    return { targetHeadingIdentity: observed };
}
`])),
    ['an object return annotation does not execute its function', 'ts', false, `
export function canvasReference(element: HTMLElement, target: { targetHeadingIdentity: string | null }) {
    let observed = target.targetHeadingIdentity;
    function paint(): { heading: string | null } {
        observed = element.getAttribute("id");
        return { heading: observed };
    }
    return { targetHeadingIdentity: observed };
}
`],
    ['a function return annotation is not an executable arrow', 'ts', true, `
export function canvasReference(element: HTMLElement, target: { targetHeadingIdentity: string | null }) {
    let observed = element.getAttribute("id");
    function paint(): () => void {
        observed = target.targetHeadingIdentity;
        return () => {};
    }
    return { targetHeadingIdentity: observed };
}
`],
    ...[true, false].map(domInitial => [`an annotated object method preserves its ${domInitial ? 'DOM' : 'canonical'} outer binding`, 'ts', domInitial, `
export function canvasReference(element: HTMLElement, target: { targetHeadingIdentity: string | null }) {
    let observed = ${domInitial ? 'element.getAttribute("id")' : 'target.targetHeadingIdentity'};
    const controller = { paint(): void { observed = ${domInitial ? 'target.targetHeadingIdentity' : 'element.getAttribute("id")'}; } };
    return { targetHeadingIdentity: observed };
}
`]),
    ...[true, false].map(domReplacement => [`a directly invoked arrow executes its ${domReplacement ? 'DOM' : 'canonical'} assignment`, 'ts', domReplacement, `
export function canvasReference(element: HTMLElement, target: { targetHeadingIdentity: string | null }) {
    let observed = ${domReplacement ? 'target.targetHeadingIdentity' : 'element.getAttribute("id")'};
    (() => (observed = ${domReplacement ? 'element.getAttribute("id")' : 'target.targetHeadingIdentity'}))();
    return { targetHeadingIdentity: observed };
}
`]),
    ...[true, false].map(domReplacement => [`a C# switch arm executes its ${domReplacement ? 'DOM' : 'canonical'} assignment`, 'cs', domReplacement, `
public sealed class AuthoringCanvasReferenceExpressionFlow
{
    public object Create(System.Xml.XmlElement element, AuthoringCanvasReferenceTarget target, bool allow)
    {
        var observed = ${domReplacement ? 'target.TargetHeadingIdentity' : 'element.GetAttribute("id")'};
        var display = allow switch { _ => observed = ${domReplacement ? 'element.GetAttribute("id")' : 'target.TargetHeadingIdentity'} };
        return target with { TargetHeadingIdentity = observed };
    }
}
`])
];

for (const [name, extension, rejected, source] of expressionBoundaryControls)
{
    test(`expression boundary control: ${name}`, (t) =>
    {
        const repositoryRoot = fixture(t);
        write(repositoryRoot, extension === 'cs'
            ? 'src/backend/Services/Authoring/AuthoringCanvasReferenceExpressionFlow.cs'
            : 'src/frontend/canvas-reference.ts', source);
        const result = checkAuthoringCanvasReferenceAuthority(repositoryRoot);
        if (rejected)
        {
            assert.equal(result.length, 1);
            assert.match(result[0], domAuthorityViolation);
        }
        else
        {
            assert.deepEqual(result, []);
        }
    });
}
