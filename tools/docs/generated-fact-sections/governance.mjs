/**
 * Repository governance for generated fact sections:
 * single registry, no compat markers, no baseline allowlist, no warning-only,
 * renderers must not import extractors/business implementations/tests.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { catalogRelative, catalogSchemaRelative, root } from './catalog.mjs';
import { GeneratedSectionErrorCode } from './markers.mjs';

export const frameworkFiles = Object.freeze([
    'tools/docs/generated-fact-sections/markers.mjs',
    'tools/docs/generated-fact-sections/renderers.mjs',
    'tools/docs/generated-fact-sections/catalog.mjs',
    'tools/docs/generated-fact-sections/generator.mjs',
    'tools/docs/generated-fact-sections/governance.mjs',
    'tools/docs/generate-fact-sections.mjs',
    catalogRelative,
    catalogSchemaRelative,
    'tests/tools/generated-fact-sections.test.mjs',
    'tests/tools/doc-claim-staleness-mutation.test.mjs',
    'tools/docs/doc-claim-staleness-mutation/layers.mjs',
    'tools/docs/doc-claim-staleness-mutation/fixture.mjs',
    'tools/docs/doc-claim-staleness-mutation/catalog.mjs',
    'tools/docs/doc-claim-staleness-mutation/runner.mjs',
    'tools/docs/doc-claim-staleness-mutation/governance.mjs',
    'tools/docs/doc-claim-staleness-mutation/index.mjs',
    'docs/development/doc-claim-protocol.md'
]);

const scanRoots = Object.freeze(['tools', 'tests', 'config', 'docs']);

function walkFiles(directory, out = [])
{
    if (!existsSync(directory))
    {
        return out;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true }))
    {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.tmp')
        {
            continue;
        }
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory())
        {
            walkFiles(absolute, out);
        }
        else if (entry.isFile())
        {
            out.push(absolute);
        }
    }
    return out;
}

function relativeOf(repositoryRoot, absolute)
{
    return path.relative(repositoryRoot, absolute).replaceAll(path.sep, '/');
}

function writeTargetsLifecycleMetadata(source)
{
    const lifecyclePath = /config\/development\/document-(?:lifecycle\.json|inventory\.generated\.json)/u;
    const callPattern = /\bwriteFileSync\s*\(/gu;
    for (const match of source.matchAll(callPattern))
    {
        const open = match.index + match[0].lastIndexOf('(');
        let depth = 1;
        let quote = null;
        let escaped = false;
        let argument = '';
        for (let index = open + 1; index < source.length; index += 1)
        {
            const character = source[index];
            if (quote !== null)
            {
                argument += character;
                if (escaped)
                {
                    escaped = false;
                }
                else if (character === '\\')
                {
                    escaped = true;
                }
                else if (character === quote)
                {
                    quote = null;
                }
                continue;
            }
            if (character === '\'' || character === '"' || character === '`')
            {
                quote = character;
                argument += character;
                continue;
            }
            if (character === '(' || character === '[' || character === '{')
            {
                depth += 1;
            }
            else if (character === ')' || character === ']' || character === '}')
            {
                depth -= 1;
            }
            if ((character === ',' && depth === 1) || depth === 0)
            {
                break;
            }
            argument += character;
        }
        if (lifecyclePath.test(argument))
        {
            return true;
        }
    }
    return false;
}

export function scanGeneratedFactSectionGovernance(repositoryRoot = root)
{
    const violations = [];
    const allow = new Set(frameworkFiles);

    // Framework files must exist.
    for (const relative of frameworkFiles)
    {
        if (relative.endsWith('.md') || relative.endsWith('.test.mjs'))
        {
            continue;
        }
        const absolute = path.join(repositoryRoot, relative);
        if (!existsSync(absolute))
        {
            violations.push({
                code: GeneratedSectionErrorCode.CATALOG_INVALID,
                documentPath: relative,
                message: `missing generated-fact-section framework file ${relative}`
            });
        }
    }

    const rendererPath = path.join(repositoryRoot, 'tools/docs/generated-fact-sections/renderers.mjs');
    if (existsSync(rendererPath))
    {
        const rendererSource = readFileSync(rendererPath, 'utf8');
        if (/fact-extractors\/(?!reader\.mjs)/u.test(rendererSource)
            || /from\s+['"][^'"]*fact-extractors\/(?:runner|seeds|auth-|content-|config-|openapi)/u.test(rendererSource))
        {
            violations.push({
                code: GeneratedSectionErrorCode.SECOND_REGISTRY,
                documentPath: 'tools/docs/generated-fact-sections/renderers.mjs',
                message: 'renderer must not import extractor implementations'
            });
        }
        if (/from\s+['"][^'"]*\/src\//u.test(rendererSource)
            || /from\s+['"][^'"]*tests\//u.test(rendererSource))
        {
            violations.push({
                code: GeneratedSectionErrorCode.SECOND_REGISTRY,
                documentPath: 'tools/docs/generated-fact-sections/renderers.mjs',
                message: 'renderer must not import business implementations or tests'
            });
        }
        if (/\bfeatureFlag\b|\bwarningOnly\b|\bbaselineAllowlist\b|\ballowDiff\b/u.test(rendererSource)
            && !/forbidden|must not|reject|never/iu.test(rendererSource))
        {
            violations.push({
                code: GeneratedSectionErrorCode.WARNING_ONLY,
                documentPath: 'tools/docs/generated-fact-sections/renderers.mjs',
                message: 'renderer admits warning-only/feature-flag/baseline allowlist surface'
            });
        }
        if ((rendererSource.match(/\bexport\s+const\s+\w*RendererRegistry\b/gu) ?? []).length > 1)
        {
            violations.push({
                code: GeneratedSectionErrorCode.SECOND_REGISTRY,
                documentPath: 'tools/docs/generated-fact-sections/renderers.mjs',
                message: 'second RendererRegistry export detected'
            });
        }
    }

    const generatorPath = path.join(repositoryRoot, 'tools/docs/generated-fact-sections/generator.mjs');
    if (existsSync(generatorPath))
    {
        const generatorSource = readFileSync(generatorPath, 'utf8');
        if (/existingBody/.test(generatorSource)
            && /renderSectionBody|RendererRegistry\.render/u.test(generatorSource)
            && /existingBody\s*[,)]/.test(generatorSource))
        {
            // Only fail if existingBody is passed into render path.
            if (/render\w*\([^)]*existingBody/u.test(generatorSource))
            {
                violations.push({
                    code: GeneratedSectionErrorCode.CHECK_DRIFT,
                    documentPath: 'tools/docs/generated-fact-sections/generator.mjs',
                    message: 'generator must not feed old section body into renderers'
                });
            }
        }
        if (writeTargetsLifecycleMetadata(generatorSource))
        {
            violations.push({
                code: GeneratedSectionErrorCode.LIFECYCLE_MUTATION,
                documentPath: 'tools/docs/generated-fact-sections/generator.mjs',
                message: 'generator must not update document lifecycle metadata'
            });
        }
        if (/fact-extractors\/(?:runner|seeds)\//u.test(generatorSource)
            || /\brunExtractor\b|\bimportExtractorModule\b/u.test(generatorSource))
        {
            violations.push({
                code: GeneratedSectionErrorCode.SECOND_REGISTRY,
                documentPath: 'tools/docs/generated-fact-sections/generator.mjs',
                message: 'generator must consume receipts, not invoke extractors'
            });
        }
    }

    for (const relativeRoot of scanRoots)
    {
        const absoluteRoot = path.join(repositoryRoot, relativeRoot);
        for (const absolute of walkFiles(absoluteRoot))
        {
            if (!/\.(?:mjs|js|ts|json|md)$/u.test(absolute))
            {
                continue;
            }
            const relative = relativeOf(repositoryRoot, absolute);
            if (allow.has(relative))
            {
                continue;
            }
            // Skip large generated inventories.
            if (relative.includes('document-inventory.generated.json'))
            {
                continue;
            }
            if (relative.includes('node_modules'))
            {
                continue;
            }

            let source;
            try
            {
                const size = statSync(absolute).size;
                if (size > 1_500_000)
                {
                    continue;
                }
                source = readFileSync(absolute, 'utf8');
            }
            catch
            {
                continue;
            }

            if (/FSUSBLOG-GENERATED-LEGACY:|FSUSBLOG-GENERATED-V\d+:|fsus-generated:/iu.test(source))
            {
                violations.push({
                    code: GeneratedSectionErrorCode.MARKER_COMPAT,
                    documentPath: relative,
                    message: 'compatibility generated-section marker detected'
                });
            }
            if (/\bdomainRendererRegistry\b|\blegacyRendererRegistry\b|\bcreateRendererRegistry\b/u.test(source))
            {
                violations.push({
                    code: GeneratedSectionErrorCode.SECOND_REGISTRY,
                    documentPath: relative,
                    message: 'second renderer registry surface detected'
                });
            }
            if (/\bgeneratedSectionBaselineAllowlist\b|\bsectionDiffAllowlist\b|\ballowGeneratedDiff\b/u.test(source))
            {
                violations.push({
                    code: GeneratedSectionErrorCode.BASELINE_ALLOWLIST,
                    documentPath: relative,
                    message: 'generated-section baseline allowlist surface detected'
                });
            }
            if (/\bwarningOnlyGeneratedSections\b|\bgeneratedSectionFeatureFlag\b/u.test(source))
            {
                violations.push({
                    code: GeneratedSectionErrorCode.WARNING_ONLY,
                    documentPath: relative,
                    message: 'warning-only/feature-flag generated-section surface detected'
                });
            }
        }
    }

    return violations;
}

export function formatGovernanceViolations(violations)
{
    return violations.map((entry) => `[${entry.code}] ${entry.documentPath}: ${entry.message}`);
}
