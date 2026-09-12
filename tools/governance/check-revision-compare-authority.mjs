#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const contractsFile = 'src/core/Services/Articles/RevisionCompareContracts.cs';
const contractFiles = [
    'src/core/Services/Articles/RevisionCompareSourceEnums.cs',
    'src/core/Services/Articles/RevisionCompareStatusEnums.cs',
    contractsFile,
    'src/core/Services/Articles/RevisionComparePackages.cs',
    'src/core/Services/Articles/RevisionComparePackageReaderContracts.cs',
    'src/core/Services/Articles/RevisionComparePlans.cs',
    'src/core/Services/Articles/RevisionCompareMetadataRegistry.cs',
    'src/core/Services/Articles/RevisionComparePackageSeal.cs',
    'src/core/Services/Articles/RevisionCompareContract.cs',
    'src/core/Services/Articles/RevisionCompareCanonical.cs'
];
const metadataRegistryFile = 'src/core/Services/Articles/RevisionCompareMetadataRegistry.cs';
const plannerFile = 'src/core/Services/Articles/RevisionComparePlanner.cs';
const readerFile = 'src/backend/Services/Authoring/AuthoringRevisionComparePackageReader.cs';
const serviceFile = 'src/backend/Services/Authoring/AuthoringRevisionCompareService.cs';
const diffFile = 'src/core/Services/Articles/RevisionSourceDiff.cs';
const structureFile = 'src/core/Services/Articles/RevisionMarkdownStructure.cs';
const registrationFile = 'src/backend/Infrastructure/Bootstrap/RuntimeDomainServiceCollectionExtensions.cs';
const requiredFiles = [
    ...contractFiles,
    plannerFile,
    readerFile,
    serviceFile,
    diffFile,
    structureFile,
    registrationFile
];
const laneFile = 'tools/test/lanes/static-governance.sh';
const matrixFile = 'tests/matrix.yml';

function toPosix(value)
{
    return value.replaceAll(path.sep, '/');
}

function walkSource(directory)
{
    if (!existsSync(directory))
    {
        return [];
    }

    const files = [];
    const pending = [directory];
    while (pending.length > 0)
    {
        const current = pending.pop();
        for (const entry of readdirSync(current, { withFileTypes: true }))
        {
            const absolute = path.join(current, entry.name);
            if (entry.isDirectory())
            {
                pending.push(absolute);
            }
            else if (entry.isFile() && /\.(?:cs|js|jsx|ts|tsx|vue)$/u.test(entry.name))
            {
                files.push(absolute);
            }
        }
    }
    return files.sort();
}

export function readRevisionCompareSources(root = repositoryRoot)
{
    return new Map(walkSource(path.join(root, 'src')).map((absolute) => [
        toPosix(path.relative(root, absolute)),
        readFileSync(absolute, 'utf8')
    ]));
}

function countMatches(source, pattern)
{
    return [...source.matchAll(pattern)].length;
}

