import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const toolchainRequire = createRequire(new URL('./style-toolchain/package.json', import.meta.url));
const inheritedRules = new Set([
    '@stylistic/indent',
    '@stylistic/brace-style',
    '@stylistic/max-statements-per-line',
    'no-control-regex',
    'no-useless-assignment',
    'no-useless-escape',
    'preserve-caught-error'
]);

const contextRules = new Set(['@stylistic/brace-style', '@stylistic/max-statements-per-line', 'no-control-regex']);

function identifiers(node)
{
    const names = new Set();
    function visit(value)
    {
        if (!value || typeof value !== 'object')
        {
            return;
        }
        if (value.type === 'Identifier')
        {
            names.add(value.name);
        }
        for (const [key, child] of Object.entries(value))
        {
            if (['range', 'loc'].includes(key))
            {
                continue;
            }
            if (Array.isArray(child))
            {
                child.forEach(visit);
            }
            else if (child && typeof child === 'object')
            {
                visit(child);
            }
        }
    }
    visit(node);
    return [...names];
}

function sourceUnits(source)
{
    const { parse } = toolchainRequire('espree');
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', range: true, loc: true });
    const units = [];
    const statements = [];
    const regexLiterals = [];
    const bindings = new Map();
    function visit(node)
    {
        if (!node || typeof node !== 'object' || typeof node.type !== 'string')
        {
            return;
        }
        if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type))
        {
            units.push({ type: node.type, start: node.range[0], end: node.range[1], identifiers: identifiers(node) });
        }
        if ((node.type.endsWith('Statement') && node.type !== 'BlockStatement') || node.type === 'VariableDeclaration')
        {
            statements.push({ type: node.type, start: node.range[0], end: node.range[1], text: source.slice(...node.range) });
        }
        if (node.type === 'Literal' && node.regex)
        {
            regexLiterals.push({ start: node.range[0], end: node.range[1] });
        }
        for (const [key, value] of Object.entries(node))
        {
            if (['range', 'loc', 'tokens', 'comments'].includes(key))
            {
                continue;
            }
            if (Array.isArray(value))
            {
                value.forEach(visit);
            }
            else if (value && typeof value === 'object')
            {
                visit(value);
            }
        }
    }
    visit(ast);
    for (const statement of ast.body)
    {
        const node = statement.declaration ?? statement;
        const names = node.type === 'ImportDeclaration'
            ? node.specifiers.map((specifier) => specifier.local.name)
            : node.type === 'VariableDeclaration'
                ? node.declarations.flatMap((declaration) => identifiers(declaration.id))
                : node.id?.name ? [node.id.name]
                    : node.type === 'ExpressionStatement' && node.expression.type === 'AssignmentExpression'
                        ? identifiers(node.expression.left) : [];
        for (const name of names)
        {
            bindings.set(name, [...(bindings.get(name) ?? []), source.slice(...statement.range)]);
        }
    }
    return { units: units.map((unit) => ({ ...unit, text: source.slice(unit.start, unit.end) })),
        statements, regexLiterals, bindings };
}

function offset(source, line, column)
{
    if (!Number.isInteger(line) || !Number.isInteger(column) || line < 1 || column < 1)
    {
        return null;
    }
    const lines = source.split('\n');
    if (line > lines.length || column > lines[line - 1].length + 1)
    {
        return null;
    }
    return lines.slice(0, line - 1).reduce((sum, value) => sum + value.length + 1, 0) + column - 1;
}

function locate(source, parsed, finding)
{
    if (!inheritedRules.has(finding.rule) || finding.tool !== 'eslint' || finding.fatal
        || ![1, 2].includes(finding.severity))
    {
        return null;
    }
    const start = offset(source, finding.line, finding.column);
    const end = offset(source, finding.endLine, finding.endColumn);
    if (start === null || end === null || end < start)
    {
        return null;
    }
    const containing = parsed.units.filter((unit) => unit.start <= start && unit.end >= end);
    const unit = containing.sort((left, right) => left.end - left.start - (right.end - right.start))[0];
    if (!unit)
    {
        return null;
    }
    const enclosing = parsed.statements.filter((statement) => statement.start <= unit.start && statement.end >= unit.end);
    const contexts = enclosing.length > 0 ? enclosing
        : parsed.statements.filter((statement) => statement.start <= start && statement.end >= end);
    const context = contexts.sort((left, right) => left.end - left.start - (right.end - right.start))[0];
    const staticRegex = parsed.regexLiterals.some((literal) => literal.start <= start && literal.end >= end);
    if (contextRules.has(finding.rule) && (!context || (finding.rule === 'no-control-regex' && !staticRegex)))
    {
        return null;
    }
    return { unit, start: start - unit.start, end: end - unit.start,
        lines: source.split('\n').slice(finding.line - 1, finding.endLine).join('\n'),
        context: context ? `${context.type}:${context.text}` : null };
}

function matchingContext(base, candidate, current, prior, rule)
{
    if (!contextRules.has(rule))
    {
        return true;
    }
    if (current.lines !== prior.lines || current.context !== prior.context)
    {
        return false;
    }
    // A literal regex can never inherit a finding through a changed module binding.
    // Constructors (even strings) remain strict; proving RegExp identity is a separate scope.
    return rule !== 'no-control-regex' || current.unit.identifiers.every((name) =>
        JSON.stringify(base.bindings.get(name) ?? []) === JSON.stringify(candidate.bindings.get(name) ?? []));
}

// Only the declared source-local rules can inherit findings. All other rules stay strict.
export function compareSourceUnitFindings({ baseSource, candidateSource, baseFindings, candidateFindings })
{
    const existing = [];
    const unexpected = [];
    let base;
    let candidate;
    try
    {
        base = baseSource === null ? { units: [], statements: [], regexLiterals: [], bindings: new Map() } : sourceUnits(baseSource);
        candidate = sourceUnits(candidateSource);
    }
    catch (error)
    {
        return { existing, unexpected: candidateFindings, failure: `source unit parse failed: ${error.message}` };
    }
    const consumed = new Set();
    for (const finding of candidateFindings)
    {
        const current = locate(candidateSource, candidate, finding);
        const sameUnit = (unit) => current && unit.type === current.unit.type && unit.text === current.unit.text;
        if (!current || base.units.filter(sameUnit).length !== 1 || candidate.units.filter(sameUnit).length !== 1)
        {
            unexpected.push(finding);
            continue;
        }
        const matches = baseFindings.map((prior, index) => ({ prior, index, location: locate(baseSource, base, prior) }))
            .filter(({ prior, index, location }) => !consumed.has(index) && location
                && sameUnit(location.unit) && location.start === current.start && location.end === current.end
                && prior.rule === finding.rule && prior.message === finding.message && prior.severity === finding.severity
                && matchingContext(base, candidate, current, location, finding.rule));
        if (matches.length !== 1)
        {
            unexpected.push(finding);
            continue;
        }
        consumed.add(matches[0].index);
        existing.push({ finding, baseFinding: matches[0].prior,
            unitType: current.unit.type,
            unitSha256: crypto.createHash('sha256').update(current.unit.text).digest('hex'),
            relativeStart: current.start, relativeEnd: current.end,
            lineContextSha256: contextRules.has(finding.rule) ? crypto.createHash('sha256').update(current.lines).digest('hex') : null,
            statementContextSha256: contextRules.has(finding.rule) ? crypto.createHash('sha256').update(current.context).digest('hex') : null });
    }
    return { existing, unexpected, failure: null };
}
