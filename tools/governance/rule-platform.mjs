import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const RegistrySchema = 'fsusblog.custom-rule-registry.v1';
export const ComplexityPolicySchema = 'fsusblog.complexity-policy.v1';
export const ComplexityBaselineSchema = 'fsusblog.complexity-baseline.v1';
export const ExemptionSchema = 'fsusblog.complexity-exemptions.v1';
export const SummarySchema = 'fsusblog.rule-platform-summary.v1';

const EngineNames = new Set([
    'clang-ast',
    'eslint',
    'parser',
    'roslyn',
    'runtime',
    'style-ast',
    'text',
    'vue-ast'
]);

const SourceExtensions = new Set([
    '.c', '.cc', '.cmake', '.cpp', '.cs', '.cxx', '.h', '.hh', '.hpp', '.hxx',
    '.js', '.mjs', '.sh', '.ts', '.tsx', '.vue'
]);

function CompareOrdinal(left, right)
{
    return left === right ? 0 : left < right ? -1 : 1;
}

export function Sha256(value)
{
    return crypto.createHash('sha256').update(value).digest('hex');
}

export function ToPosix(value)
{
    return value.split(path.sep).join('/');
}

export function GlobToRegExp(pattern)
{
    let source = '';
    for (let index = 0; index < pattern.length; index += 1)
    {
        const character = pattern[index];
        if (character === '*' && pattern[index + 1] === '*')
        {
            if (pattern[index + 2] === '/')
            {
                source += '(?:.*/)?';
                index += 2;
            }
            else
            {
                source += '.*';
                index += 1;
            }
            continue;
        }
        if (character === '*')
        {
            source += '[^/]*';
            continue;
        }
        if (character === '?')
        {
            source += '[^/]';
            continue;
        }
        source += /[.+^${}()|[\]\\]/u.test(character) ? `\\${character}` : character;
    }
    return new RegExp(`^${source}$`, 'u');
}

function Matches(file, patterns)
{
    return patterns.some((pattern) => GlobToRegExp(pattern).test(file));
}

export class RepositoryInventory
{
    constructor(root, ignoredPaths = [])
    {
        this.root = path.resolve(root);
        this.ignoredPaths = ignoredPaths;
        this._files = null;
        this._contents = new Map();
        this.stats = {
            inventoryBuilds: 0,
            contentReads: 0,
            contentCacheHits: 0
        };
    }

    Files()
    {
        if (this._files !== null)
        {
            return this._files;
        }
        const output = execFileSync(
            'git',
            ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
            { cwd: this.root, encoding: 'utf8' }
        );
        this._files = output
            .split('\0')
            .filter(Boolean)
            .map(ToPosix)
            .filter((file) => !Matches(file, this.ignoredPaths))
            .sort(CompareOrdinal);
        this.stats.inventoryBuilds += 1;
        return this._files;
    }

    Read(file)
    {
        const normalized = ToPosix(file);
        if (this._contents.has(normalized))
        {
            this.stats.contentCacheHits += 1;
            return this._contents.get(normalized);
        }
        const content = fs.readFileSync(path.join(this.root, normalized), 'utf8');
        this._contents.set(normalized, content);
        this.stats.contentReads += 1;
        return content;
    }

    Fingerprint(files = this.Files())
    {
        const hash = crypto.createHash('sha256');
        for (const file of [...files].sort(CompareOrdinal))
        {
            hash.update(file);
            hash.update('\0');
            hash.update(this.Read(file));
            hash.update('\0');
        }
        return `sha256:${hash.digest('hex')}`;
    }
}

function PascalCase(value)
{
    return value
        .split(/[^A-Za-z0-9]+/u)
        .filter(Boolean)
        .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
        .join('');
}