export function checkRevisionCompareAuthoritySources(sources)
{
    const violations = [];
    for (const relative of requiredFiles)
    {
        if (!sources.has(relative))
        {
            violations.push(`required authority file missing: ${relative}`);
        }
    }
    if (violations.length > 0)
    {
        return violations;
    }

    const relevant = [...sources.entries()];
    const planners = [];
    const readers = [];
    const metadataAuthorities = [];
    const draftProviders = [];
    const structureProviders = [];
    const diffEngines = [];
    const compareServices = [];
    for (const [relative, source] of relevant)
    {
        const authorityScoped = /revision(?:compare|[-_]compare)/iu.test(path.basename(relative))
            || /\b(?:class|record|interface)\s+[A-Za-z0-9_]*RevisionCompare[A-Za-z0-9_]*\b/u.test(source);
        for (const match of source.matchAll(
            /\bclass\s+([A-Za-z0-9_]*RevisionCompare[A-Za-z0-9_]*Planner[A-Za-z0-9_]*)\b/gu))
        {
            planners.push(`${relative}:${match[1]}`);
        }
        const readerCount = countMatches(source, /:\s*IRevisionComparePackageReader\b/gu);
        for (let index = 0; index < readerCount; index++)
        {
            readers.push(relative);
        }
        const draftProviderCount = countMatches(
            source,
            /:\s*IAuthoringRevisionCompareDraftContextProvider\b/gu
        );
        for (let index = 0; index < draftProviderCount; index++)
        {
            draftProviders.push(relative);
        }
        const structureProviderCount = countMatches(
            source,
            /:\s*IRevisionMarkdownStructureProvider\b/gu
        );
        for (let index = 0; index < structureProviderCount; index++)
        {
            structureProviders.push(relative);
        }
        for (const match of source.matchAll(/\bclass\s+([A-Za-z0-9_]*RevisionSourceDiffEngine[A-Za-z0-9_]*)\b/gu))
        {
            diffEngines.push(`${relative}:${match[1]}`);
        }
        const compareServiceCount = countMatches(source, /:\s*IAuthoringRevisionCompareService\b/gu);
        for (let index = 0; index < compareServiceCount; index++)
        {
            compareServices.push(relative);
        }
        for (const match of source.matchAll(
            /\b(?:class|record|interface)\s+([A-Za-z0-9_]*RevisionCompareMetadata[A-Za-z0-9_]*(?:Registry|Map|Authority)[A-Za-z0-9_]*)\b/gu))
        {
            metadataAuthorities.push(`${relative}:${match[1]}`);
        }

        if (authorityScoped)
        {
            const forbidden = [
                ['rendered HTML or DOM authority', /\b(?:RenderedHtml|HtmlDocument|DocumentFragment|innerHTML|outerHTML|querySelector)\b/u],
                ['browser-local authority', /\b(?:localStorage|sessionStorage|indexedDB|IJSRuntime)\b/u],
                ['latest revision scan', /\b(?:GetLatestRevision|LatestRevision|latestRevision)\b|\bOrderByDescending\s*\([^)]*(?:RevisionId|RevisionNo)/u]
            ];
            for (const [label, pattern] of forbidden)
            {
                if (pattern.test(source))
                {
                    violations.push(`${relative}: ${label} is forbidden for revision compare authority`);
                }
            }
        }

        if (authorityScoped
            && relative.startsWith('src/frontend/')
            && /\b(?:const|let|var)\s+[A-Za-z0-9_]*metadata[A-Za-z0-9_]*\s*=\s*(?:new\s+Map\b|\{|\[)/iu.test(source))
        {
            violations.push(`${relative}: UI metadata map is forbidden for revision compare authority`);
        }
    }

    const expectedPlanner = `${plannerFile}:RevisionComparePlanner`;
    if (planners.length !== 1 || planners[0] !== expectedPlanner)
    {
        violations.push(`expected exact-one revision compare planner ${expectedPlanner}; found ${planners.join(', ') || '<none>'}`);
    }
    if (readers.length !== 1 || readers[0] !== readerFile)
    {
        violations.push(`expected exact-one revision compare package reader ${readerFile}; found ${readers.join(', ') || '<none>'}`);
    }
    if (draftProviders.length !== 1 || draftProviders[0] !== readerFile)
    {
        violations.push(`expected exact-one production draft context provider ${readerFile}; found ${draftProviders.join(', ') || '<none>'}`);
    }
    if (structureProviders.length !== 1 || structureProviders[0] !== structureFile)
    {
        violations.push(`expected exact-one canonical Markdown structure provider ${structureFile}; found ${structureProviders.join(', ') || '<none>'}`);
    }
    const expectedDiffEngine = `${diffFile}:RevisionSourceDiffEngine`;
    if (diffEngines.length !== 1 || diffEngines[0] !== expectedDiffEngine)
    {
        violations.push(`expected exact-one source diff engine ${expectedDiffEngine}; found ${diffEngines.join(', ') || '<none>'}`);
    }
    if (compareServices.length !== 1 || compareServices[0] !== serviceFile)
    {
        violations.push(`expected exact-one revision compare service ${serviceFile}; found ${compareServices.join(', ') || '<none>'}`);
    }
    const expectedMetadata = `${metadataRegistryFile}:RevisionCompareMetadataRegistry`;
    if (metadataAuthorities.length !== 1 || metadataAuthorities[0] !== expectedMetadata)
    {
        violations.push(`expected exact-one revision compare metadata authority ${expectedMetadata}; found ${metadataAuthorities.join(', ') || '<none>'}`);
    }

    const plannerSource = sources.get(plannerFile);
    if (!/basePackage\.ArticleId\s*!=\s*comparePackage\.ArticleId/u.test(plannerSource)
        || !/basePackage\.ArticleId\s*!=\s*request\.ArticleId/u.test(plannerSource))
    {
        violations.push(`${plannerFile}: exact cross-article admission guard is required`);
    }
    for (const required of [
        'RevisionCompareAdmission',
        'MaxTokenCount',
        'MaxOutputBytes',
        'MaxHunksPerChunk',
        'MaxChunks',
        'MinimumEstimatedOutputBytes',
        'InitialEstimatedMemoryBytes'
    ])
    {
        if (!plannerSource.includes(required))
        {
            violations.push(`${plannerFile}: admission must execute and bind ${required}`);
        }
    }

    const readerSource = sources.get(readerFile);
    if (!/draft\.ArticleId\s*!=\s*articleId/u.test(readerSource)
        || !/revision\.ArticleId\s*!=\s*articleId/u.test(readerSource))
    {
        violations.push(`${readerFile}: draft and revision article-coordinate guards are required`);
    }
    if (!/context\.SiteScope[\s\S]*PrimarySiteScope/u.test(readerSource)
        || !/class\s+AuthoringRevisionCompareDraftContextProvider\s*\(\s*IAuthoringDraftLifecycle\s+authoring\s*\)/u.test(readerSource)
        || !/authoring\.GetDraftAsync/u.test(readerSource))
    {
        violations.push(`${readerFile}: production site scope and existing draft authority reread are required`);
    }
    const articleAdmissionIndex = readerSource.indexOf('authority.GetAuthorizedArticleAsync');
    const draftReadIndex = readerSource.indexOf('authority.GetDraftAsync');
    const revisionReadIndex = readerSource.indexOf('authority.GetRevisionAsync');
    if (articleAdmissionIndex < 0
        || draftReadIndex < articleAdmissionIndex
        || revisionReadIndex < articleAdmissionIndex)
    {
        violations.push(`${readerFile}: permission and article admission must precede every source read`);
    }

    const contractsSource = contractFiles.map((relative) => sources.get(relative)).join('\n');
    for (const required of [
        'BasePackageReference',
        'ComparePackageReference',
        'PermissionScopeDigest',
        'MetadataSchemaDigest',
        'OptionsDigest',
        'BudgetDigest',
        'AdmissionDigest'
    ])
    {
        if (!contractsSource.includes(required))
        {
            violations.push(`${contractsFile}: compare receipt must explicitly bind ${required}`);
        }
    }
    if (!/packageReader\.ReadAuthorizedAsync/u.test(plannerSource)
        || !/RevisionCompareCanonical\.ReceiptDigest/u.test(plannerSource)
        || !/RevisionComparePlanner\.ValidatePackages/u.test(plannerSource))
    {
        violations.push(`${plannerFile}: independent verifier must reread packages and reapply admission/receipt checks`);
    }

    const registrationSource = sources.get(registrationFile);
    const registrations = [
        'AddScoped<IAuthoringRevisionCompareAuthority, AuthoringRevisionCompareAuthority>',
        'AddScoped<IAuthoringRevisionCompareDraftContextProvider, AuthoringRevisionCompareDraftContextProvider>',
        'AddScoped<IAuthoringRevisionCompareDraftContextAuthority, AuthoringRevisionCompareDraftContextAuthority>',
        'AddScoped<IRevisionComparePackageReader, AuthoringRevisionComparePackageReader>',
        'AddScoped<RevisionComparePlanner>',
        'AddScoped<RevisionComparePlanVerifier>',
        'AddSingleton<IRevisionMarkdownStructureProvider, CanonicalRevisionMarkdownStructureProvider>',
        'AddSingleton<IRevisionMarkdownStructureAuthority, RevisionMarkdownStructureAuthority>',
        'AddScoped<RevisionSourceDiffEngine>',
        'AddScoped<IAuthoringRevisionCompareService, AuthoringRevisionCompareService>'
    ];
    for (const registration of registrations)
    {
        const count = registrationSource.split(registration).length - 1;
        if (count !== 1)
        {
            violations.push(`${registrationFile}: expected exact-one ${registration}; found ${count}`);
        }
    }

    const diffSource = sources.get(diffFile);
    const structureSource = sources.get(structureFile);
    const serviceSource = sources.get(serviceFile);
    const forbiddenDiffPatterns = [
        ['HTML diff authority', /\b(?:HtmlDocument|DocumentFragment|innerHTML|outerHTML|querySelector)\b/u],
        ['format-before-diff', /\b(?:FormatMarkdown|NormalizeMarkdown|MarkdownFormatter)\b|\.Trim\s*\(/u],
        ['AI summary or quality score', /\b(?:AiSummary|AISummary|QualityScore)\b/u],
        ['second Markdown body store', /\bMarkdownContent\b/u],
        ['heading regex authority', /\bRegex\b|ParseHeadings|HeadingRegex/u]
    ];
    for (const [label, pattern] of forbiddenDiffPatterns)
    {
        if (pattern.test(diffSource) || pattern.test(structureSource))
        {
            violations.push(`${diffFile}: ${label} is forbidden`);
        }
    }
    if (!/Task\.Run\s*\(/u.test(diffSource)
        || !/ComputeAsync\s*\(\s*RevisionComparePlanBundle\s+bundle/u.test(diffSource))
    {
        violations.push(`${diffFile}: diff engine must execute from a sealed plan on a worker task`);
    }
    if (!/planVerifier\.VerifyAsync/u.test(diffSource)
        || !/diffEngine\.ComputeAsync/u.test(serviceSource))
    {
        violations.push(`${serviceFile}: orchestration must independently verify before computing the diff`);
    }

    return violations;
}

export function readRevisionCompareIntegration(root = repositoryRoot)
{
    return new Map([laneFile, matrixFile].map((relative) => [
        relative,
        existsSync(path.join(root, relative)) ? readFileSync(path.join(root, relative), 'utf8') : ''
    ]));
}

export function checkRevisionCompareIntegrationFiles(files)
{
    const violations = [];
    const lane = files.get(laneFile) ?? '';
    const matrix = files.get(matrixFile) ?? '';
    if (!/StaticRevisionCompareAuthority\(\)/u.test(lane)
        || !/check-revision-compare-authority\.mjs/u.test(lane)
        || !/revision-compare-authority\.test\.mjs/u.test(lane)
        || !/revision-compare-authority\s+StaticRevisionCompareAuthority/u.test(lane))
    {
        violations.push(`${laneFile}: revision compare checker and negative tests must run in application prechecks`);
    }
    const tierBlock = (tierId) =>
    {
        const marker = `    - id: ${tierId}\n`;
        const start = matrix.indexOf(marker);
        if (start < 0)
        {
            return '';
        }
        const next = matrix.indexOf('\n    - id: ', start + marker.length);
        return matrix.slice(start, next < 0 ? matrix.length : next);
    };
    if (!/^\s+- revision-compare-authority\s*$/mu.test(tierBlock('backend-unit'))
        || !/^\s+- revision-compare-authority\s*$/mu.test(tierBlock('static-governance')))
    {
        violations.push(`${matrixFile}: backend-unit and static-governance coverage must include revision-compare-authority`);
    }
    return violations;
}

export function checkRevisionCompareAuthority(root = repositoryRoot)
{
    return [
        ...checkRevisionCompareAuthoritySources(readRevisionCompareSources(root)),
        ...checkRevisionCompareIntegrationFiles(readRevisionCompareIntegration(root))
    ];
}

function main()
{
    const violations = checkRevisionCompareAuthority();
    if (violations.length > 0)
    {
        process.stderr.write(`[revision-compare-authority] failed\n${violations.map((item) => `- ${item}`).join('\n')}\n`);
        process.exitCode = 1;
        return;
    }
    process.stdout.write('[revision-compare-authority] ok\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main();
}
