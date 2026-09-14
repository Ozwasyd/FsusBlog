import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dictionaryPath = 'src/backend/Services/SearchIndexService.Dictionary.cs';
const testPath = 'tests/backend/Unit/SearchIndexServiceTests.cs';

function extractCSharpMethodBody(source, methodName, maskCSharpTrivia)
{
    const masked = maskCSharpTrivia(source);
    const declaration = new RegExp(
        `\\b(?:public|internal|private|protected)\\s+(?:static\\s+)?` +
      `(?:[A-Za-z_][A-Za-z0-9_<>,.?\\[\\]]*\\s+)+${methodName}\\s*\\([^)]*\\)\\s*\\{`,
        'u'
    ).exec(masked);
    if (!declaration)
    {
        return null;
    }

    const openingIndex = declaration.index + declaration[0].lastIndexOf('{');
    let depth = 0;
    for (let index = openingIndex; index < masked.length; index += 1)
    {
        if (masked[index] === '{')
        {
            depth += 1;
        }
        else if (masked[index] === '}')
        {
            depth -= 1;
            if (depth === 0)
            {
                return source.slice(openingIndex + 1, index);
            }
        }
    }
    return null;
}

export function inspectSearchUtf8ScalarOwner(productionSource, testSource, maskCSharpTrivia)
{
    const violations = [];
    const ownerPattern = /\binternal\s+static\s+int\s+GetUtf8ScalarLength\s*\(\s*byte\s+value\s*\)/gu;
    const ownerMatches = [...productionSource.matchAll(ownerPattern)];
    const tokenizerIndex = productionSource.indexOf('private ref struct SearchTokenizer');
    if (ownerMatches.length !== 1 || tokenizerIndex < 0 || ownerMatches[0].index > tokenizerIndex)
    {
        violations.push('production must keep one outer internal static GetUtf8ScalarLength owner');
    }
    if (productionSource.includes('SearchTokenizer.GetUtf8ScalarLength'))
    {
        violations.push('production callers must consume the outer UTF-8 scalar-length owner');
    }

    const compilerIndex = productionSource.indexOf('private static class SearchDictionaryCompiler');
    const runtimeIndex = productionSource.indexOf('private sealed unsafe class SearchDictionaryRuntime');
    if (
        compilerIndex < 0 ||
    runtimeIndex < 0 ||
    !productionSource.slice(compilerIndex, runtimeIndex).includes('GetUtf8ScalarLength(') ||
    !productionSource.slice(runtimeIndex).includes('GetUtf8ScalarLength(')
    )
    {
        violations.push('dictionary compiler and runtime reader must consume GetUtf8ScalarLength');
    }
    if (ownerPattern.test(testSource))
    {
        violations.push('tests must not copy the UTF-8 scalar-length algorithm');
    }

    const scalarTheory = extractCSharpMethodBody(
        testSource,
        'GetUtf8ScalarLength_ReturnsCorrectRuneLength',
        maskCSharpTrivia
    );
    if (!scalarTheory)
    {
        violations.push('UTF-8 scalar-length Theory must remain executable');
    }
    else
    {
        if (!scalarTheory.includes('SearchIndexService.GetUtf8ScalarLength(inputByte)'))
        {
            violations.push('UTF-8 scalar-length Theory must call the production owner directly');
        }
        if (/\b(?:GetNestedType|GetMethod|Invoke)\s*\(/u.test(scalarTheory))
        {
            violations.push('UTF-8 scalar-length Theory must not use reflection');
        }
        if (/\breturn\s*;/u.test(scalarTheory))
        {
            violations.push('UTF-8 scalar-length Theory must not return before asserting');
        }
        if (!scalarTheory.includes('Assert.Equal(expected, actual)'))
        {
            violations.push('UTF-8 scalar-length Theory must assert the production mapping');
        }
    }

    const readPath = extractCSharpMethodBody(
        testSource,
        'TokenizeForTests_Utf8ScalarLengthOwnerDrivesDictionaryReadPath',
        maskCSharpTrivia
    );
    if (
        !readPath ||
    !readPath.includes('SearchIndexService.TokenizeForTests(') ||
    !readPath.includes('Assert.Collection(')
    )
    {
        violations.push('dictionary read-path test must execute tokenizer assertions');
    }
    return violations;
}

export function verifyFactWrappersAndSearchUtf8ScalarOwner(
    root,
    fail,
    maskCSharpTrivia,
    verifyFactWrappersDeleted
)
{
    verifyFactWrappersDeleted();
    const productionSource = readFileSync(resolve(root, dictionaryPath), 'utf8');
    const testSource = readFileSync(resolve(root, testPath), 'utf8');
    for (const violation of inspectSearchUtf8ScalarOwner(productionSource, testSource, maskCSharpTrivia))
    {
        fail(`search-index UTF-8 scalar governance: ${violation}`);
    }

    const renamedOwner = productionSource.replace(
        'internal static int GetUtf8ScalarLength(byte value)',
        'internal static int RenamedUtf8ScalarLength(byte value)'
    );
    if (!inspectSearchUtf8ScalarOwner(renamedOwner, testSource, maskCSharpTrivia).some(
        (violation) => violation.includes('one outer internal static')
    ))
    {
        fail('search-index UTF-8 scalar governance mutation must reject owner rename');
    }

    const copiedAlgorithm = `${testSource}\ninternal static int GetUtf8ScalarLength(byte value) => 1;\n`;
    if (!inspectSearchUtf8ScalarOwner(productionSource, copiedAlgorithm, maskCSharpTrivia).some(
        (violation) => violation.includes('must not copy')
    ))
    {
        fail('search-index UTF-8 scalar governance mutation must reject a test-only helper');
    }

    const reflectionFallback = testSource.replace(
        'int actual = SearchIndexService.GetUtf8ScalarLength(inputByte);',
        [
            'var type = typeof(SearchIndexService).GetNestedType("SearchDictionaryReader");',
            'if (type == null)',
            '    return;',
            'int actual = expected;'
        ].join('\n')
    );
    const reflectionViolations = inspectSearchUtf8ScalarOwner(
        productionSource,
        reflectionFallback,
        maskCSharpTrivia
    );
    if (
        !reflectionViolations.some((violation) => violation.includes('must call')) ||
    !reflectionViolations.some((violation) => violation.includes('must not use reflection')) ||
    !reflectionViolations.some((violation) => violation.includes('must not return'))
    )
    {
        fail('search-index UTF-8 scalar governance mutation must reject reflection with early return');
    }
}
