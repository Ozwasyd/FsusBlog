/* eslint-disable import-x/no-relative-parent-imports -- Repository contract tests and tool authorities intentionally compose sibling owner modules. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runtimeSteps } from '../test/bundles/bundle-steps.mjs';

import { parseMatrix } from './parse-matrix.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arrays = ['reads', 'writes', 'deletes', 'invalidates', 'creates', 'exclusiveStateDomains'];
const operationArrays = ['reads', 'writes', 'deletes', 'invalidates', 'creates'];
const sortedUnique = (values) => Array.isArray(values) && values.every((value, index) => typeof value === 'string' && value && (!index || values[index - 1] < value));

function validateSchemaValue(schemaRoot, schema, value, location = '$')
{
    if (schema.$ref)
    {
        const target = schema.$ref.split('/').slice(1).reduce((current, key) => current?.[key], schemaRoot);
        return target ? validateSchemaValue(schemaRoot, target, value, location) : [`${location} has unresolved schema ref ${schema.$ref}`];
    }
    if (schema.oneOf)
    {
        const results = schema.oneOf.map((candidate) => validateSchemaValue(schemaRoot, candidate, value, location));
        return results.filter((errors) => errors.length === 0).length === 1 ? [] : [`${location} must match exactly one schema variant`];
    }
    const errors = [];
    if (schema.const !== undefined && value !== schema.const)
    {
        errors.push(`${location} must equal ${schema.const}`);
    }
    if (schema.enum && !schema.enum.includes(value))
    {
        errors.push(`${location} has invalid enum value`);
    }
    if (schema.type === 'object')
    {
        if (!value || typeof value !== 'object' || Array.isArray(value))
        {
            return [`${location} must be an object`];
        }
        for (const key of schema.required ?? [])
        {
            if (!(key in value))
            {
                errors.push(`${location} missing required property ${key}`);
            }
        }
        if (schema.additionalProperties === false)
        {
            for (const key of Object.keys(value))
            {
                if (!(key in (schema.properties ?? {})))
                {
                    errors.push(`${location} has additional property ${key}`);
                }
            }
        }
        for (const [key, child] of Object.entries(schema.properties ?? {}))
        {
            if (key in value)
            {
                errors.push(...validateSchemaValue(schemaRoot, child, value[key], `${location}.${key}`));
            }
        }
    }
    else if (schema.type === 'array')
    {
        if (!Array.isArray(value))
        {
            return [`${location} must be an array`];
        }
        if (schema.minItems && value.length < schema.minItems)
        {
            errors.push(`${location} requires at least ${schema.minItems} items`);
        }
        if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length)
        {
            errors.push(`${location} must contain unique items`);
        }
        value.forEach((item, index) => errors.push(...validateSchemaValue(schemaRoot, schema.items ?? {}, item, `${location}[${index}]`)));
    }
    else if (schema.type === 'string')
    {
        if (typeof value !== 'string' || (schema.minLength && value.length < schema.minLength))
        {
            errors.push(`${location} must be a non-empty string`);
        }
        else if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value))
        {
            errors.push(`${location} does not match ${schema.pattern}`);
        }
    }
    return errors;
}

export function analyzeRuntimeStateAccess(source)
{
    return [...new Set(analyzeRuntimeStateOperations(source).map((finding) => finding.domain))].sort();
}

function shellConditionOperand(value, aliases)
{
    const parameter = value.match(/^\$\{([A-Z_][A-Z0-9_]*):-([\s\S]*)\}$/u);
    if (parameter)
    {
        return { parameter: parameter[1], fallback: /[$`]/u.test(parameter[2]) ? null : parameter[2] };
    }
    const variable = value.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/u);
    return variable ? aliases.get(variable[1]) ?? { unknown: value } : { unknown: value };
}

function shellConditionPredicate(expression, aliases)
{
    // This closed shell form is observed from source, including its literals and
    // aliases. Other shell syntax stays unknown; no function or step is exempt.
    const match = expression.match(/^\[\[\s*"(\$\w+)"\s*==\s*"([^"$`]+)"\s*&&\s*-n\s*"(\$\{[A-Z_][A-Z0-9_]*:-\})"\s*&&\s*\(\s*"(\$\w+)"\s*==\s*"([^"$`]+)"\s*\|\|\s*"(\$\w+)"\s*==\s*"([^"$`]+)"\s*\)\s*\]\]$/u);
    if (!match)
    {
        return null;
    }
    return { all: [
        { operand: shellConditionOperand(match[1], aliases), equals: match[2] },
        { operand: shellConditionOperand(match[3], aliases), nonempty: true },
        { any: [
            { operand: shellConditionOperand(match[4], aliases), equals: match[5] },
            { operand: shellConditionOperand(match[6], aliases), equals: match[7] }
        ] }
    ] };
}

function evaluateShellCondition(predicate, environment)
{
    if (!predicate)
    {
        return 'unknown';
    }
    const children = predicate.all ?? predicate.any;
    if (children)
    {
        const values = children.map((child) => evaluateShellCondition(child, environment));
        const decisive = predicate.all ? 'false' : 'true';
        return values.includes(decisive) ? decisive : values.includes('unknown') ? 'unknown' : predicate.all ? 'true' : 'false';
    }
    const operand = predicate.operand;
    if (!operand?.parameter || !Object.hasOwn(environment, operand.parameter)
        || typeof environment[operand.parameter] !== 'string')
    {
        return 'unknown';
    }
    const value = environment[operand.parameter] || operand.fallback;
    if (value === null)
    {
        return 'unknown';
    }
    return (predicate.nonempty ? value.length > 0 : value === predicate.equals) ? 'true' : 'false';
}

function shellConditionsByLine(source, environment)
{
    const lines = source.split(/\r?\n/u);
    const aliases = new Map();
    const stack = [];
    return lines.map((line, index) =>
    {
        const assignment = line.match(/^\s*(?:local\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
        if (assignment)
        {
            const quoted = assignment[2].match(/^"([^"]*)"\s*$/u);
            aliases.set(assignment[1], quoted ? shellConditionOperand(quoted[1], aliases) : { unknown: assignment[2] });
        }
        if (/^\s*fi(?:\s|;|$)/u.test(line))
        {
            stack.pop();
        }
        else if (/^\s*(?:else|elif)(?:\s|;|$)/u.test(line) && stack.length)
        {
            // Alternative branches and unsupported nested syntax remain
            // conditional and unknown rather than reusing the then predicate.
            stack[stack.length - 1] = { expression: line.trim(), line: index + 1, predicate: null, value: 'unknown' };
        }
        else if (/^\s*if\s+(?!\()/u.test(line))
        {
            const header = [];
            for (let cursor = index; cursor < lines.length; cursor += 1)
            {
                header.push(lines[cursor].trim());
                if (/;\s*then\s*(?:#.*)?$/u.test(lines[cursor]) || /^\s*then\s*(?:#.*)?$/u.test(lines[cursor]))
                {
                    break;
                }
            }
            const expression = header.join(' ').replace(/^if\s+/u, '').replace(/;?\s*then\s*(?:#.*)?$/u, '');
            const predicate = shellConditionPredicate(expression, aliases);
            stack.push({ expression, line: index + 1, predicate, value: evaluateShellCondition(predicate, environment) });
        }
        return stack.map((condition) => ({ ...condition }));
    });
}

export function analyzeRuntimeStateOperations(source, sourcePath = '<fixture>', { conditionEnvironment = {} } = {})
{
    const findings = [];
    const seen = new Set();
    const conditions = shellConditionsByLine(source, conditionEnvironment);
    const add = (operation, domain, matcher, lineNumber) =>
    {
        const key = `${operation}\0${domain}\0${sourcePath}\0${lineNumber}`;
        if (!seen.has(key))
        {
            const guards = conditions[lineNumber - 1];
            findings.push({ operation, domain, source: sourcePath, line: lineNumber, ruleId: `${domain}.${operation}`, matcher,
                ...(guards.length ? { conditions: guards, conditionState: guards.some((guard) => guard.value === 'false')
                    ? 'false' : guards.every((guard) => guard.value === 'true') ? 'true' : 'unknown' } : {}) });
        }
        seen.add(key);
    };
    source.split(/\r?\n/u).forEach((line, index) =>
    {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//'))
        {
            return;
        }
        const domains = new Set();
        if (/postgres|psql|database|sql/iu.test(line))
        {
            if (/security|risk|pow/iu.test(line))
            {
                domains.add('postgres.security');
            }
            else if (/comment/iu.test(line))
            {
                domains.add('postgres.comment');
            }
            else if (/article|taxonomy|public_content/iu.test(line))
            {
                domains.add('postgres.article');
            }
            else if (/auth|user|identity|session/iu.test(line))
            {
                domains.add('postgres.auth');
            }
            else if (/outbox/iu.test(line))
            {
                domains.add('postgres.outbox');
            }
            else if (/audit/iu.test(line))
            {
                domains.add('postgres.audit');
            }
            else if (/setting|config/iu.test(line))
            {
                domains.add('postgres.settings');
            }
            else
            {
                domains.add('postgres.schema');
            }
        }
        if (/redis/iu.test(line))
        {
            if (/pow-risk|rate.?limit|security|risk/iu.test(line))
            {
                domains.add('redis.rate-limit');
            }
            else if (/session/iu.test(line))
            {
                domains.add('redis.session');
            }
            else if (/notification/iu.test(line))
            {
                domains.add('redis.notification');
            }
            else if (/private/iu.test(line))
            {
                domains.add('redis.cache.private');
            }
            else
            {
                domains.add('redis.cache.public');
            }
        }
        if (/fixture/iu.test(line))
        {
            if (/auth|identity/iu.test(line))
            {
                domains.add('fixture.auth-identities');
            }
            else if (/security/iu.test(line))
            {
                domains.add('fixture.security-state');
            }
            else if (/config|env/iu.test(line))
            {
                domains.add('fixture.runtime-config');
            }
            else
            {
                domains.add('fixture.public-content');
            }
        }
        if (/public.?aot|aot.*overlay|overlay.*aot/iu.test(line))
        {
            domains.add('artifact.public-aot-overlay');
        }
        if (/release.?derived|hydration/iu.test(line))
        {
            domains.add('artifact.release-derived');
        }
        if (/static.?web|static.?asset/iu.test(line))
        {
            domains.add('artifact.static-web-assets');
        }
        if (/release.?preview/iu.test(line))
        {
            domains.add('runtime.release-preview');
        }
        if (/frontend.?preview|debug.?frontend/iu.test(line))
        {
            domains.add('runtime.frontend-preview');
        }
        if (/backend.?process|debug.?backend|backend.?url/iu.test(line))
        {
            domains.add('runtime.backend-process');
        }
        if (/zap.*container|docker run.*zap/iu.test(line))
        {
            domains.add('network.zap-container');
        }
        if (/host.?topology|portbindings|--network host/iu.test(line))
        {
            domains.add('network.host-topology');
        }
        if (domains.size === 0)
        {
            return;
        }
        const operations = new Set();
        if (/\b(?:rm|unlink|delete\s+from|redis-cli\s+del)\b/iu.test(line))
        {
            operations.add('deletes');
        }
        if (/\b(?:mkdir|docker\s+run|insert\s+into)\b/iu.test(line))
        {
            operations.add('creates');
        }
        if (/\b(?:invalidate|flushdb|cache[^\n]*(?:clear|remove))\b/iu.test(line))
        {
            operations.add('invalidates');
        }
        if (/\b(?:update\s+\w+\s+set|redis-cli\s+(?:set|hset)|writeFile|start|publish)\b/iu.test(line))
        {
            operations.add('writes');
        }
        if (/\b(?:select|scan|curl|fetch|readFile|inspect|pg_isready|ping|test\s+-)\b/iu.test(line) || line.includes('[['))
        {
            operations.add('reads');
        }
        if (operations.size === 0)
        {
            return;
        }
        for (const domain of domains)
        {
            for (const operation of operations)
            {
                const domainOperation = domain === 'network.host-topology' && ['creates', 'deletes'].includes(operation) ? 'reads' : operation;
                add(domainOperation, domain, trimmed, index + 1);
            }
        }
    });
    return findings;
}

function repositorySourcePath(candidate, baseDirectory = '.')
{
    if (!candidate || path.posix.isAbsolute(candidate))
    {
        return null;
    }
    const normalized = path.posix.normalize(path.posix.join(baseDirectory, candidate.replace(/^\.\//u, '')));
    return normalized === '..' || normalized.startsWith('../') ? null : normalized;
}

function commandSourcePaths(command, baseDirectory = '.')
{
    const sources = [];
    const errors = [];
    for (const match of String(command ?? '').matchAll(/(?:^|\s)([A-Za-z0-9_./-]+\.(?:sh|mjs))(?:\s|$)/gu))
    {
        const source = repositorySourcePath(match[1], baseDirectory);
        if (source)
        {
            sources.push(source);
        }
        else
        {
            errors.push(`command source escapes repository: ${match[1]}`);
        }
    }
    return { sources, errors };
}

function staticShellSources(file, text)
{
    const directory = path.posix.dirname(file);
    const sources = [];
    for (const line of text.matchAll(/^\s*(?:source|\.)\s+(.+)$/gmu))
    {
        const repositoryPath = line[1].match(/\$ROOT_DIR\/([A-Za-z0-9_./-]+\.sh)/u)?.[1];
        const basename = line[1].match(/([A-Za-z0-9_.-]+\.sh)/u)?.[1];
        if (repositoryPath)
        {
            sources.push(repositoryPath);
        }
        else if (basename)
        {
            sources.push(path.posix.normalize(path.posix.join(directory, basename)));
        }
    }
    return sources;
}

export function discoverStaticModuleSources(file, text)
{
    const directory = path.posix.dirname(file);
    const code = text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
    return [...code.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"](\.[^'"]+\.mjs)['"]/gu)]
        .map((match) => path.posix.normalize(path.posix.join(directory, match[1])));
}

function shellFunctions(text)
{
    const functions = new Map();
    const header = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(\)\s*\{/gmu;
    for (const match of text.matchAll(header))
    {
        let depth = 1;
        let cursor = match.index + match[0].length;
        while (cursor < text.length && depth > 0)
        {
            if (text[cursor] === '{')
            {
                depth += 1;
            }
            else if (text[cursor] === '}')
            {
                depth -= 1;
            }
            cursor += 1;
        }
        functions.set(match[1], text.slice(match.index, cursor));
    }
    return functions;
}

function shellTopLevel(text)
{
    let result = text;
    for (const body of shellFunctions(text).values())
    {
        result = result.replace(body, '');
    }
    return result;
}

export function discoverShellCallNames(text, candidates)
{
    const code = text
        .replace(/^\s*#.*$/gmu, '')
        .replace(/#[^\n]*$/gu, '')
        .replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/gu, ' ');
    return [...candidates].filter((name) => new RegExp(`\\b${name}\\b`, 'u').test(code));
}

export function analyzeRuntimeStepCommand(step, { sourceOverrides = new Map(), conditionEnvironment = {} } = {})
{
    const direct = commandSourcePaths(step.command ?? '');
    const entrySources = [...direct.sources];
    const resolutionErrors = [...direct.errors];
    if (/\bnpm\s+run\b/u.test(step.command ?? ''))
    {
        const directory = (step.command ?? '').match(/\bcd\s+([^\s;&]+)/u)?.[1] ?? '.';
        const packageDirectory = repositorySourcePath('.', directory);
        const packagePath = packageDirectory && repositorySourcePath('package.json', packageDirectory);
        if (!packagePath)
        {
            resolutionErrors.push(`package cwd escapes repository: ${directory}`);
            return { entrySources: [], sources: [], calledFunctions: [], domains: [], findings: [], resolutionErrors };
        }
        entrySources.push(packagePath);
        const scriptId = (step.command ?? '').match(/\bnpm\s+run\s+([A-Za-z0-9:_-]+)/u)?.[1];
        if (!scriptId)
        {
            resolutionErrors.push(`npm command has no resolvable script id: ${step.command}`);
        }
        else
        {
            try
            {
                const packageSource = sourceOverrides.get(packagePath) ?? fs.readFileSync(path.join(root, packagePath), 'utf8');
                const packageJson = JSON.parse(packageSource);
                const packageScript = packageJson.scripts?.[scriptId];
                if (typeof packageScript !== 'string' || !packageScript.trim())
                {
                    resolutionErrors.push(`package script is missing: ${packagePath}#${scriptId}`);
                }
                else
                {
                    const nested = commandSourcePaths(packageScript, packageDirectory);
                    entrySources.push(...nested.sources);
                    resolutionErrors.push(...nested.errors.map((error) => `${packagePath}#${scriptId}: ${error}`));
                    if (nested.sources.length === 0)
                    {
                        resolutionErrors.push(`package script has no resolvable repository entry: ${packagePath}#${scriptId}`);
                    }
                }
            }
            catch (error)
            {
                resolutionErrors.push(`package manifest is unreadable: ${packagePath}: ${error.message}`);
            }
        }
    }
    const pending = [...entrySources];
    const sources = new Set();
    const access = new Set();
    const findings = [];
    const exists = (source) => sourceOverrides.has(source) || fs.existsSync(path.join(root, source));
    const read = (source) => sourceOverrides.get(source) ?? fs.readFileSync(path.join(root, source), 'utf8');
    while (pending.length)
    {
        const source = pending.pop();
        if (sources.has(source))
        {
            continue;
        }
        if (!repositorySourcePath(source) || !exists(source))
        {
            resolutionErrors.push(`repository source is missing or invalid: ${source}`);
            continue;
        }
        sources.add(source);
        const text = read(source);
        const analyzedText = source.endsWith('.sh') && !entrySources.includes(source) ? shellTopLevel(text) : text;
        for (const domain of analyzeRuntimeStateAccess(analyzedText))
        {
            access.add(domain);
        }
        findings.push(...analyzeRuntimeStateOperations(analyzedText, source, { conditionEnvironment }));
        const nestedSources = source.endsWith('.sh')
            ? staticShellSources(source, text)
            : source.endsWith('.mjs')
        ? discoverStaticModuleSources(source, text)
        : [];
        for (const nested of nestedSources)
        {
            if (repositorySourcePath(nested))
            {
                pending.push(nested);
            }
            else
            {
                resolutionErrors.push(`nested source escapes repository: ${source} -> ${nested}`);
            }
        }
    }
    const functionMap = new Map();
    for (const source of sources)
    {
        if (!source.endsWith('.sh'))
        {
            continue;
        }
        for (const [name, body] of shellFunctions(read(source)))
        {
            functionMap.set(name, { body, source });
        }
    }
    const called = new Set();
    const callQueue = [];
    for (const source of entrySources.filter((candidate) => candidate.endsWith('.sh') && sources.has(candidate)))
    {
        const text = read(source);
        for (const name of discoverShellCallNames(text, functionMap.keys()))
        {
            callQueue.push(name);
        }
    }
    while (callQueue.length)
    {
        const name = callQueue.pop();
        if (called.has(name))
        {
            continue;
        }
        called.add(name);
        const definition = functionMap.get(name);
        if (!definition)
        {
            continue;
        }
        const operationFindings = analyzeRuntimeStateOperations(definition.body, `${definition.source}#${name}`, { conditionEnvironment });
        findings.push(...operationFindings);
        for (const finding of operationFindings)
        {
            access.add(finding.domain);
        }
        for (const candidate of discoverShellCallNames(definition.body, functionMap.keys()))
        {
            if (candidate !== name)
            {
                callQueue.push(candidate);
            }
        }
    }
    return {
        entrySources: [...new Set(entrySources)].sort(),
        sources: [...sources].sort(),
        calledFunctions: [...called].sort(),
        domains: [...access].sort(),
        findings,
        resolutionErrors: [...new Set(resolutionErrors)].sort()
    };
}

export function validateRuntimeStateDomainCatalog(catalogPath = path.join(root, 'config/testing/runtime-state-domain-catalog.json'), steps = runtimeSteps(), options = {})
{
    const errors = [];
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const schemaPath = path.join(root, 'config/schemas/runtime-state-domain-catalog.schema.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    errors.push(...validateSchemaValue(schema, schema, catalog));
    const registry = JSON.parse(fs.readFileSync(path.isAbsolute(catalog.registry) ? catalog.registry : path.join(root, catalog.registry), 'utf8'));
    const registrySchema = JSON.parse(fs.readFileSync(path.join(root, 'config/schemas/runtime-state-domain-registry.schema.json'), 'utf8'));
    errors.push(...validateSchemaValue(registrySchema, registrySchema, registry, '$registry'));
    if (catalog.schema !== 'fsusblog.runtime-state-domain-catalog.v1')
    {
        errors.push('invalid catalog schema');
    }
    if (registry.schema !== 'fsusblog.runtime-state-domain-registry.v1' || !sortedUnique(registry.domains))
    {
        errors.push('invalid registry');
    }
    const known = new Set(registry.domains);
    const observerBindings = registry.observerBindings ?? [];
    const observerDomains = observerBindings.map((binding) => binding?.domain);
    if (observerBindings.length !== registry.domains.length
    || new Set(observerDomains).size !== observerDomains.length
    || JSON.stringify([...observerDomains].sort()) !== JSON.stringify(registry.domains))
    {
        errors.push('runtime state-domain observer bindings must be exact in both directions');
    }
    const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
    const canonicalTestIds = new Set();
    const collectTestAuthorities = (value) =>
    {
        if (Array.isArray(value))
        {
            value.forEach(collectTestAuthorities);
        }
        else if (value && typeof value === 'object')
        {
            if (typeof value.id === 'string')
            {
                canonicalTestIds.add(value.id);
            }
            Object.values(value).forEach(collectTestAuthorities);
        }
    };
    collectTestAuthorities(matrix);
    const coverageRegistry = JSON.parse(fs.readFileSync(path.join(root, 'tests/coverage-registry.json'), 'utf8'));
    for (const entry of coverageRegistry.entries ?? [])
    {
        canonicalTestIds.add(entry.id);
        for (const tierId of entry.tierIds ?? [])
        {
            canonicalTestIds.add(tierId);
        }
    }
    const knownTestId = (testId) => canonicalTestIds.has(testId);
    const runtime = new Map(steps.map((step) => [step.id, step]));
    for (const step of steps)
    {
        canonicalTestIds.add(step.id);
        for (const testId of step.testIds ?? [])
        {
            canonicalTestIds.add(testId);
        }
    }
    const seen = new Set();
    for (const entry of catalog.steps ?? [])
    {
        if (!entry?.stepId || seen.has(entry.stepId))
        {
            errors.push(`duplicate or missing step id ${entry?.stepId ?? ''}`);
            continue;
        }
        seen.add(entry.stepId);
        const runtimeStep = runtime.get(entry.stepId);
        if (!runtimeStep)
        {
            errors.push(`extra catalog step ${entry.stepId}`);
            continue;
        }
        if (runtimeStep.resources?.coordinationOnly === true)
        {
            if (entry.stateAccess !== 'none')
            {
                errors.push(`coordination-only step ${entry.stepId} must be none`);
            }
            continue;
        }
        if (entry.stateAccess !== 'declared')
        {
            errors.push(`executable step ${entry.stepId} must be declared`);
            continue;
        }
        const analysis = analyzeRuntimeStepCommand(runtimeStep, options);
        for (const error of analysis.resolutionErrors)
        {
            errors.push(`${entry.stepId} source resolution failed: ${error}`);
        }
        if (analysis.sources.length === 0)
        {
            errors.push(`${entry.stepId} command has no repository source proof`);
        }
        const declared = new Set();
        for (const field of arrays)
        {
            if (!sortedUnique(entry[field]))
            {
                errors.push(`${entry.stepId}.${field} must be sorted and unique`);
            }
            for (const domain of entry[field] ?? [])
            {
                declared.add(domain);
                if (!known.has(domain))
                {
                    errors.push(`${entry.stepId} unknown domain ${domain}`);
                }
            }
        }
        for (const field of ['requiredPredecessors', 'postconditions'])
        {
            if (!sortedUnique(entry[field]))
            {
                errors.push(`${entry.stepId}.${field} must be sorted and unique`);
            }
        }
        for (const resetField of ['resetBefore', 'resetAfter'])
        {
            const resetKeys = (entry[resetField] ?? []).map((reset) => `${reset.producer}\0${reset.postcondition}`);
            if (new Set(resetKeys).size !== resetKeys.length)
            {
                errors.push(`${entry.stepId}.${resetField} must be unique`);
            }
        }
        const operationsByDomain = new Map();
        for (const field of operationArrays)
        {
            for (const domain of entry[field] ?? [])
            {
                const operations = operationsByDomain.get(domain) ?? [];
                operations.push(field);
                operationsByDomain.set(domain, operations);
            }
        }
        for (const [domain, operations] of operationsByDomain)
        {
            if (operations.length < 2)
            {
                continue;
            }
            const overlap = (entry.operationOverlaps ?? []).find((candidate) => candidate.domain === domain);
            if (!overlap || JSON.stringify([...overlap.operations].sort()) !== JSON.stringify([...operations].sort()))
            {
                errors.push(`${entry.stepId} has unexplained operation overlap for ${domain}`);
            }
        }
        if (!Array.isArray(entry.evidence))
        {
            errors.push(`${entry.stepId} requires evidence`);
        }
        for (const item of entry.evidence ?? [])
        {
            if (item.proofKind === 'static-analyzer')
            {
                if (!item.source || !item.ruleId || !analysis.findings.some((finding) => finding.operation === item.operation && finding.domain === item.domain && finding.source === item.source && finding.ruleId === item.ruleId))
                {
                    errors.push(`${entry.stepId} invalid static analyzer proof for ${item.operation} ${item.domain}`);
                }
            }
            else if (item.proofKind === 'structured-test')
            {
                const verifier = item.verifier && path.join(root, item.verifier);
                if (!knownTestId(item.assertionId) || !verifier || !fs.existsSync(verifier) || !fs.readFileSync(verifier, 'utf8').includes(`'${item.assertionId}'`))
                {
                    errors.push(`${entry.stepId} invalid structured assertion proof for ${item.operation} ${item.domain}`);
                }
            }
            else
            {
                errors.push(`${entry.stepId} invalid evidence proofKind`);
            }
        }
        for (const operation of operationArrays)
        {
            for (const domain of entry[operation] ?? [])
            {
                const proof = (entry.evidence ?? []).some((item) => (item.operation === operation && item.domain === domain) || (item.proofKind === 'structured-test' && item.operation === 'all' && item.domain === 'all-declared-access'));
                if (!proof)
                {
                    errors.push(`${entry.stepId} has no operation-specific proof for ${operation} ${domain}`);
                }
            }
        }
        for (const finding of analysis.findings)
        {
            if (!entry[finding.operation]?.includes(finding.domain))
            {
                const condition = finding.conditions ? ` conditional=${finding.conditionState} guards=${finding.conditions.map((guard) => guard.expression).join(' && ')}` : '';
                errors.push(`${entry.stepId} analyzer detected undeclared ${finding.operation} ${finding.domain} at ${finding.source}:${finding.line} rule=${finding.ruleId}${condition}`);
            }
        }
        for (const resetField of ['resetBefore', 'resetAfter'])
        {
            for (const reset of entry[resetField] ?? [])
            {
                const producer = (catalog.steps ?? []).find((candidate) => candidate.stepId === reset?.producer);
                if (!producer || !producer.postconditions?.includes(reset?.postcondition))
                {
                    errors.push(`${entry.stepId} invalid ${resetField} reference`);
                }
                const producerStep = runtime.get(reset?.producer);
                if (!producerStep || producerStep.command !== reset?.producerCommand)
                {
                    errors.push(`${entry.stepId} ${resetField} producer command mismatch`);
                }
                const verifier = typeof reset?.verifier === 'string' ? path.join(root, reset.verifier) : '';
                if (!verifier || !fs.existsSync(verifier))
                {
                    errors.push(`${entry.stepId} ${resetField} verifier is missing`);
                }
                else
                {
                    const verifierSource = fs.readFileSync(verifier, 'utf8');
                    if (!verifierSource.includes(`'${reset?.assertionId}'`) || !verifierSource.includes(`'${reset?.receiptSchema}'`))
                    {
                        errors.push(`${entry.stepId} ${resetField} verifier does not own assertion receipt`);
                    }
                }
            }
        }
        for (const proof of entry.commutativeWrites ?? [])
        {
            if (!entry.writes?.includes(proof?.domain) || !proof?.verifier || !knownTestId(proof.verifier))
            {
                errors.push(`${entry.stepId} commutative write needs verifier`);
            }
        }
        for (const overlap of entry.operationOverlaps ?? [])
        {
            if (!knownTestId(overlap.testId))
            {
                errors.push(`${entry.stepId} operation overlap has unknown test id ${overlap.testId}`);
            }
        }
        const reachable = new Set();
        const pending = [...(runtimeStep.dependsOn ?? [])];
        while (pending.length)
        {
            const predecessor = pending.pop();
            if (reachable.has(predecessor))
            {
                continue;
            }
            reachable.add(predecessor);
            pending.push(...(runtime.get(predecessor)?.dependsOn ?? []));
        }
        for (const predecessor of entry.requiredPredecessors ?? [])
        {
            if (!reachable.has(predecessor))
            {
                errors.push(`${entry.stepId} requiredPredecessor ${predecessor} is not in its runtime dependency ancestry`);
            }
        }
    }
    for (const step of steps)
    {
        if (!seen.has(step.id))
        {
            errors.push(`runtime step missing from catalog ${step.id}`);
        }
    }
    return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
{
    const errors = validateRuntimeStateDomainCatalog();
    if (errors.length)
    {
        errors.forEach((error) => console.error(`[runtime-state-domain] ${error}`));
        process.exitCode = 1;
    }
    else
    {
        console.log('[runtime-state-domain] ok');
    }
}
