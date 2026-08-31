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
        'src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs'
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
    assert.deepEqual(projectContentFieldContracts({ root: temporary }), projectContentFieldContracts());

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
