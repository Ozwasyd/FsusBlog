import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { maskCSharpTrivia } from '../test/csharp-source-mask.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const stableId = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;

export const contentShapeFiles = Object.freeze({
    catalog: path.join(repositoryRoot, 'config/testing/content-shape-catalog.json'),
    schema: path.join(repositoryRoot, 'config/schemas/content-shape-catalog.schema.json'),
    fields: path.join(repositoryRoot, 'config/testing/content-field-contracts.generated.json'),
    locales: path.join(repositoryRoot, 'src/shared/Contracts/Localization/locale-catalog.json')
});

export const CONTENT_SHAPE_SCRIPT_CLASSES = Object.freeze([
    'bidi',
    'combining',
    'cyrillic',
    'emoji-zwj',
    'fullwidth',
    'ja',
    'ko',
    'latin-basic',
    'latin-diacritics',
    'long-unbroken-token',
    'mixed-script',
    'zh-hans',
    'zh-hant',
    'zero-width'
]);

export const CONTENT_SHAPE_CONSUMER_DOMAINS = Object.freeze([
    'aeds', 'aot', 'article', 'comment', 'editor', 'hydration', 'moderation', 'search', 'visual'
]);

export const CONTENT_SHAPE_BOUNDARY_KINDS = Object.freeze([
    'max', 'max-minus-one', 'max-plus-one-negative', 'min', 'ordinary'
]);

