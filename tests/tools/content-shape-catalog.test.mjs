import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    CONTENT_SHAPE_BOUNDARY_KINDS,
    CONTENT_SHAPE_SCRIPT_CLASSES,
    contentShapeBoundaryPlan,
    contentShapeCatalogDigest,
    projectContentFieldContracts,
    readContentShapeAuthority,
    shapeContentDigest,
    stableStringify,
    validateContentShapeAuthority,
    validateContentShapeGovernance
} from '../../tools/testing/content-shape-catalog.mjs';
import {
    fixtureCatalogDigest,
    readFixtureCatalogs
} from '../../tools/testing/fixture-catalog.mjs';
import { validateJsonSchema } from '../../tools/test-matrix/schema-validator/validate.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');

function clonedAuthority()
{
    return structuredClone(readContentShapeAuthority());
}

function temporaryProductionRoot(t)
{
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'content-field-projection-'));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    for (const relative of [
        'src/backend/Services/Articles/ArticlePublicationValidator.cs',
        'src/backend/Models/Dtos/CommentDto.cs',
        'src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs',
        'src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Files.cs'
    ])
    {
        const target = path.join(temporary, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(root, relative), target);
    }
    return temporary;
}

function mutateProductionSource(t, relative, before, after, { all = false } = {})
{
    const temporary = temporaryProductionRoot(t);
    const target = path.join(temporary, relative);
    const original = fs.readFileSync(target, 'utf8');
    assert.equal(original.includes(before), true, `mutation source is missing: ${before}`);
    fs.writeFileSync(target, all ? original.replaceAll(before, after) : original.replace(before, after));
    return temporary;
}

function mutateProductionSources(t, relative, replacements)
{
    const temporary = temporaryProductionRoot(t);
    const target = path.join(temporary, relative);
    let source = fs.readFileSync(target, 'utf8');
    for (const [before, after, all = false] of replacements)
    {
        assert.equal(source.includes(before), true, `mutation source is missing: ${before}`);
        source = all ? source.replaceAll(before, after) : source.replace(before, after);
    }
    fs.writeFileSync(target, source);
    return temporary;
}

function assertProductionMutationPreserves(t, relative, replacements)
{
    const temporary = mutateProductionSources(t, relative, replacements);
    assert.deepEqual(projectContentFieldContracts({ root: temporary }), projectContentFieldContracts());
}

function assertProductionMutationsInvalidate(t, relative, replacements)
{
    const temporary = mutateProductionSources(t, relative, replacements);
    let changed = false;
    try
    {
        changed = stableStringify(projectContentFieldContracts({ root: temporary }))
            !== stableStringify(projectContentFieldContracts());
    }
    catch
    {
        changed = true;
    }
    assert.equal(changed, true, `${relative} semantic alias mutation must invalidate the projection`);
}

function assertProductionMutationInvalidates(t, relative, before, after, options)
{
    const temporary = mutateProductionSource(t, relative, before, after, options);
    let projectionChanged = false;
    try
    {
        projectionChanged = stableStringify(projectContentFieldContracts({ root: temporary }))
            !== stableStringify(projectContentFieldContracts());
    }
    catch
    {
        projectionChanged = true;
    }
    assert.equal(projectionChanged, true, `${relative} mutation must change or reject the projection`);
    assert.notEqual(validateContentShapeAuthority({
        root: temporary,
        authority: clonedAuthority(),
        scanGovernance: false
    }).length, 0, `${relative} mutation must invalidate the generated authority`);
}

test('ContentShapeCatalog is closed, versioned, locale-complete, and production-bound', () =>
{
    assert.deepEqual(validateContentShapeAuthority(), []);
    const authority = readContentShapeAuthority();
    assert.deepEqual(authority.catalog.scriptClasses.map((item) => item.id), [...CONTENT_SHAPE_SCRIPT_CLASSES].sort());
    assert.deepEqual(authority.catalog.boundaryCaseKinds, [...CONTENT_SHAPE_BOUNDARY_KINDS].sort());
    assert.deepEqual(projectContentFieldContracts(), authority.fields);
    assert.match(contentShapeCatalogDigest(authority), /^sha256:[a-f0-9]{64}$/u);
    assert.equal(authority.catalog.shapes.every((shape) => shape.contentDigest === shapeContentDigest(shape)), true);
    const schema = JSON.parse(fs.readFileSync(path.join(root, 'config/schemas/content-shape-catalog.schema.json'), 'utf8'));
    assert.deepEqual(validateJsonSchema(authority.catalog, schema), []);
    const unknown = structuredClone(authority.catalog);
    unknown.shapes[0].implementation = 'forbidden';
    assert.match(validateJsonSchema(unknown, schema).join('\n'), /must NOT have additional properties/u);
});