function RuleClassification(identity)
{
    const value = identity.toLowerCase();
    const candidates = [
        ['security', 'SecurityGovernanceOwner', 'security-privacy'],
        ['privacy', 'PrivacyGovernanceOwner', 'security-privacy'],
        ['aeds', 'AedsContractOwner', 'aeds-wire'],
        ['binary', 'AedsContractOwner', 'aeds-wire'],
        ['wasm', 'WasmGovernanceOwner', 'aeds-wire'],
        ['release', 'ReleaseEngineeringOwner', 'release-evidence'],
        ['deploy', 'ReleaseEngineeringOwner', 'release-evidence'],
        ['test', 'TestGovernanceOwner', 'test-governance'],
        ['matrix', 'TestGovernanceOwner', 'test-governance'],
        ['a11y', 'FrontendExperienceOwner', 'accessibility-motion'],
        ['motion', 'FrontendExperienceOwner', 'accessibility-motion'],
        ['cache', 'PerformanceGovernanceOwner', 'cache-hot-read'],
        ['performance', 'PerformanceGovernanceOwner', 'cache-hot-read'],
        ['public', 'FrontendProductGovernanceOwner', 'product-governance'],
        ['frontend', 'FrontendProductGovernanceOwner', 'product-governance']
    ];
    for (const [needle, owner, category] of candidates)
    {
        if (value.includes(needle))
        {
            return { owner, category };
        }
    }
    return { owner: 'RepositoryGovernanceOwner', category: 'repository-governance' };
}

function SourceScopesFor(category, implementation)
{
    const categoryScopes = {
        'accessibility-motion': ['src/frontend/src/**', 'tests/frontend/**'],
        'aeds-wire': ['src/core/**', 'src/shared/**', 'src/frontend/wasm/**', 'tests/frontend/**'],
        'cache-hot-read': ['src/backend/**', 'src/frontend/src/**', 'tests/**'],
        'product-governance': ['src/frontend/src/**', 'tests/frontend/**'],
        'release-evidence': ['.github/**', 'ops/**', 'tools/**', 'tests/tools/**'],
        'repository-governance': ['config/**', 'docs/**', 'tools/**', 'tests/**'],
        'security-privacy': ['security/**', 'src/backend/**', 'src/frontend/src/privacy/**', 'tests/security/**'],
        'test-governance': ['tests/**', 'tools/test/**', '.github/workflows/**']
    };
    return [...new Set([implementation, ...(categoryScopes[category] ?? ['**/*'])])];
}