export function stableStringify(value)
{
    if (value === null || typeof value !== 'object')
    {
        return JSON.stringify(value);
    }
    if (Array.isArray(value))
    {
        return `[${value.map(stableStringify).join(',')}]`;
    }
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export function sha256(value)
{
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function sha256Json(value)
{
    return sha256(stableStringify(value));
}

function readJson(file)
{
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function tokenizeCSharp(source)
{
    const masked = maskCSharpTrivia(source);
    return [...masked.matchAll(/[A-Za-z_][A-Za-z0-9_]*|[0-9][0-9_]*|=>|\?\?|\?\.|&&|\|\||<=|>=|==|!=|[{}()[\].,;:?=!<>+*/-]/gu)]
        .map((match) => Object.freeze({ value: match[0], offset: match.index }));
}

function matchingToken(tokens, start, open, close)
{
    let depth = 0;
    for (let index = start; index < tokens.length; index += 1)
    {
        if (tokens[index].value === open)
        {
            depth += 1;
        }
        else if (tokens[index].value === close && --depth === 0)
        {
            return index;
        }
    }
    throw new Error(`[content-shape] unmatched ${open} token`);
}

function namedTypeScope(tokens, name)
{
    const nameIndex = tokens.findIndex((token, index) => token.value === name
        && tokens.slice(Math.max(0, index - 4), index).some((candidate) => ['class', 'record'].includes(candidate.value)));
    if (nameIndex < 0)
    {
        throw new Error(`[content-shape] C# type ${name} is missing`);
    }
    const start = tokens.findIndex((token, index) => index > nameIndex && token.value === '{');
    if (start < 0)
    {
        throw new Error(`[content-shape] C# type ${name} has no body`);
    }
    return Object.freeze({ start: start + 1, end: matchingToken(tokens, start, '{', '}') });
}

function namedMethod(tokens, scope, name)
{
    for (let index = scope.start; index < scope.end; index += 1)
    {
        if (tokens[index].value !== name || tokens[index + 1]?.value !== '(')
        {
            continue;
        }
        const parametersEnd = matchingToken(tokens, index + 1, '(', ')');
        if (tokens[parametersEnd + 1]?.value === '=>')
        {
            const end = tokens.findIndex((token, candidate) => candidate > parametersEnd && token.value === ';');
            return Object.freeze({
                name,
                parameters: tokens.slice(index + 2, parametersEnd).map((token) => token.value),
                body: tokens.slice(parametersEnd + 2, end).map((token) => token.value),
                expressionBodied: true
            });
        }
        if (tokens[parametersEnd + 1]?.value === '{')
        {
            const bodyStart = parametersEnd + 1;
            const bodyEnd = matchingToken(tokens, bodyStart, '{', '}');
            return Object.freeze({
                name,
                parameters: tokens.slice(index + 2, parametersEnd).map((token) => token.value),
                body: tokens.slice(bodyStart + 1, bodyEnd).map((token) => token.value),
                expressionBodied: false
            });
        }
    }
    throw new Error(`[content-shape] C# method ${name} is missing from its production owner`);
}

function recordParameters(tokens, name)
{
    const nameIndex = tokens.findIndex((token, index) => token.value === name
        && tokens.slice(Math.max(0, index - 4), index).some((candidate) => candidate.value === 'record'));
    if (nameIndex < 0 || tokens[nameIndex + 1]?.value !== '(')
    {
        throw new Error(`[content-shape] primary record ${name} is missing`);
    }
    const end = matchingToken(tokens, nameIndex + 1, '(', ')');
    const result = {};
    let start = nameIndex + 2;
    let depth = 0;
    for (let index = start; index <= end; index += 1)
    {
        const value = tokens[index]?.value;
        if (['(', '[', '{'].includes(value)) depth += 1;
        if ([')', ']', '}'].includes(value)) depth -= 1;
        if ((value === ',' && depth === 0) || index === end)
        {
            const segment = tokens.slice(start, index).map((token) => token.value);
            const parameterName = [...segment].reverse().find((token) => /^[A-Za-z_]/u.test(token));
            const parameterNameIndex = segment.lastIndexOf(parameterName);
            result[parameterName] = Object.freeze({
                type: segment.slice(0, parameterNameIndex).join(''),
                nullable: segment.slice(0, parameterNameIndex).includes('?')
            });
            start = index + 1;
        }
    }
    return Object.freeze(result);
}

function integerConstants(tokens, scope, names)
{
    const declarations = new Map();
    for (let index = scope.start; index < scope.end; index += 1)
    {
        if (tokens[index].value !== 'const' || tokens[index + 1]?.value !== 'int') continue;
        const name = tokens[index + 2]?.value;
        if (tokens[index + 3]?.value !== '=') continue;
        const end = tokens.findIndex((token, candidate) => candidate > index + 3 && token.value === ';');
        declarations.set(name, tokens.slice(index + 4, end).map((token) => token.value));
    }
    const resolve = (name, seen = new Set()) =>
    {
        if (seen.has(name)) throw new Error(`[content-shape] integer constant ${name} is recursive`);
        const expression = declarations.get(name);
        if (!expression) throw new Error(`[content-shape] integer constant ${name} is missing`);
        if (expression.length === 1 && /^[0-9][0-9_]*$/u.test(expression[0]))
        {
            return Number(expression[0].replaceAll('_', ''));
        }
        if (expression.length === 1 && /^[A-Za-z_]/u.test(expression[0]))
        {
            return resolve(expression[0], new Set([...seen, name]));
        }
        throw new Error(`[content-shape] integer constant ${name} has an unsupported expression`);
    };
    return Object.freeze(Object.fromEntries(names.map((name) => [name, Object.freeze({
        expression: declarations.get(name)?.join(' ') ?? null,
        value: resolve(name)
    })])));
}

function propertyContract(tokens, typeScope, propertyName)
{
    const propertyIndex = tokens.findIndex((token, index) => index >= typeScope.start && index < typeScope.end
        && token.value === propertyName && tokens[index + 1]?.value === '{');
    if (propertyIndex < 0) throw new Error(`[content-shape] property ${propertyName} is missing`);
    let publicIndex = propertyIndex - 1;
    while (publicIndex >= typeScope.start && tokens[publicIndex].value !== 'public') publicIndex -= 1;
    if (publicIndex < typeScope.start) throw new Error(`[content-shape] property ${propertyName} has no public declaration`);
    const declaration = tokens.slice(publicIndex, propertyIndex + 1).map((token) => token.value);
    const namePosition = declaration.length - 1;
    const typeTokens = declaration.slice(1, namePosition).filter((token) => !['required', 'static', 'virtual', 'override'].includes(token));
    const attributes = [];
    let cursor = publicIndex - 1;
    while (tokens[cursor]?.value === ']')
    {
        let depth = 1;
        let start = cursor - 1;
        while (start >= typeScope.start && depth > 0)
        {
            if (tokens[start].value === ']') depth += 1;
            if (tokens[start].value === '[') depth -= 1;
            start -= 1;
        }
        attributes.unshift(tokens.slice(start + 2, cursor).map((token) => token.value));
        cursor = start;
    }
    const normalizedAttributes = attributes.map((attribute) =>
    {
        const argumentsEnd = attribute.indexOf(')');
        const argumentsList = attribute[1] === '(' ? attribute.slice(2, argumentsEnd) : [];
        const separator = argumentsList.indexOf(',');
        return Object.freeze({
            name: attribute[0],
            arguments: attribute[1] === '(' ? argumentsList.join(' ') : null,
            firstArgument: attribute[1] === '('
                ? argumentsList.slice(0, separator < 0 ? argumentsList.length : separator).join(' ')
                : null
        });
    });
    return Object.freeze({
        declaration: declaration.join(' '),
        type: typeTokens.join(''),
        nullable: typeTokens.includes('?'),
        requiredKeyword: declaration.includes('required'),
        attributes: normalizedAttributes
    });
}

function localInitializer(method, localName)
{
    const tokens = method.body;
    const index = tokens.findIndex((token, candidate) => token === localName
        && tokens[candidate + 1] === '='
        && (tokens[candidate - 1] === 'string' || (tokens[candidate - 1] === '?' && tokens[candidate - 2] === 'string')));
    if (index < 0 || tokens[index + 1] !== '=') throw new Error(`[content-shape] local ${localName} is missing from ${method.name}`);
    const end = tokens.indexOf(';', index + 2);
    return tokens.slice(index + 2, end);
}

function inputNormalization(initializer, inputName, memberName)
{
    const prefix = [inputName, '.', memberName];
    const optionalPrefix = [inputName, '.', memberName, '?.'];
    const startsWith = (expected) => expected.every((token, index) => initializer[index] === token);
    if (startsWith([...optionalPrefix, 'Trim', '(', ')'])) return 'trim';
    if (startsWith(prefix) && !initializer.includes('Trim')) return 'none';
    throw new Error(`[content-shape] unsupported normalization for ${inputName}.${memberName}: ${initializer.join(' ')}`);
}

function articleBranch(method, localName)
{
    const tokens = method.body;
    for (let index = 0; index < tokens.length; index += 1)
    {
        if (tokens[index] !== 'if' || tokens[index + 1] !== '(') continue;
        const conditionEnd = matchingToken(tokens.map((value) => ({ value })), index + 1, '(', ')');
        const condition = tokens.slice(index + 2, conditionEnd);
        const isEmpty = condition.join(' ') === `${localName} . Length == 0`
            || condition.join(' ') === `string . IsNullOrWhiteSpace ( ${localName} )`;
        if (!isEmpty || tokens[conditionEnd + 1] !== '{') continue;
        const emptyEnd = matchingToken(tokens.map((value) => ({ value })), conditionEnd + 1, '{', '}');
        const emptyBody = tokens.slice(conditionEnd + 2, emptyEnd);
        const emptyAction = emptyBody.includes('AddError') ? 'AddError'
            : emptyBody.includes('AddWarning') ? 'AddWarning' : 'none';
        if (tokens[emptyEnd + 1] !== 'else' || tokens[emptyEnd + 2] !== 'if' || tokens[emptyEnd + 3] !== '(')
        {
            throw new Error(`[content-shape] ${localName} maximum branch is no longer an else-if of its empty branch`);
        }
        const maximumEnd = matchingToken(tokens.map((value) => ({ value })), emptyEnd + 3, '(', ')');
        const maximumCondition = tokens.slice(emptyEnd + 4, maximumEnd);
        if (maximumCondition[0] !== localName || maximumCondition[1] !== '.' || maximumCondition[2] !== 'Length')
        {
            throw new Error(`[content-shape] ${localName} maximum condition is unsupported`);
        }
        return Object.freeze({
            emptyCondition: condition.join(' '),
            emptyAction,
            maximumCondition: maximumCondition.join(' '),
            maximumOperator: maximumCondition[3],
            maximumConstant: maximumCondition[4],
            controlFlow: 'if-else-if'
        });
    }
    throw new Error(`[content-shape] empty validation branch for ${localName} is missing`);
}

function invalidUpperBound(operator, value)
{
    if (operator === '>') return value;
    if (operator === '>=') return value - 1;
    throw new Error(`[content-shape] unsupported invalid upper-bound operator ${operator}`);
}

function validUpperBound(operator, value)
{
    if (operator === '<=') return value;
    if (operator === '<') return value - 1;
    throw new Error(`[content-shape] unsupported valid upper-bound operator ${operator}`);
}

function commentPredicate(method)
{
    const body = method.body;
    const connectors = body.filter((token) => token === '&&' || token === '||');
    const charIndex = body.findIndex((token, index) => token === 'content' && body[index + 1] === '.' && body[index + 2] === 'Length');
    const utf8Index = body.findIndex((token, index) => token === 'Encoding' && body[index + 2] === 'UTF8');
    if (charIndex < 0 || utf8Index < 0) throw new Error('[content-shape] comment predicate count clauses are missing');
    return Object.freeze({
        expression: body.join(' '),
        connectors,
        nonWhitespace: body.slice(0, charIndex).includes('IsNullOrWhiteSpace'),
        characterOperator: body[charIndex + 3],
        characterLimit: body[charIndex + 6],
        utf8Operator: body[utf8Index + 8],
        utf8Limit: body[utf8Index + 11]
    });
}

function sourceBinding(relativePath, contract)
{
    return Object.freeze({
        path: relativePath,
        sha256: sha256Json({
            schema: 'fsusblog.content-field-source-binding.v1',
            path: relativePath,
            contract
        })
    });
}

/**
 * Project the existing production validators. Values are parsed from the C#
 * authority instead of being copied into test code.
 */
export function projectContentFieldContracts({ root = repositoryRoot } = {})
{
    const articlePath = 'src/backend/Services/Articles/ArticlePublicationValidator.cs';
    const commentPath = 'src/backend/Models/Dtos/CommentDto.cs';
    const commentEndpointPath = 'src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs';
    const articleTokens = tokenizeCSharp(fs.readFileSync(path.join(root, articlePath), 'utf8'));
    const commentTokens = tokenizeCSharp(fs.readFileSync(path.join(root, commentPath), 'utf8'));
    const endpointTokens = tokenizeCSharp(fs.readFileSync(path.join(root, commentEndpointPath), 'utf8'));
    const articleScope = namedTypeScope(articleTokens, 'ArticlePublicationValidator');
    const articleInput = recordParameters(articleTokens, 'ArticlePublicationValidationInput');
    const articleConstants = integerConstants(articleTokens, articleScope, ['MaxTitleLength', 'MaxSummaryLength', 'MaxContentLength']);
    const addContentIssues = namedMethod(articleTokens, articleScope, 'AddContentIssues');
    const articleContracts = [
        ['article.body', 'Content', 'body'],
        ['article.summary', 'Summary', 'summary'],
        ['article.title', 'Title', 'title']
    ].map(([id, inputMember, localName]) =>
    {
        const initializer = localInitializer(addContentIssues, localName);
        const branch = articleBranch(addContentIssues, localName);
        const normalization = inputNormalization(initializer, 'input', inputMember);
        const constant = articleConstants[branch.maximumConstant];
        if (!constant) throw new Error(`[content-shape] ${localName} references an unknown maximum constant`);
        return Object.freeze({
            id,
            input: Object.freeze({ member: inputMember, ...articleInput[inputMember] }),
            initializer: initializer.join(' '),
            normalization,
            branch,
            constant: Object.freeze({ name: branch.maximumConstant, ...constant })
        });
    });
    const articleFields = [
        ...articleContracts.map((contract) => ({
            id: contract.id, owner: 'ArticlePublicationValidator', sourceRef: `${articlePath}#${contract.constant.name}`,
            nullable: contract.branch.emptyAction !== 'AddError', normalization: contract.normalization,
            characterCount: 'utf16-code-units',
            minCharacters: contract.branch.emptyAction === 'AddError' ? 1 : 0,
            maxCharacters: invalidUpperBound(contract.branch.maximumOperator, contract.constant.value),
            minUtf8Bytes: null, maxUtf8Bytes: null
        }))
    ];
    const commentLimitsScope = namedTypeScope(commentTokens, 'CommentLimits');
    const commentDtoScope = namedTypeScope(commentTokens, 'CommentDto');
    const commentConstants = integerConstants(commentTokens, commentLimitsScope, [
        'ContentMinChars', 'ContentMinUtf8Bytes', 'DefaultContentMaxChars', 'DefaultContentMaxUtf8Bytes',
        'HardContentMaxChars', 'HardContentMaxUtf8Bytes', 'ContentMaxChars', 'ContentMaxUtf8Bytes'
    ]);
    const commentProperty = propertyContract(commentTokens, commentDtoScope, 'Content');
    const normalizeMaxChars = namedMethod(commentTokens, commentLimitsScope, 'NormalizeMaxChars');
    const normalizeMaxUtf8Bytes = namedMethod(commentTokens, commentLimitsScope, 'NormalizeMaxUtf8Bytes');
    const validateMaxChars = namedMethod(commentTokens, commentLimitsScope, 'ValidateMaxChars');
    const validateMaxUtf8Bytes = namedMethod(commentTokens, commentLimitsScope, 'ValidateMaxUtf8Bytes');
    const endpointScope = Object.freeze({ start: 0, end: endpointTokens.length });
    const predicateMethod = namedMethod(endpointTokens, endpointScope, 'IsCommentContentWithinLimit');
    const predicate = commentPredicate(predicateMethod);
    const endpointInitializers = [];
    for (let index = 0; index < endpointTokens.length; index += 1)
    {
        if (endpointTokens[index].value !== 'content' || endpointTokens[index - 1]?.value !== 'string'
            || endpointTokens[index + 1]?.value !== '=') continue;
        const end = endpointTokens.findIndex((token, candidate) => candidate > index && token.value === ';');
        const initializer = endpointTokens.slice(index + 2, end).map((token) => token.value);
        if (!initializer.includes('request') || !initializer.includes('Content')) continue;
        endpointInitializers.push(initializer);
    }
    if (endpointInitializers.length === 0) throw new Error('[content-shape] comment endpoint initializer is missing');
    const canonicalInitializer = endpointInitializers[0];
    if (endpointInitializers.some((initializer) => initializer.join(' ') !== canonicalInitializer.join(' ')))
    {
        throw new Error('[content-shape] comment endpoint initializers disagree');
    }
    const commentNormalization = inputNormalization(canonicalInitializer, 'request', 'Content');
    const requiredAttribute = commentProperty.attributes.some((attribute) => attribute.name === 'Required');
    const maxLengthAttribute = commentProperty.attributes.find((attribute) => attribute.name === 'MaxLength');
    const maxLengthReference = maxLengthAttribute?.firstArgument?.split(' . ').at(-1);
    const characterMaximum = commentConstants[maxLengthReference];
    if (!characterMaximum) throw new Error('[content-shape] CommentDto.Content MaxLength constant is missing or unknown');
    const commentField = {
        id: 'comment.content', owner: 'CommentLimits', sourceRef: `${commentPath}#ContentMaxChars+ContentMaxUtf8Bytes`,
        nullable: !(predicate.nonWhitespace && (requiredAttribute || commentProperty.requiredKeyword) && !commentProperty.nullable),
        normalization: commentNormalization, characterCount: 'utf16-code-units',
        minCharacters: predicate.nonWhitespace ? 1 : 0,
        maxCharacters: validUpperBound(predicate.characterOperator, characterMaximum.value),
        minUtf8Bytes: predicate.nonWhitespace ? 1 : 0,
        maxUtf8Bytes: validUpperBound(predicate.utf8Operator, commentConstants.ContentMaxUtf8Bytes.value)
    };
    const fields = [...articleFields, commentField];
    const sources = [
        sourceBinding(articlePath, {
            owner: 'ArticlePublicationValidator.AddContentIssues',
            fields: articleContracts
        }),
        sourceBinding(commentPath, {
            owner: 'CommentLimits+CommentDto.Content',
            property: commentProperty,
            maxLengthAttribute: maxLengthAttribute?.arguments ?? null,
            constants: commentConstants,
            methods: [normalizeMaxChars, normalizeMaxUtf8Bytes, validateMaxChars, validateMaxUtf8Bytes]
        }),
        sourceBinding(commentEndpointPath, {
            owner: 'BinaryEndpoints.IsCommentContentWithinLimit',
            initializers: endpointInitializers.map((initializer) => initializer.join(' ')),
            predicate
        })
    ];
    const body = {
        schema: 'fsusblog.content-field-contract-projection.v1',
        generatedBy: 'tools/testing/content-shape-catalog.mjs',
        countSemantics: 'production-dotnet-string-length-and-utf8-get-byte-count',
        sources,
        fields
    };
    return Object.freeze({ ...body, contentDigest: sha256Json(body) });
}

export function readContentShapeAuthority(files = contentShapeFiles)
{
    return Object.freeze({
        catalog: readJson(files.catalog),
        fields: readJson(files.fields),
        locales: readJson(files.locales)
    });
}

function duplicate(values)
{
    return values.filter((value, index) => values.indexOf(value) !== index);
}

function exactSorted(values, expected)
{
    return Array.isArray(values)
        && JSON.stringify(values) === JSON.stringify([...expected].sort());
}

function rejectUnknownKeys(value, allowed, label, errors)
{
    for (const key of Object.keys(value ?? {}))
    {
        if (!allowed.has(key))
        {
            errors.push(`${label} has unknown field ${key}`);
        }
    }
}

export function shapeContentDigest(shape)
{
    const { contentDigest: _contentDigest, ...body } = shape;
    return sha256Json(body);
}

export function contentShapeCatalogDigest(authority = readContentShapeAuthority())
{
    return sha256Json({
        schema: 'fsusblog.content-shape-authority-digest.v1',
        catalog: authority.catalog,
        fields: authority.fields,
        localeCatalogDigest: sha256Json(authority.locales)
    });
}

export function contentShapeBoundaryPlan(authority = readContentShapeAuthority())
{
    const cases = [];
    for (const field of authority.fields.fields)
    {
        const dimensions = [
            ['characters', field.minCharacters, field.maxCharacters],
            ['utf8-bytes', field.minUtf8Bytes, field.maxUtf8Bytes]
        ];
        for (const [dimension, minimum, maximum] of dimensions)
        {
            if (minimum == null || maximum == null)
            {
                continue;
            }
            for (const kind of CONTENT_SHAPE_BOUNDARY_KINDS)
            {
                cases.push(Object.freeze({
                    id: `${field.id}.${dimension}.${kind}`,
                    fieldId: field.id,
                    dimension,
                    kind,
                    target: kind === 'min' ? minimum
                        : kind === 'ordinary' ? Math.min(maximum, Math.max(minimum, 16))
                            : kind === 'max-minus-one' ? Math.max(minimum, maximum - 1)
                                : kind === 'max' ? maximum : maximum + 1,
                    expectedDimensionValidity: kind !== 'max-plus-one-negative'
                }));
            }
        }
    }
    const body = {
        schema: 'fsusblog.content-shape-boundary-plan.v1',
        contentShapeCatalogDigest: contentShapeCatalogDigest(authority),
        cases
    };
    return Object.freeze({ ...body, planDigest: sha256Json(body) });
}

export function validateContentShapeAuthority({
    files = contentShapeFiles,
    root = repositoryRoot,
    authority = null,
    scanGovernance = true
} = {})
{
    const errors = [];
    let current;
    let schema;
    try
    {
        current = authority ?? readContentShapeAuthority(files);
    }
    catch (error)
    {
        return [`content shape authority is unreadable: ${error.message}`];
    }
    const { catalog, fields, locales } = current;
    try
    {
        schema = readJson(files.schema);
        if (schema.$id !== 'fsusblog.content-shape-catalog.v1'
            || schema.additionalProperties !== false
            || schema.$defs?.shape?.additionalProperties !== false
            || schema.$defs?.scriptClass?.additionalProperties !== false)
        {
            errors.push('content shape schema must keep its v1 identity and closed objects');
        }
    }
    catch (error)
    {
        errors.push(`content shape schema is unreadable: ${error.message}`);
    }
    rejectUnknownKeys(catalog, new Set([
        'schema', 'generationVersion', 'digestAlgorithm', 'canonicalSerialization', 'fieldContractProjection',
        'consumerDomains', 'scriptClasses', 'localeScriptBindings', 'boundaryCaseKinds', 'shapes'
    ]), 'catalog', errors);
    if (catalog.schema !== 'fsusblog.content-shape-catalog.v1'
        || catalog.generationVersion !== 'unicode-boundary-v1'
        || catalog.digestAlgorithm !== 'sha256'
        || catalog.canonicalSerialization !== 'json-utf8-v1')
    {
        errors.push('catalog identity/version/digest contract is invalid');
    }
    if (!exactSorted(catalog.consumerDomains, CONTENT_SHAPE_CONSUMER_DOMAINS))
    {
        errors.push('consumer domains must exactly cover the closed applicability registry');
    }
    if (!exactSorted(catalog.boundaryCaseKinds, CONTENT_SHAPE_BOUNDARY_KINDS))
    {
        errors.push('boundary case kinds must exactly cover min/ordinary/max-1/max/max+1-negative');
    }
    const scriptIds = (catalog.scriptClasses ?? []).map((item) => item.id);
    if (!exactSorted(scriptIds, CONTENT_SHAPE_SCRIPT_CLASSES))
    {
        errors.push('script classes must exactly cover the closed Unicode registry');
    }
    if (duplicate(scriptIds).length)
    {
        errors.push(`duplicate script class ${duplicate(scriptIds).join(', ')}`);
    }
    for (const script of catalog.scriptClasses ?? [])
    {
        rejectUnknownKeys(script, new Set(['id', 'eligibility', 'codePoints', 'featureTags']), `script ${script.id}`, errors);
        if (!stableId.test(script.id ?? '') || !['positive', 'negative'].includes(script.eligibility)
            || !Array.isArray(script.codePoints) || script.codePoints.length === 0
            || script.codePoints.some((value) => !Number.isInteger(value) || value <= 0 || value > 0x10ffff))
        {
            errors.push(`script ${script.id ?? '<missing>'} has invalid closed generation parameters`);
        }
    }
    const negativeScripts = new Set((catalog.scriptClasses ?? []).filter((item) => item.eligibility === 'negative').map((item) => item.id));
    const shapeIds = (catalog.shapes ?? []).map((item) => item.id);
    if (duplicate(shapeIds).length)
    {
        errors.push(`duplicate shape ID ${duplicate(shapeIds).join(', ')}`);
    }
    const knownFields = new Set((fields.fields ?? []).map((item) => item.id));
    const knownConsumers = new Set(CONTENT_SHAPE_CONSUMER_DOMAINS);
    for (const shape of catalog.shapes ?? [])
    {
        rejectUnknownKeys(shape, new Set([
            'id', 'applicableFields', 'scriptClasses', 'normalizationForm', 'target', 'featureTags', 'eligibility',
            'expectedBoundaryRef', 'expectedSanitizationRef', 'expectedSearchRef', 'consumerDomains',
            'fixedSeedPolicy', 'contentDigest'
        ]), `shape ${shape.id}`, errors);
        if (!stableId.test(shape.id ?? '') || !digestPattern.test(shape.contentDigest ?? ''))
        {
            errors.push(`shape ${shape.id ?? '<missing>'} has invalid identity or content digest`);
        }
        else if (shape.contentDigest !== shapeContentDigest(shape))
        {
            errors.push(`shape ${shape.id} content digest is stale or tampered`);
        }
        for (const fieldId of shape.applicableFields ?? [])
        {
            if (!knownFields.has(fieldId)) errors.push(`shape ${shape.id} references unknown field ${fieldId}`);
        }
        for (const scriptId of shape.scriptClasses ?? [])
        {
            if (!scriptIds.includes(scriptId)) errors.push(`shape ${shape.id} references unknown script ${scriptId}`);
        }
        for (const domain of shape.consumerDomains ?? [])
        {
            if (!knownConsumers.has(domain)) errors.push(`shape ${shape.id} references unknown consumer domain ${domain}`);
        }
        const containsNegative = (shape.scriptClasses ?? []).some((id) => negativeScripts.has(id));
        if ((shape.eligibility === 'positive' && containsNegative)
            || (shape.eligibility === 'negative' && !containsNegative))
        {
            errors.push(`shape ${shape.id} violates positive/negative eligibility isolation`);
        }
    }
    for (const scriptId of scriptIds)
    {
        const representatives = (catalog.shapes ?? []).filter((shape) => shape.scriptClasses?.includes(scriptId));
        if (representatives.length !== 1)
        {
            errors.push(`script ${scriptId} must have exactly one representative shape`);
        }
    }
    const enabledLocaleScripts = new Set((locales.locales ?? [])
        .filter((locale) => locale.status === 'enabled').map((locale) => locale.script));
    const bindingScripts = (catalog.localeScriptBindings ?? []).map((item) => item.localeScript);
    if (duplicate(bindingScripts).length
        || JSON.stringify([...enabledLocaleScripts].sort()) !== JSON.stringify([...bindingScripts].sort()))
    {
        errors.push('enabled locale scripts and content-shape locale bindings must match bidirectionally');
    }
    for (const binding of catalog.localeScriptBindings ?? [])
    {
        for (const shapeId of binding.representativeShapeIds ?? [])
        {
            if (!shapeIds.includes(shapeId)) errors.push(`locale script ${binding.localeScript} references unknown shape ${shapeId}`);
        }
    }
    let projected;
    try
    {
        projected = projectContentFieldContracts({ root });
    }
    catch (error)
    {
        errors.push(error.message);
    }
    if (projected && stableStringify(projected) !== stableStringify(fields))
    {
        errors.push('content field contract projection is stale; production DTO/validator changed');
    }
    if (fields.schema !== 'fsusblog.content-field-contract-projection.v1'
        || !digestPattern.test(fields.contentDigest ?? ''))
    {
        errors.push('content field contract projection identity is invalid');
    }
    const boundaryCases = contentShapeBoundaryPlan(current).cases;
    if (duplicate(boundaryCases.map((item) => item.id)).length)
    {
        errors.push('boundary case IDs overlap ambiguously');
    }
    if (scanGovernance)
    {
        errors.push(...validateContentShapeGovernance({ root }));
    }
    return errors;
}

export function validateContentShapeGovernance({ root = repositoryRoot, sourceOverrides = new Map() } = {})
{
    const errors = [];
    const generatorPath = 'tools/test-fixtures/content-shape-generator.mjs';
    const generator = sourceOverrides.get(generatorPath)
        ?? fs.readFileSync(path.join(root, generatorPath), 'utf8');
    for (const [label, pattern] of [
        ['runtime random', /\b(?:Math\.random|crypto\.randomUUID|randomUUID)\b/u],
        ['wall clock', /\bDate\.now\b/u],
        ['all-unicode catch-all', /\ball[-_ ]unicode\b/iu],
        ['JS-length-only count proxy', /characterCount\s*:\s*text\.length/u],
        ['ASCII byte proxy', /utf8ByteCount\s*:\s*text\.length/u]
    ])
    {
        if (pattern.test(generator)) errors.push(`content shape generator contains forbidden ${label}`);
    }
    const candidates = [];
    for (const base of ['config/testing', 'tools/test-fixtures'])
    {
        const directory = path.join(root, base);
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
        {
            const relative = path.posix.join(base, entry.name);
            if (entry.isFile() && /content[-_]shape/iu.test(entry.name)) candidates.push(relative);
        }
    }
    const allowed = new Set([
        'config/testing/content-shape-catalog.json',
        'tools/test-fixtures/content-shape-generator.mjs'
    ]);
    for (const candidate of candidates)
    {
        if (!allowed.has(candidate)) errors.push(`second content shape catalog/generator authority is forbidden: ${candidate}`);
    }
    return errors;
}

export function writeContentFieldContractProjection({ root = repositoryRoot, file = contentShapeFiles.fields } = {})
{
    const projection = projectContentFieldContracts({ root });
    fs.writeFileSync(file, `${JSON.stringify(projection, null, 4)}\n`, { encoding: 'utf8', mode: 0o644 });
    return projection;
}

function main()
{
    const check = process.argv.includes('--check');
    const writeProjection = process.argv.includes('--write-field-projection');
    if (writeProjection)
    {
        writeContentFieldContractProjection();
    }
    const errors = validateContentShapeAuthority();
    if (errors.length)
    {
        for (const error of errors) console.error(`[content-shape] ${error}`);
        process.exitCode = 1;
    }
    else if (check || writeProjection)
    {
        console.log('[content-shape] catalog, production field projection, locale coverage, and governance are valid');
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main();
}