test('field projection distinguishes UTF-16 character authority from UTF-8 byte authority', () =>
{
    const plan = contentShapeBoundaryPlan();
    const ids = plan.cases.map((item) => item.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids.filter((id) => id.startsWith('article.title.characters.')).length, 5);
    assert.equal(ids.filter((id) => id.startsWith('comment.content.characters.')).length, 5);
    assert.equal(ids.filter((id) => id.startsWith('comment.content.utf8-bytes.')).length, 5);
    assert.equal(ids.some((id) => id.startsWith('article.title.utf8-bytes.')), false);
    assert.match(plan.planDigest, /^sha256:[a-f0-9]{64}$/u);
});

test('catalog rejects unknown, duplicate, ambiguous, and eligibility mutations', () =>
{
    const unknown = clonedAuthority();
    unknown.catalog.extra = true;
    assert.match(validateContentShapeAuthority({ authority: unknown, scanGovernance: false }).join('\n'), /unknown field extra/u);

    const duplicate = clonedAuthority();
    duplicate.catalog.shapes.push(structuredClone(duplicate.catalog.shapes[0]));
    assert.match(validateContentShapeAuthority({ authority: duplicate, scanGovernance: false }).join('\n'), /duplicate shape ID/u);

    const unknownScript = clonedAuthority();
    unknownScript.catalog.shapes[0].scriptClasses = ['all-unicode'];
    assert.match(validateContentShapeAuthority({ authority: unknownScript, scanGovernance: false }).join('\n'), /unknown script all-unicode/u);

    const eligibility = clonedAuthority();
    eligibility.catalog.shapes.find((shape) => shape.id === 'script.latin-basic').scriptClasses = ['zero-width'];
    assert.match(validateContentShapeAuthority({ authority: eligibility, scanGovernance: false }).join('\n'), /eligibility isolation/u);

    const tamper = clonedAuthority();
    tamper.catalog.shapes[0].target.ordinaryUtf16Units += 1;
    assert.match(validateContentShapeAuthority({ authority: tamper, scanGovernance: false }).join('\n'), /stale or tampered/u);
});

test('locale and production contract drift invalidate the authority', () =>
{
    const locale = clonedAuthority();
    locale.locales.locales.push({
        code: 'ar-SA', bcp47: 'ar-SA', documentLanguage: 'ar-SA', intlLocale: 'ar-SA', openGraphLocale: 'ar_SA',
        nativeName: 'Arabic', englishName: 'Arabic', direction: 'rtl', script: 'Arab', status: 'enabled', aliases: ['ar']
    });
    assert.match(validateContentShapeAuthority({ authority: locale, scanGovernance: false }).join('\n'), /must match bidirectionally/u);

    const field = clonedAuthority();
    field.fields.fields.find((item) => item.id === 'article.title').maxCharacters += 1;
    assert.match(validateContentShapeAuthority({ authority: field, scanGovernance: false }).join('\n'), /projection is stale/u);
    assert.notEqual(contentShapeCatalogDigest(field), contentShapeCatalogDigest(readContentShapeAuthority()));
    assert.notEqual(
        fixtureCatalogDigest({ ...readFixtureCatalogs(), contentShapeAuthority: field }),
        fixtureCatalogDigest()
    );
});

