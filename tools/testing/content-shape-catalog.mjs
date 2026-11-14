import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

let extractorBuilt = false;
const extractionCache = new Map();
const projectionCache = new WeakMap();
export const matrixNativeProjects = Object.freeze({
    extractor: 'tools/testing/FsusBlog.ContentFieldContractExtractor/FsusBlog.ContentFieldContractExtractor.csproj',
    backend: 'src/backend/FsusBlog.Server.csproj'
});
const extractorProject = path.join(repositoryRoot, matrixNativeProjects.extractor);
const extractorTargets = path.join(repositoryRoot, 'tools/testing/FsusBlog.ContentFieldContractExtractor/Inject.targets');
const backendProject = path.join(repositoryRoot, matrixNativeProjects.backend);
const extractionProcessRoot = path.join(repositoryRoot, '.tmp/content-field-contract-extractor', `process-${process.pid}`);
const extractorArtifacts = path.join(extractionProcessRoot, 'extractor-artifacts');
const backendArtifacts = path.join(extractionProcessRoot, 'backend-artifacts');
const deterministicPathMap = `${extractionProcessRoot}=/_content-field-contract-build%2C${repositoryRoot}=/_/`;
let canonicalDotnet = null;
let producerIdentity = null;

function dotnetEnvironment()
{
    const environment = {
        ...process.env,
        PATH: '/usr/bin:/bin',
        DOTNET_NOLOGO: '1',
        DOTNET_CLI_TELEMETRY_OPTOUT: '1'
    };
    const ambientOverrides = new Set([
        'baseintermediateoutputpath',
        'baseoutputpath',
        'continuousintegrationbuild',
        'csctoolexe',
        'csctoolpath',
        'defineconstants',
        'deterministic',
        'dotnet_additional_deps',
        'dotnet_host_path',
        'dotnet_roll_forward',
        'dotnet_roll_forward_to_prerelease',
        'dotnet_root',
        'dotnet_root(x86)',
        'dotnet_shared_store',
        'dotnet_startup_hooks',
        'fsusblog_content_field_dotnet',
        'fsusblog_production_build_root',
        'langversion',
        'msbuild_exe_path',
        'msbuildextensionspath',
        'msbuildprojectextensionspath',
        'msbuildsdkspath',
        'msbuildtoolspath',
        'nullable',
        'roslyntargetspath',
        'targetframework',
        'trusted_platform_assemblies',
        'usesharedcompilation'
    ]);
    for (const name of Object.keys(environment))
    {
        if (ambientOverrides.has(name.toLowerCase()))
        {
            delete environment[name];
        }
    }
    return environment;
}

function runDotnet(arguments_, label)
{
    if (producerIdentity)
    {
        assertDotnetHostDigest(canonicalDotnet, producerIdentity.dotnetHostSha256);
    }
    const result = spawnSync(canonicalDotnet, arguments_, {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: dotnetEnvironment()
    });
    if (producerIdentity)
    {
        assertDotnetHostDigest(canonicalDotnet, producerIdentity.dotnetHostSha256);
    }
    if (result.status !== 0)
    {
        throw new Error(`[content-shape] ${label} failed: ${(result.stderr || result.stdout).trim()}`);
    }
    return result.stdout.trim();
}

function fileIdentity(relative)
{
    const file = path.join(repositoryRoot, relative);
    return Object.freeze({ path: relative, sha256: sha256(fs.readFileSync(file)) });
}

export function assertDotnetHostDigest(host, expectedDigest, readFile = fs.readFileSync)
{
    let actualDigest;
    try
    {
        actualDigest = sha256(readFile(host));
    }
    catch
    {
        throw new Error('[content-shape] canonical dotnet host is not observable during extraction');
    }
    if (actualDigest !== expectedDigest)
    {
        throw new Error('[content-shape] canonical dotnet host changed during extraction');
    }
}

export function validateConfiguredDotnetHost(configuredCandidate, expectedSdk, {
    exists = fs.existsSync,
    realpath = fs.realpathSync,
    readFile = fs.readFileSync,
    inspectVersion = (candidate) => spawnSync(candidate, ['--version'], {
        encoding: 'utf8', env: dotnetEnvironment()
    })
} = {})
{
    if (configuredCandidate === undefined)
    {
        return null;
    }
    if (configuredCandidate.length === 0
        || !path.isAbsolute(configuredCandidate)
        || !exists(configuredCandidate))
    {
        throw new Error('[content-shape] FSUSBLOG_CONTENT_FIELD_DOTNET must name an existing absolute path');
    }
    let resolved;
    let before;
    try
    {
        resolved = realpath(configuredCandidate);
        before = sha256(readFile(resolved));
    }
    catch
    {
        throw new Error('[content-shape] FSUSBLOG_CONTENT_FIELD_DOTNET host is not observable');
    }
    const observation = inspectVersion(resolved);
    if (observation.error || observation.status !== 0)
    {
        throw new Error('[content-shape] FSUSBLOG_CONTENT_FIELD_DOTNET version is not observable');
    }
    if (observation.stdout?.trim() !== expectedSdk)
    {
        throw new Error(`[content-shape] FSUSBLOG_CONTENT_FIELD_DOTNET does not match pinned SDK ${expectedSdk}`);
    }
    assertDotnetHostDigest(resolved, before, readFile);
    return resolved;
}