function DetectEngine(file, content)
{
    if (/eslint|typescript-eslint/u.test(content))
    {
        return 'eslint';
    }
    if (/@vue\/compiler|vue-eslint-parser/u.test(content))
    {
        return 'vue-ast';
    }
    if (/stylelint|postcss|scss-parser/u.test(content))
    {
        return 'style-ast';
    }
    if (/Microsoft\.CodeAnalysis|Roslyn/u.test(content) || file.endsWith('.cs'))
    {
        return 'roslyn';
    }
    if (/clang-tidy|clang-query/u.test(content))
    {
        return 'clang-ast';
    }
    if (/JSON\.parse|yaml|parseDocument|parse\(/u.test(content))
    {
        return 'parser';
    }
    if (file.endsWith('.sh') || /spawnSync|execFileSync|vitest|playwright|dotnet test/u.test(content))
    {
        return 'runtime';
    }
    return 'text';
}

function ExtractCommandImplementation(command)
{
    const candidates = command.match(/(?:\.\.\/\.\.\/)?(?:tools|tests)\/[A-Za-z0-9_./-]+\.(?:mjs|sh|cs)/gu) ?? [];
    return candidates[0]?.replace(/^\.\.\/\.\.\//u, '') ?? 'src/frontend/package.json';
}

function CommandRule(id, command)
{
    const implementation = ExtractCommandImplementation(command);
    const { owner, category } = RuleClassification(`${id} ${command}`);
    return {
        id: `Command.${PascalCase(id)}`,
        externalId: id,
        symbol: `Check${PascalCase(id.replace(/^check:/u, ''))}`,
        owner,
        category,
        engine: 'runtime',
        sourceScopes: SourceScopesFor(category, implementation),
        severity: 'error',
        fixable: false,
        changedFileSafe: false,
        dependencies: [],
        testFixtures: ['tests/tools/issue-1162-rule-platform.test.mjs'],
        documentation: 'docs/development/custom-rule-platform.md',
        execution: {
            mode: 'delegated-command',
            command,
            implementation,
            executionKey: `governance:${id}`,
            receiptCompatible: true
        }
    };
}

function ImplementationRule(file, content)
{
    const { owner, category } = RuleClassification(file);
    const engine = DetectEngine(file, content);
    const result = {
        id: `Implementation.${PascalCase(file)}`,
        externalId: file,
        symbol: `Check${PascalCase(file.replace(/\.[^.]+$/u, ''))}`,
        owner,
        category,
        engine,
        sourceScopes: SourceScopesFor(category, file),
        severity: 'error',
        fixable: false,
        changedFileSafe: true,
        dependencies: [],
        testFixtures: [file.startsWith('tests/') ? file : 'tests/tools/issue-1162-rule-platform.test.mjs'],
        documentation: 'docs/development/custom-rule-platform.md',
        execution: {
            mode: 'delegated-implementation',
            implementation: file,
            executionKey: `governance:file:${file}`,
            receiptCompatible: true
        }
    };
    if (engine === 'text')
    {
        result.textRationale = 'Legacy domain rule has no stable compiler or public AST API yet; formatting false-positive and false-negative behavior is locked by its registered fixture while migration remains explicit.';
    }
    return result;
}

export function DiscoverRules(root, configuration, inventory = new RepositoryInventory(root, configuration.inventory.ignoredPaths))
{
    const packageFile = configuration.inventory.packageScripts.file;
    const packageJson = JSON.parse(inventory.Read(packageFile));
    const prefix = configuration.inventory.packageScripts.prefix;
    const commandRules = Object.entries(packageJson.scripts ?? {})
        .filter(([id]) => id.startsWith(prefix))
        .map(([id, command]) => CommandRule(id, command));
    const implementationPatterns = configuration.inventory.implementationPatterns;
    const implementationRules = inventory.Files()
        .filter((file) => Matches(file, implementationPatterns))
        .map((file) => ImplementationRule(file, inventory.Read(file)));
    return [...commandRules, ...implementationRules].sort((left, right) => CompareOrdinal(left.id, right.id));
}

export function ValidateRegistry(root, registry, discoveredRules)
{
    const errors = [];
    if (registry.schema !== RegistrySchema)
    {
        errors.push(`registry schema must be ${RegistrySchema}`);
    }
    const required = [
        'id', 'externalId', 'symbol', 'owner', 'category', 'engine', 'sourceScopes',
        'severity', 'fixable', 'changedFileSafe', 'dependencies', 'testFixtures', 'documentation', 'execution'
    ];
    const ids = new Set();
    const symbols = new Set();
    for (const rule of registry.rules ?? [])
    {
        for (const field of required)
        {
            if (rule[field] === undefined || rule[field] === null || rule[field] === '')
            {
                errors.push(`${rule.id ?? '<unknown>'} is missing ${field}`);
            }
        }
        if (ids.has(rule.id))
        {
            errors.push(`duplicate rule ID ${rule.id}`);
        }
        ids.add(rule.id);
        if (symbols.has(rule.symbol))
        {
            errors.push(`duplicate internal symbol ${rule.symbol}`);
        }
        symbols.add(rule.symbol);
        if (!/^[A-Z][A-Za-z0-9.]*$/u.test(rule.id ?? ''))
        {
            errors.push(`${rule.id ?? '<unknown>'} must use PascalCase segments`);
        }
        if (!/^[A-Z][A-Za-z0-9]*$/u.test(rule.symbol ?? ''))
        {
            errors.push(`${rule.id ?? '<unknown>'} symbol must be PascalCase`);
        }
        if (!EngineNames.has(rule.engine))
        {
            errors.push(`${rule.id ?? '<unknown>'} has unsupported engine ${rule.engine}`);
        }
        if (!Array.isArray(rule.sourceScopes) || rule.sourceScopes.length === 0)
        {
            errors.push(`${rule.id ?? '<unknown>'} requires sourceScopes`);
        }
        if (!Array.isArray(rule.testFixtures) || rule.testFixtures.length === 0)
        {
            errors.push(`${rule.id ?? '<unknown>'} requires testFixtures`);
        }
        for (const fixture of rule.testFixtures ?? [])
        {
            if (!fs.existsSync(path.join(root, fixture)))
            {
                errors.push(`${rule.id ?? '<unknown>'} fixture does not exist: ${fixture}`);
            }
        }
        if (rule.engine === 'text' && !rule.textRationale)
        {
            errors.push(`${rule.id ?? '<unknown>'} text rule requires textRationale`);
        }
    }
    if (JSON.stringify(registry.rules ?? []) !== JSON.stringify(discoveredRules))
    {
        errors.push('registry inventory parity drift; run check-rule-platform.mjs --write-registry');
    }
    for (const rule of registry.rules ?? [])
    {
        for (const dependency of rule.dependencies ?? [])
        {
            if (!ids.has(dependency))
            {
                errors.push(`${rule.id} depends on missing rule ${dependency}`);
            }
        }
    }
    return errors;
}

export function SelectAffectedRules(rules, changedFiles)
{
    const selected = new Set();
    for (const rule of rules)
    {
        if (!rule.changedFileSafe || changedFiles.some((file) => Matches(file, rule.sourceScopes)))
        {
            selected.add(rule.id);
        }
    }
    let changed = true;
    while (changed)
    {
        changed = false;
        for (const rule of rules)
        {
            if (selected.has(rule.id))
            {
                for (const dependency of rule.dependencies ?? [])
                {
                    if (!selected.has(dependency))
                    {
                        selected.add(dependency);
                        changed = true;
                    }
                }
            }
        }
    }
    return rules.filter((rule) => selected.has(rule.id));
}

export function FileCategory(file)
{
    if (/\/(?:generated|Generated)\/|\.generated\./u.test(file))
    {
        return 'GeneratedContract';
    }
    if (/(?:^|\/)Modules\/Endpoints\/|^src\/backend\/Program\.cs$/u.test(file))
    {
        return 'EndpointComposition';
    }
    if (/^src\/backend\/(?:Services|Infrastructure)\//u.test(file))
    {
        return 'ServiceDomainLogic';
    }
    if (/^src\/(?:core\/Algorithms|core\/Cache|frontend\/wasm)\//u.test(file))
    {
        return 'CodecProtocol';
    }
    if (file.endsWith('.vue'))
    {
        return 'VueViewComponent';
    }
    if (/^(?:tools\/test|tools\/run-test|tests\/.*orchestrat|\.github\/workflows)\//u.test(file))
    {
        return 'BuildTestOrchestrator';
    }
    if (/(?:manifest|registry|matrix|catalog)/iu.test(path.posix.basename(file)))
    {
        return 'ManifestRegistry';
    }
    return 'HandwrittenModule';
}

function StripCommentsAndStrings(source)
{
    return source
        .replace(/\/\*[\s\S]*?\*\//gu, ' ')
        .replace(/(^|[^:])\/\/.*$/gmu, '$1')
        .replace(/#[^!].*$/gmu, '')
        .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/gu, '""');
}

export function MeasureComplexity(file, source, context = {})
{
    const stripped = StripCommentsAndStrings(source);
    const lines = source.split(/\r?\n/u);
    const codeLines = stripped.split(/\r?\n/u).filter((line) => line.trim()).length;
    const typeCount = (stripped.match(/\b(?:class|interface|record|struct|enum|type)\s+[A-Za-z_]/gu) ?? []).length;
    const functionCount = stripped.split(/\r?\n/u).filter((line) =>
    {
        const trimmed = line.trim();
        return /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/u.test(trimmed)
            || /^(?:(?:public|private|protected|internal|static|async|virtual|override|sealed|partial)\s+){0,5}[A-Za-z_$][\w$<>,?.[\]]*\s+[A-Za-z_$][\w$]*\s*\(/u.test(trimmed)
            || /^(?:export\s+)?(?:const|let)\s+[A-Za-z_$][\w$]*\s*=.*=>/u.test(trimmed);
    }).length;
    const branchMatches = stripped.match(/\b(?:if|else\s+if|for|foreach|while|case|catch)\b|&&|\|\||\?\?/gu) ?? [];
    let nesting = 0;
    let maxNestingDepth = 0;
    let cognitiveComplexity = 0;
    for (const line of stripped.split(/\r?\n/u))
    {
        const branchCount = (line.match(/\b(?:if|else\s+if|for|foreach|while|case|catch)\b/gu) ?? []).length;
        cognitiveComplexity += branchCount * (1 + nesting);
        for (const character of line)
        {
            if (character === '{')
            {
                nesting += 1;
                maxNestingDepth = Math.max(maxNestingDepth, nesting);
            }
            else if (character === '}')
            {
                nesting = Math.max(0, nesting - 1);
            }
        }
    }
    const dependencyCount = (stripped.match(/^\s*(?:using\s+|import\s+|#include\s+|source\s+|\.\s+)|\brequire\s*\(/gmu) ?? []).length;
    const publicSurfaceCount = (stripped.match(/\bpublic\s+(?:class|interface|record|struct|enum|static|async|[A-Za-z_])|\bexport\s+(?:default\s+)?(?:class|function|const|let|type|interface)/gu) ?? []).length;
    const responsibilityPatterns = {
        cache: /\bcache|redis/iu,
        database: /\bpostgres|database|dbcontext|sql/iu,
        http: /\bhttp|endpoint|request|response|route/iu,
        observability: /\btelemetry|metric|trace|log(?:ger)?/iu,
        protocol: /\baeds|codec|serialize|frame|wire/iu,
        security: /\bauth|security|privacy|credential|token|csrf/iu,
        ui: /\bcomponent|render|view|template|style/iu
    };
    const responsibilities = Object.entries(responsibilityPatterns)
        .filter(([, expression]) => expression.test(stripped))
        .map(([name]) => name)
        .sort(CompareOrdinal);
    return {
        category: FileCategory(file),
        fileLines: lines.length,
        codeLines,
        typeCount,
        functionMethodCount: functionCount,
        cyclomaticComplexity: branchMatches.length + 1,
        cognitiveComplexity,
        maxNestingDepth,
        dependencyImportCount: dependencyCount,
        publicSurfaceCount,
        responsibilityCount: responsibilities.length,
        responsibilities,
        generated: FileCategory(file) === 'GeneratedContract',
        churn365Days: context.churn?.get(file) ?? 0,
        testRelationshipCount: context.testRelationships?.get(file) ?? 0
    };
}

function Percentile(values, quantile)
{
    if (values.length === 0)
    {
        return 0;
    }
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

function ChurnByFile(root)
{
    const result = spawnSync('git', ['log', '--since=365 days ago', '--name-only', '--pretty=format:'], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024
    });
    const churn = new Map();
    if (result.status === 0)
    {
        for (const file of result.stdout.split(/\r?\n/u).filter(Boolean).map(ToPosix))
        {
            churn.set(file, (churn.get(file) ?? 0) + 1);
        }
    }
    return churn;
}

function TestRelationships(files)
{
    const testNames = files
        .filter((file) => file.startsWith('tests/'))
        .map((file) => path.posix.basename(file).replace(/(?:Tests?|\.test|\.spec)?\.[^.]+$/iu, '').toLowerCase());
    const relationships = new Map();
    for (const file of files)
    {
        if (file.startsWith('tests/'))
        {
            continue;
        }
        const name = path.posix.basename(file).replace(/\.[^.]+$/u, '').toLowerCase();
        relationships.set(file, testNames.filter((testName) => testName.includes(name) || name.includes(testName)).length);
    }
    return relationships;
}

export function BuildComplexityBaseline(root, policy, inventory)
{
    const files = inventory.Files().filter((file) => SourceExtensions.has(path.posix.extname(file)));
    const churn = ChurnByFile(root);
    const testRelationships = TestRelationships(files);
    const fileMetrics = {};
    for (const file of files)
    {
        fileMetrics[file] = MeasureComplexity(file, inventory.Read(file), { churn, testRelationships });
    }
    const categoryStatistics = {};
    const hardGateMetrics = policy.metrics.filter((metric) => metric.hardGate);
    for (const category of Object.keys(policy.categories))
    {
        const entries = Object.values(fileMetrics).filter((metrics) =>
            metrics.category === category && (category === 'GeneratedContract' || !metrics.generated));
        categoryStatistics[category] = {
            fileCount: entries.length,
            budgets: Object.fromEntries(hardGateMetrics.map((metric) => [
                metric.id,
                Math.max(metric.minimumBudget, Percentile(entries.map((entry) => entry[metric.id]), policy.categories[category].baselineQuantile))
            ])),
            observations: Object.fromEntries(policy.metrics.map((metric) => [
                metric.id,
                {
                    p50: Percentile(entries.map((entry) => Number(entry[metric.id])), 0.5),
                    p95: Percentile(entries.map((entry) => Number(entry[metric.id])), 0.95),
                    max: Math.max(0, ...entries.map((entry) => Number(entry[metric.id])))
                }
            ]))
        };
    }
    const excessFiles = {};
    for (const [file, metrics] of Object.entries(fileMetrics))
    {
        if (metrics.generated)
        {
            continue;
        }
        const budgets = categoryStatistics[metrics.category].budgets;
        const excess = Object.fromEntries(hardGateMetrics
            .filter((metric) => metrics[metric.id] > budgets[metric.id])
            .map((metric) => [metric.id, metrics[metric.id]]));
        if (Object.keys(excess).length > 0)
        {
            excessFiles[file] = { category: metrics.category, excess };
        }
    }
    return {
        schema: ComplexityBaselineSchema,
        sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        measurement: 'deterministic lexical structure with one shared repository inventory and content cache',
        metricFields: policy.metrics.map((metric) => metric.id),
        categoryStatistics,
        files: excessFiles
    };
}

export function ValidateExemptions(root, exemptions, currentMetrics, today = new Date())
{
    const errors = [];
    if (exemptions.schema !== ExemptionSchema)
    {
        errors.push(`exemption schema must be ${ExemptionSchema}`);
    }
    for (const exemption of exemptions.exemptions ?? [])
    {
        for (const field of ['file', 'owner', 'reason', 'expires', 'reviewIssue', 'sourceFingerprint'])
        {
            if (!exemption[field])
            {
                errors.push(`${exemption.file ?? '<unknown>'} exemption is missing ${field}`);
            }
        }
        if (!/^https:\/\/github\.com\/Ozwasyd\/FsusBlog\/issues\/\d+$/u.test(exemption.reviewIssue ?? ''))
        {
            errors.push(`${exemption.file ?? '<unknown>'} exemption reviewIssue must be a repository issue URL`);
        }
        const expiry = new Date(`${exemption.expires}T23:59:59Z`);
        if (!Number.isFinite(expiry.getTime()) || expiry < today)
        {
            errors.push(`${exemption.file ?? '<unknown>'} exemption is expired`);
        }
        const metrics = currentMetrics[exemption.file];
        if (!metrics)
        {
            errors.push(`${exemption.file ?? '<unknown>'} exemption source is missing`);
        }
        else if (`sha256:${Sha256(JSON.stringify(metrics))}` !== exemption.sourceFingerprint)
        {
            errors.push(`${exemption.file} exemption sourceFingerprint is stale`);
        }
    }
    return errors;
}

export function ComplexityViolations(policy, baseline, currentMetrics, exemptions, files)
{
    const exemptFiles = new Set((exemptions.exemptions ?? []).map((entry) => entry.file));
    const violations = [];
    for (const file of files)
    {
        const current = currentMetrics[file];
        if (!current || current.generated || exemptFiles.has(file))
        {
            continue;
        }
        const categoryPolicy = policy.categories[current.category];
        const budgets = baseline.categoryStatistics[current.category]?.budgets ?? {};
        const previous = baseline.files[file];
        for (const metric of policy.metrics.filter((entry) => entry.hardGate))
        {
            const budget = budgets[metric.id] ?? metric.minimumBudget;
            const previousValue = previous?.excess?.[metric.id] ?? previous?.[metric.id] ?? 0;
            const wasLegacyExcess = previousValue > budget;
            const significantGrowth = !wasLegacyExcess
                || current[metric.id] > Math.ceil(previousValue * (1 + categoryPolicy.growthAllowancePercent / 100));
            if (current[metric.id] > budget && significantGrowth)
            {
                violations.push({
                    rule: 'Governance.ComplexityBudget',
                    file,
                    metric: metric.id,
                    actual: current[metric.id],
                    budget,
                    previous: previousValue,
                    message: `${current.category} ${metric.id} ${current[metric.id]} exceeds data-derived budget ${budget} after significant growth; split the responsibility or add a reviewed, expiring exemption`
                });
            }
        }
    }
    return violations;
}

export function ReadJson(file)
{
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function StableJson(value)
{
    return `${JSON.stringify(value, null, 4)}\n`;
}