test('field projection binds contract fragments instead of unrelated owner file bytes', (t) =>
{
    const temporary = temporaryProductionRoot(t);
    const endpoint = path.join(temporary, 'src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs');
    fs.appendFileSync(endpoint, '\n// Unrelated endpoint implementation change.\n');
    const ambientOverrides = new Map([
        ['PATH', '/definitely-not-a-toolchain'],
        ['DOTNET_ROOT', '/definitely-not-a-dotnet-root'],
        ['MSBuildSDKsPath', '/definitely-not-msbuild-sdks'],
        ['CscToolPath', '/definitely-not-roslyn'],
        ['LangVersion', 'latest'],
        ['TRUSTED_PLATFORM_ASSEMBLIES', '/definitely-not-a-tpa-list']
    ]);
    const originalEnvironment = new Map([...ambientOverrides.keys()].map((name) => [name, process.env[name]]));
    for (const [name, value] of ambientOverrides) process.env[name] = value;
    try
    {
        assert.deepEqual(projectContentFieldContracts({ root: temporary }), projectContentFieldContracts());
    }
    finally
    {
        for (const [name, value] of originalEnvironment)
        {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }

    const article = path.join(temporary, 'src/backend/Services/Articles/ArticlePublicationValidator.cs');
    fs.writeFileSync(article, fs.readFileSync(article, 'utf8').replace(
        'public const int MaxTitleLength = 256;',
        'public const int MaxTitleLength = 257;'
    ));
    assert.match(validateContentShapeAuthority({
        root: temporary,
        authority: clonedAuthority(),
        scanGovernance: false
    }).join('\n'), /projection is stale/u);
});

test('field projection rejects comment-hidden normalization and boolean control-flow drift', (t) =>
{
    const endpoint = 'src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs';
    assertProductionMutationInvalidates(
        t,
        endpoint,
        '&& content.Length <= policy.CommentMaxChars',
        '|| content.Length <= policy.CommentMaxChars'
    );
    assertProductionMutationInvalidates(
        t,
        endpoint,
        'string content = request.Content?.Trim() ?? string.Empty;',
        'string content = request.Content?.Normalize() ?? string.Empty;\n            // string content = request.Content?.Trim() ?? string.Empty;',
        { all: true }
    );
});

test('field projection binds post-declaration local dataflow through validation uses', (t) =>
{
    assertProductionMutationInvalidates(
        t,
        'src/backend/Services/Articles/ArticlePublicationValidator.cs',
        'string title = input.Title?.Trim() ?? string.Empty;',
        'string title = input.Title?.Trim() ?? string.Empty;\n        title = title.Normalize();'
    );
    assertProductionMutationInvalidates(
        t,
        'src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs',
        'string content = request.Content?.Trim() ?? string.Empty;',
        'string content = request.Content?.Trim() ?? string.Empty;\n            content = content.Normalize();',
        { all: true }
    );
});

test('field projection resolves the exact direct predicate overload and active preprocessor tree', (t) =>
{
    const endpoint = 'src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs';
    const predicate = `private static bool IsCommentContentWithinLimit(string content, AnonymousCommentPolicySnapshot policy)
        => !string.IsNullOrWhiteSpace(content)
            && content.Length <= policy.CommentMaxChars
            && Encoding.UTF8.GetByteCount(content) <= policy.CommentMaxUtf8Bytes;`;
    assertProductionMutationInvalidates(t, endpoint, predicate, `private static bool IsCommentContentWithinLimit(
        string content,
        AnonymousCommentPolicySnapshot policy,
        bool legacy)
        => !string.IsNullOrWhiteSpace(content)
            && content.Length <= policy.CommentMaxChars
            && Encoding.UTF8.GetByteCount(content) <= policy.CommentMaxUtf8Bytes;

    private static bool IsCommentContentWithinLimit(string content, AnonymousCommentPolicySnapshot policy)
        => !string.IsNullOrWhiteSpace(content)
            || content.Length <= policy.CommentMaxChars
            && Encoding.UTF8.GetByteCount(content) <= policy.CommentMaxUtf8Bytes;`);
    assertProductionMutationInvalidates(t, endpoint, predicate, `#if false
    ${predicate}
#endif
    private static bool IsCommentContentWithinLimit(string content, AnonymousCommentPolicySnapshot policy)
        => !string.IsNullOrWhiteSpace(content)
            || content.Length <= policy.CommentMaxChars
            && Encoding.UTF8.GetByteCount(content) <= policy.CommentMaxUtf8Bytes;`);
});

test('field projection excludes nested DTO properties and nested limit constants', (t) =>
{
    const dto = 'src/backend/Models/Dtos/CommentDto.cs';
    const property = `[Required]
    [MaxLength(CommentLimits.ContentMaxChars, ErrorMessage = "评论内容不能超过1000字")]
    public required string Content`;
    assertProductionMutationInvalidates(t, dto, property, `private sealed class LegacyContentContract
    {
        [Required]
        [MaxLength(CommentLimits.ContentMaxChars)]
        public required string Content { get; init; }
    }

    [Required]
    [MaxLength(CommentLimits.HardContentMaxChars, ErrorMessage = "评论内容不能超过1000字")]
    public required string? Content`);
    assertProductionMutationInvalidates(
        t,
        dto,
        'public const int ContentMinChars = 100;',
        `public const int ContentMinChars = 101;

    private static class LegacyLimits
    {
        public const int ContentMinChars = 100;
    }`
    );
});

test('field projection binds exact constant, validation action, attribute, and Encoding symbols', (t) =>
{
    const article = 'src/backend/Services/Articles/ArticlePublicationValidator.cs';
    const dto = 'src/backend/Models/Dtos/CommentDto.cs';
    const endpoint = 'src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs';
    assertProductionMutationInvalidates(
        t,
        article,
        'bool hardWriteFailure = false;',
        'bool hardWriteFailure = false;\n        const int MaxTitleLength = 257;'
    );
    assertProductionMutationInvalidates(
        t,
        article,
        'bool hardWriteFailure = false;',
        `bool hardWriteFailure = false;
        static void AddError(List<PrepublishIssue> target, string code, string message)
            => target.Add(new PrepublishIssue("warning", code, message));`
    );
    assertProductionMutationPreserves(t, dto, [
        ['using System.ComponentModel.DataAnnotations;', `using System.ComponentModel.DataAnnotations;
using RequiredAlias = System.ComponentModel.DataAnnotations.RequiredAttribute;
using MaxLengthAlias = System.ComponentModel.DataAnnotations.MaxLengthAttribute;`],
        ['[Required]\n    [MaxLength(', '[RequiredAlias]\n    [MaxLengthAlias(']
    ]);
    assertProductionMutationPreserves(t, endpoint, [
        ['using System.Text;', 'using TextEncoding = System.Text.Encoding;'],
        ['Encoding.UTF8.GetByteCount(content)', 'TextEncoding.UTF8.GetByteCount(content)', true]
    ]);
    assertProductionMutationsInvalidate(t, dto, [
        ['using System.ComponentModel.DataAnnotations;', `using System.ComponentModel.DataAnnotations;
using RequiredAlias = System.ObsoleteAttribute;`],
        ['[Required]\n    [MaxLength(', '[RequiredAlias]\n    [MaxLength(']
    ]);
    assertProductionMutationsInvalidate(t, dto, [
        ['using System.ComponentModel.DataAnnotations;', `using System.ComponentModel.DataAnnotations;
using RequiredAlias = System.ComponentModel.DataAnnotations.RequiredAttribute;`],
        ['namespace FsusBlog.Server.Models.Dtos;', `namespace System.ComponentModel.DataAnnotations
{
    [AttributeUsage(AttributeTargets.Property)]
    internal sealed class RequiredAttribute : Attribute
    {
    }
}

namespace FsusBlog.Server.Models.Dtos
{`],
        ['public string GetTextToCheck() => Content;\n}', 'public string GetTextToCheck() => Content;\n}\n}'],
        ['[Required]\n    [MaxLength(', '[RequiredAlias]\n    [MaxLength(']
    ]);
    assertProductionMutationsInvalidate(t, endpoint, [
        ['using System.Text;', `using System.Text;
using TextEncoding = FsusBlog.Server.Modules.Endpoints.Binary.FakeEncoding;`],
        ['namespace FsusBlog.Server.Modules.Endpoints.Binary;', `namespace FsusBlog.Server.Modules.Endpoints.Binary;

internal static class FakeEncoding
{
    internal static FakeEncoder UTF8 { get; } = new();
}

internal sealed class FakeEncoder
{
    internal int GetByteCount(string value) => value.Length;
}`],
        ['Encoding.UTF8.GetByteCount(content)', 'TextEncoding.UTF8.GetByteCount(content)', true]
    ]);
});

test('field projection closes ref alias, ref helper, local function, lambda, and transitive partial flows', (t) =>
{
    const article = 'src/backend/Services/Articles/ArticlePublicationValidator.cs';
    const endpoint = 'src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs';
    for (const replacement of [
        `string title = input.Title?.Trim() ?? string.Empty;
        ref string titleAlias = ref title;
        titleAlias = titleAlias.Normalize();`,
        `string title = input.Title?.Trim() ?? string.Empty;
        NormalizeTitle(ref title);
        static void NormalizeTitle(ref string value) => value = value.Normalize();`,
        `string title = input.Title?.Trim() ?? string.Empty;
        title = NormalizeTitle(title);
        static string NormalizeTitle(string value) => NormalizeTitleCore(value);
        static string NormalizeTitleCore(string value) => value.Normalize();`,
        `string title = input.Title?.Trim() ?? string.Empty;
        Func<string, string> normalizeTitle = value => value.Normalize();
        title = normalizeTitle(title);`
    ])
    {
        assertProductionMutationInvalidates(
            t,
            article,
            'string title = input.Title?.Trim() ?? string.Empty;',
            replacement
        );
    }

    const temporary = mutateProductionSources(t, endpoint, [[
        'string content = request.Content?.Trim() ?? string.Empty;',
        'string content = NormalizeContentContract(request.Content?.Trim() ?? string.Empty);',
        true
    ]]);
    const partial = path.join(temporary, 'src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Files.cs');
    fs.appendFileSync(partial, `

public static partial class BinaryEndpoints
{
    private static string NormalizeContentContract(string value) => value.Normalize();
}
`);
    assert.notDeepEqual(projectContentFieldContracts({ root: temporary }), projectContentFieldContracts());
});

test('field projection ignores semantically irrelevant GC.KeepAlive statements', (t) =>
{
    assertProductionMutationPreserves(t, 'src/backend/Services/Articles/ArticlePublicationValidator.cs', [[
        'string title = input.Title?.Trim() ?? string.Empty;',
        'string title = input.Title?.Trim() ?? string.Empty;\n        GC.KeepAlive(title);'
    ]]);
    assertProductionMutationPreserves(t, 'src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs', [[
        'string content = request.Content?.Trim() ?? string.Empty;',
        'string content = request.Content?.Trim() ?? string.Empty;\n            GC.KeepAlive(content);',
        true
    ]]);
});

test('field projection rejects production compilation diagnostics', (t) =>
{
    assertProductionMutationInvalidates(
        t,
        'src/backend/Services/Articles/ArticlePublicationValidator.cs',
        'string title = input.Title?.Trim() ?? string.Empty;',
        'string title = ;'
    );
});

test('field projection binds CommentDto nullable, Required, and MaxLength declarations', (t) =>
{
    const dto = 'src/backend/Models/Dtos/CommentDto.cs';
    for (const [before, after] of [
        ['public required string Content', 'public required string? Content'],
        ['[Required]\n    [MaxLength(CommentLimits.ContentMaxChars', '[MaxLength(CommentLimits.ContentMaxChars'],
        ['[MaxLength(CommentLimits.ContentMaxChars', '[MaxLength(CommentLimits.HardContentMaxChars']
    ])
    {
        assertProductionMutationInvalidates(t, dto, before, after);
    }
});

test('field projection resolves CommentLimits minimum, default, and hard-bound constants', (t) =>
{
    const dto = 'src/backend/Models/Dtos/CommentDto.cs';
    for (const [before, after] of [
        ['ContentMinChars = 100', 'ContentMinChars = 101'],
        ['ContentMinUtf8Bytes = 1024', 'ContentMinUtf8Bytes = 1025'],
        ['DefaultContentMaxChars = 1000', 'DefaultContentMaxChars = 1001'],
        ['DefaultContentMaxUtf8Bytes = 4096', 'DefaultContentMaxUtf8Bytes = 4097'],
        ['HardContentMaxChars = 3000', 'HardContentMaxChars = 3001'],
        ['HardContentMaxUtf8Bytes = 12288', 'HardContentMaxUtf8Bytes = 12289']
    ])
    {
        assertProductionMutationInvalidates(t, dto, before, after);
    }
});

test('field projection binds inclusive and exclusive operators in every production limit path', (t) =>
{
    const article = 'src/backend/Services/Articles/ArticlePublicationValidator.cs';
    const dto = 'src/backend/Models/Dtos/CommentDto.cs';
    const endpoint = 'src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs';
    for (const [relative, before, after] of [
        [article, 'title.Length > MaxTitleLength', 'title.Length >= MaxTitleLength'],
        [endpoint, 'content.Length <= policy.CommentMaxChars', 'content.Length < policy.CommentMaxChars'],
        [endpoint, 'Encoding.UTF8.GetByteCount(content) <= policy.CommentMaxUtf8Bytes', 'Encoding.UTF8.GetByteCount(content) < policy.CommentMaxUtf8Bytes'],
        [dto, 'value is >= ContentMinChars and <= HardContentMaxChars', 'value is > ContentMinChars and < HardContentMaxChars'],
        [dto, 'value is < ContentMinChars or > HardContentMaxChars', 'value is <= ContentMinChars or >= HardContentMaxChars']
    ])
    {
        assertProductionMutationInvalidates(t, relative, before, after);
    }
});

test('field projection rejects missing, extra, and reversed field inventories', () =>
{
    const missing = clonedAuthority();
    missing.fields.fields.pop();
    assert.match(validateContentShapeAuthority({ authority: missing, scanGovernance: false }).join('\n'), /projection is stale/u);

    const extra = clonedAuthority();
    extra.fields.fields.push({ ...structuredClone(extra.fields.fields[0]), id: 'article.extra' });
    assert.match(validateContentShapeAuthority({ authority: extra, scanGovernance: false }).join('\n'), /projection is stale/u);

    const reversed = clonedAuthority();
    reversed.fields.fields.reverse();
    assert.match(validateContentShapeAuthority({ authority: reversed, scanGovernance: false }).join('\n'), /projection is stale/u);
});

test('static governance rejects second authority, random-only, JS-length, ASCII proxy, and catch-all mutations', (t) =>
{
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'content-shape-governance-'));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    fs.mkdirSync(path.join(temporary, 'config/testing'), { recursive: true });
    fs.mkdirSync(path.join(temporary, 'tools/test-fixtures'), { recursive: true });
    const generatorPath = path.join(temporary, 'tools/test-fixtures/content-shape-generator.mjs');
    fs.copyFileSync(path.join(root, 'tools/test-fixtures/content-shape-generator.mjs'), generatorPath);
    assert.deepEqual(validateContentShapeGovernance({ root: temporary }), []);

    const original = fs.readFileSync(generatorPath, 'utf8');
    for (const [mutation, pattern] of [
        ['\nMath.random();\n', /runtime random/u],
        ['\nDate.now();\n', /wall clock/u],
        ['\nconst mode = "all-unicode";\n', /catch-all/u],
        ['\nconst bad = { characterCount: text.length };\n', /JS-length-only/u],
        ['\nconst bad = { utf8ByteCount: text.length };\n', /ASCII byte proxy/u]
    ])
    {
        fs.writeFileSync(generatorPath, `${original}${mutation}`);
        assert.match(validateContentShapeGovernance({ root: temporary }).join('\n'), pattern);
    }
    fs.writeFileSync(generatorPath, original);
    fs.writeFileSync(path.join(temporary, 'config/testing/content-shape-list.json'), '{}');
    assert.match(validateContentShapeGovernance({ root: temporary }).join('\n'), /second content shape/u);
});

test('canonical serialization changes when catalog content changes', () =>
{
    const original = readContentShapeAuthority();
    const changed = clonedAuthority();
    changed.catalog.generationVersion = 'unicode-boundary-v2';
    assert.notEqual(stableStringify(original.catalog), stableStringify(changed.catalog));
    assert.notEqual(contentShapeCatalogDigest(original), contentShapeCatalogDigest(changed));
});