export function selectCanonicalDotnet(candidates, expectedSdk, inspectVersion = (candidate) =>
    spawnSync(candidate, ['--version'], { encoding: 'utf8', env: dotnetEnvironment() }))
{
    const matches = candidates.filter((candidate) =>
    {
        const observation = inspectVersion(candidate);
        return !observation.error
            && observation.status === 0
            && observation.stdout?.trim() === expectedSdk;
    });
    if (matches.length !== 1)
    {
        throw new Error(`[content-shape] expected exactly one canonical dotnet SDK ${expectedSdk}, found ${matches.length}`);
    }
    return matches[0];
}

function resolveCanonicalDotnet()
{
    if (canonicalDotnet)
    {
        return;
    }
    const dockerfile = fs.readFileSync(path.join(repositoryRoot, 'ops/docker/FsusBlog.Server.Dockerfile'), 'utf8');
    const expectedSdk = dockerfile.match(/^ARG DOTNET_SDK_VERSION=([^\r\n]+)$/mu)?.[1];
    const expectedRuntime = dockerfile.match(/^ARG DOTNET_RUNTIME_VERSION=([^\r\n]+)$/mu)?.[1];
    if (!expectedSdk || !expectedRuntime)
    {
        throw new Error('[content-shape] pinned dotnet SDK/runtime version is missing');
    }
    const configuredCandidate = validateConfiguredDotnetHost(
        process.env.FSUSBLOG_CONTENT_FIELD_DOTNET,
        expectedSdk
    );
    const candidates = [...new Set([configuredCandidate, '/usr/share/dotnet10/dotnet', '/usr/share/dotnet/dotnet']
        .filter((candidate) => fs.existsSync(candidate)).map((candidate) => fs.realpathSync(candidate)))];
    canonicalDotnet = selectCanonicalDotnet(candidates, expectedSdk);
    const dotnetHostSha256 = sha256(fs.readFileSync(canonicalDotnet));
    const sdkBase = path.dirname(canonicalDotnet);
    const sdkDirectory = path.join(sdkBase, 'sdk', expectedSdk);
    const compiler = path.join(sdkDirectory, 'Roslyn/bincore/csc.dll');
    if (!fs.existsSync(compiler))
    {
        throw new Error('[content-shape] canonical Roslyn compiler is missing');
    }
    const dotnetInfo = runDotnet(['--info'], 'dotnet identity inspection');
    const sdkCommit = dotnetInfo.match(/\.NET SDK:\s+[\s\S]*?Commit:\s+([^\r\n]+)/u)?.[1]?.trim();
    if (!sdkCommit)
    {
        throw new Error('[content-shape] canonical dotnet SDK commit is missing');
    }
    const installedRuntimes = runDotnet(['--list-runtimes'], 'dotnet runtime inspection').split(/\r?\n/u)
        .map((line) => line.match(/^(\S+)\s+(\S+)\s+\[/u))
        .filter(Boolean)
        .map((match) => `${match[1]}@${match[2]}`).sort();
    const requiredRuntimes = [`Microsoft.AspNetCore.App@${expectedRuntime}`, `Microsoft.NETCore.App@${expectedRuntime}`];
    for (const runtime of requiredRuntimes)
    {
        if (!installedRuntimes.includes(runtime))
        {
            throw new Error(`[content-shape] pinned runtime is unavailable: ${runtime}`);
        }
    }
    assertDotnetHostDigest(canonicalDotnet, dotnetHostSha256);
    producerIdentity = {
        schema: 'fsusblog.content-field-producer-identity.v1',
        dotnetSdkVersion: expectedSdk,
        dotnetRuntimeVersion: expectedRuntime,
        dotnetHostSha256,
        dotnetSdkCommit: sdkCommit,
        dotnetRuntimes: requiredRuntimes,
        roslynCompilerSha256: sha256(fs.readFileSync(compiler)),
        inputs: [
            'ops/docker/FsusBlog.Server.Dockerfile',
            'Directory.Build.props',
            'Directory.Packages.props',
            'src/backend/FsusBlog.Server.csproj',
            'src/backend/packages.lock.json',
            'tools/testing/FsusBlog.ContentFieldContractExtractor/FsusBlog.ContentFieldContractExtractor.csproj',
            'tools/testing/FsusBlog.ContentFieldContractExtractor/Inject.targets',
            'tools/testing/FsusBlog.ContentFieldContractExtractor/Program.cs',
            'tools/testing/FsusBlog.ContentFieldContractExtractor/packages.lock.json'
        ].map(fileIdentity)
    };
}

function extractContentFieldContracts(root, sourcePaths)
{
    resolveCanonicalDotnet();
    const sourceDigest = sha256Json(sourcePaths.map((relative) => [relative, fs.readFileSync(path.join(root, relative), 'utf8')]));
    if (extractionCache.has(sourceDigest))
    {
        return extractionCache.get(sourceDigest);
    }
    if (!extractorBuilt)
    {
        runDotnet([
            'restore', extractorProject, '--locked-mode', '--artifacts-path', extractorArtifacts,
            '--nologo', '--verbosity', 'quiet'
        ], 'locked Roslyn extractor restore');
        runDotnet([
            'build', extractorProject, '--configuration', 'Release', '--no-restore', '--no-incremental',
            '--artifacts-path', extractorArtifacts,
            '--disable-build-servers', '--nologo', '--verbosity', 'quiet',
            '-p:UseSharedCompilation=false', '-p:Deterministic=true', '-p:ContinuousIntegrationBuild=true',
            `-p:PathMap=${deterministicPathMap}`
        ], 'Roslyn extractor build');
        runDotnet([
            'restore', backendProject, '--locked-mode', '--artifacts-path', backendArtifacts,
            '--nologo', '--verbosity', 'quiet'
        ], 'locked production backend restore');
        extractorBuilt = true;
    }
    const analyzer = path.join(
        extractorArtifacts,
        'bin/FsusBlog.ContentFieldContractExtractor/release/FsusBlog.ContentFieldContractExtractor.dll'
    );
    if (!fs.existsSync(analyzer))
    {
        throw new Error('[content-shape] Roslyn extractor binary is missing after build');
    }
    const outputDirectory = path.join(extractionProcessRoot, 'output');
    const output = path.join(outputDirectory, `${sourceDigest.slice('sha256:'.length)}.json`);
    fs.mkdirSync(outputDirectory, { recursive: true });
    fs.rmSync(output, { force: true });
    runDotnet([
        'build', backendProject, '--configuration', 'Release', '--no-restore', '--no-incremental',
        '--artifacts-path', backendArtifacts,
        '--disable-build-servers', '--nologo', '--verbosity', 'quiet',
        `-p:CustomAfterMicrosoftCSharpTargets=${extractorTargets}`,
        `-p:FsusBlogContentFieldContractAnalyzer=${analyzer}`,
        `-p:FsusBlogContentFieldContractOutput=${output}`,
        `-p:FsusBlogContentFieldContractSourceRoot=${root}`,
        '-p:UseSharedCompilation=false',
        '-p:Deterministic=true',
        '-p:ContinuousIntegrationBuild=true',
        `-p:PathMap=${deterministicPathMap}`
    ], 'production backend semantic extraction');
    if (!fs.existsSync(output))
    {
        throw new Error('[content-shape] production backend build did not produce semantic extraction');
    }
    const extraction = JSON.parse(fs.readFileSync(output, 'utf8'));
    if (extraction.schema !== 'fsusblog.content-field-roslyn-extraction.v2')
    {
        throw new Error('[content-shape] Roslyn extractor returned an unsupported schema');
    }
    extraction.producerIdentity = Object.freeze({
        ...producerIdentity,
        analyzerBinarySha256: sha256(fs.readFileSync(analyzer))
    });
    extractionCache.set(sourceDigest, extraction);
    return extraction;
}

function invalidUpperBound(operator, value)
{
    if (operator === '>')
    {
        return value;
    }
    if (operator === '>=')
    {
        return value - 1;
    }
    throw new Error(`[content-shape] unsupported invalid upper-bound operator ${operator}`);
}

function validUpperBound(operator, value)
{
    if (operator === '<=')
    {
        return value;
    }
    if (operator === '<')
    {
        return value - 1;
    }
    throw new Error(`[content-shape] unsupported valid upper-bound operator ${operator}`);
}

export function contentFieldSourceBinding({ path: relativePath, semanticContract })
{
    return Object.freeze({
        path: relativePath,
        sha256: sha256Json({
            schema: 'fsusblog.content-field-source-binding.v2',
            path: relativePath,
            contract: semanticContract
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
    const commentPartialPath = 'src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Files.cs';
    const sourcePaths = [articlePath, commentPath, commentEndpointPath, commentPartialPath];
    const extraction = extractContentFieldContracts(root, sourcePaths);
    const cachedProjection = projectionCache.get(extraction);
    if (cachedProjection)
    {
        return cachedProjection;
    }
    const articleContracts = extraction.article.fields;
    const articleFields = [
        ...articleContracts.map((contract) => ({
            id: contract.id, owner: 'ArticlePublicationValidator', sourceRef: `${articlePath}#${contract.constant.name}`,
            nullable: contract.branch.emptyAction !== 'AddError', normalization: contract.normalization,
            characterCount: 'utf16-code-units',
            minCharacters: contract.branch.emptyAction === 'AddError' ? 1 : 0,
            maxCharacters: invalidUpperBound(contract.branch.maximumOperator, contract.constant.contract.value),
            minUtf8Bytes: null, maxUtf8Bytes: null
        }))
    ];
    const commentConstants = extraction.comment.constants;
    const commentProperty = extraction.comment.property;
    const predicate = extraction.endpoint.predicate;
    const endpointFlows = extraction.endpoint.flows;
    const commentNormalization = endpointFlows[0]?.normalization;
    if (!commentNormalization || endpointFlows.some((flow) => flow.normalization !== commentNormalization))
    {
        throw new Error('[content-shape] comment endpoint normalization flows disagree');
    }
    const dataAnnotationsAssembly = /^System\.ComponentModel\.Annotations, Version=/u;
    const requiredAttribute = commentProperty.attributes.some((attribute) =>
        attribute.name === 'type:global::System.ComponentModel.DataAnnotations.RequiredAttribute'
        && dataAnnotationsAssembly.test(attribute.assembly));
    const maxLengthAttribute = commentProperty.attributes.find((attribute) =>
        attribute.name === 'type:global::System.ComponentModel.DataAnnotations.MaxLengthAttribute'
        && dataAnnotationsAssembly.test(attribute.assembly));
    const characterMaximum = Object.values(commentConstants)
        .find((constant) => constant.symbol === maxLengthAttribute?.firstArgument);
    if (!characterMaximum)
    {
        throw new Error('[content-shape] CommentDto.Content MaxLength constant is missing or unknown');
    }
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
        contentFieldSourceBinding({
            path: articlePath,
            semanticContract: extraction.article
        }),
        contentFieldSourceBinding({
            path: commentPath,
            semanticContract: extraction.comment
        }),
        contentFieldSourceBinding({
            path: commentEndpointPath,
            semanticContract: extraction.endpoint
        }),
        contentFieldSourceBinding({
            path: commentPartialPath,
            semanticContract: {
                transitiveContract: extraction.endpoint.flows
                    .map((flow) => flow.dataflow.filter((fact) => fact.startsWith('helper')))
            }
        })
    ];
    const body = {
        schema: 'fsusblog.content-field-contract-projection.v1',
        generatedBy: 'tools/testing/content-shape-catalog.mjs',
        countSemantics: 'production-dotnet-string-length-and-utf8-get-byte-count',
        sources,
        fields
    };
    const projection = Object.freeze({ ...body, contentDigest: sha256Json(body) });
    projectionCache.set(extraction, projection);
    return projection;
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
    const body = { ...shape };
    delete body.contentDigest;
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
            if (!knownFields.has(fieldId))
            {
                errors.push(`shape ${shape.id} references unknown field ${fieldId}`);
            }
        }
        for (const scriptId of shape.scriptClasses ?? [])
        {
            if (!scriptIds.includes(scriptId))
            {
                errors.push(`shape ${shape.id} references unknown script ${scriptId}`);
            }
        }
        for (const domain of shape.consumerDomains ?? [])
        {
            if (!knownConsumers.has(domain))
            {
                errors.push(`shape ${shape.id} references unknown consumer domain ${domain}`);
            }
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
            if (!shapeIds.includes(shapeId))
            {
                errors.push(`locale script ${binding.localeScript} references unknown shape ${shapeId}`);
            }
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
        if (pattern.test(generator))
        {
            errors.push(`content shape generator contains forbidden ${label}`);
        }
    }
    const candidates = [];
    for (const base of ['config/testing', 'tools/test-fixtures'])
    {
        const directory = path.join(root, base);
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
        {
            const relative = path.posix.join(base, entry.name);
            if (entry.isFile() && /content[-_]shape/iu.test(entry.name))
            {
                candidates.push(relative);
            }
        }
    }
    const allowed = new Set([
        'config/testing/content-shape-catalog.json',
        'tools/test-fixtures/content-shape-generator.mjs'
    ]);
    for (const candidate of candidates)
    {
        if (!allowed.has(candidate))
        {
            errors.push(`second content shape catalog/generator authority is forbidden: ${candidate}`);
        }
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
        for (const error of errors)
        {
            console.error(`[content-shape] ${error}`);
        }
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
