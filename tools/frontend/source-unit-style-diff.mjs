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
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', range: true, loc: true, tokens: true });
    const units = [];
    const statements = [];
    const regexLiterals = [];
    const bindings = new Map();
    const syntax = [];
    const parents = new Map();
    function visit(node, parent = null, role = null)
    {
        if (!node || typeof node !== 'object' || typeof node.type !== 'string')
        {
            return;
        }
        syntax.push(node);
        if (parent)
        {
            parents.set(node, { parent, role });
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
                value.forEach(child => visit(child, node, key));
            }
            else if (value && typeof value === 'object')
            {
                visit(value, node, key);
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
    const lines = source.split('\n');
    const lineStarts = [];
    let cursor = 0;
    for (const line of lines)
    {
        lineStarts.push(cursor);
        cursor += line.length + 1;
    }
    return { units: units.map((unit) => ({ ...unit, text: source.slice(unit.start, unit.end) })),
        statements, regexLiterals, bindings, ast, syntax, parents, lines, lineStarts,
        source, contexts: new Map(), layoutContexts: new Map(), rosters: new Map() };
}

function offset(parsed, line, column)
{
    if (!Number.isInteger(line) || !Number.isInteger(column) || line < 1 || column < 1)
    {
        return null;
    }
    const { lines, lineStarts } = parsed;
    if (line > lines.length || column > lines[line - 1].length + 1)
    {
        return null;
    }
    return lineStarts[line - 1] + column - 1;
}

function locate(source, parsed, finding)
{
    if (!inheritedRules.has(finding.rule) || finding.tool !== 'eslint' || finding.fatal
        || ![1, 2].includes(finding.severity))
    {
        return null;
    }
    const start = offset(parsed, finding.line, finding.column);
    const end = offset(parsed, finding.endLine, finding.endColumn);
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
        lines: parsed.lines.slice(finding.line - 1, finding.endLine).join('\n'),
        context: context ? `${context.type}:${context.text}` : null };
}

const layoutRules = new Set(['@stylistic/indent', '@stylistic/semi', 'curly']);
const functionTypes = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

function span(parsed, finding)
{
    if (finding.tool !== 'eslint' || finding.fatal || ![1, 2].includes(finding.severity))
    {
        return null;
    }
    const start = offset(parsed, finding.line, finding.column);
    const end = offset(parsed, finding.endLine, finding.endColumn);
    return start === null || end === null || end < start ? null : { start, end };
}

function declarationRoster(parsed, scope)
{
    if (parsed.rosters.has(scope))
    {
        return parsed.rosters.get(scope);
    }
    const declarations = [];
    function visit(node)
    {
        if (!node || typeof node !== 'object' || !node.type)
        {
            return;
        }
        if (node !== scope && functionTypes.has(node.type))
        {
            declarations.push([node.type, node.id?.name ?? null,
                parsed.source.slice(node.range[0], node.body.range[0])]);
            return;
        }
        if (node.type === 'VariableDeclarator')
        {
            declarations.push([parsed.parents.get(node)?.parent.kind,
                parsed.source.slice(...node.id.range)]);
        }
        if (node.type === 'ClassDeclaration')
        {
            declarations.push([node.type, node.id?.name ?? null]);
            return;
        }
        if (node.type === 'ImportDeclaration')
        {
            declarations.push([node.type, parsed.source.slice(...node.range)]);
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
    visit(scope);
    parsed.rosters.set(scope, declarations);
    return declarations;
}

function syntaxIdentity(node, omitted = null)
{
    return JSON.stringify(node, (key, value) =>
    {
        if (['range', 'loc', 'start', 'end', 'tokens', 'comments'].includes(key))
        {
            return undefined;
        }
        if (value === omitted && omitted !== null)
        {
            return { sourceLayoutChild: true };
        }
        return typeof value === 'bigint' ? { sourceBigInt: value.toString() } : value;
    });
}

function syntaxContext(parsed, node, layout = false)
{
    const cache = layout ? parsed.layoutContexts : parsed.contexts;
    if (cache.has(node))
    {
        return cache.get(node);
    }
    const frames = [];
    let child = node;
    for (let link = parsed.parents.get(child); link; link = parsed.parents.get(child))
    {
        const { parent, role } = link;
        const frame = { type: parent.type, role };
        if (parent.type === 'Program')
        {
            frame.bindings = declarationRoster(parsed, parent);
        }
        else if (parent.type === 'BlockStatement')
        {
            frame.braces = [parsed.source.slice(parent.range[0], parent.range[0] + 1),
                parsed.source.slice(parent.range[1] - 1, parent.range[1])];
            frame.bindings = declarationRoster(parsed, parent);
        }
        else if (layout && parent.type === 'TryStatement')
        {
            // Preserve every other branch's syntax, bindings and literal raw
            // values. Whitespace and optional semicolons have no AST identity.
            frame.syntax = syntaxIdentity(parent, child);
        }
        else if (functionTypes.has(parent.type) || parent.type === 'CatchClause'
            || ['IfStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement',
                'WhileStatement', 'DoWhileStatement', 'WithStatement'].includes(parent.type))
        {
            const body = parent.body ?? parent.consequent;
            frame.header = parsed.source.slice(parent.range[0], body.range[0]);
            frame.tail = parent.type === 'DoWhileStatement' ? parsed.source.slice(body.range[1], parent.range[1]) : null;
            frame.alternate = Boolean(parent.alternate);
        }
        else
        {
            // Non-body ancestors retain every sibling expression and all boundary
            // trivia. A changed call argument, object key or lexical owner refuses.
            frame.prefix = parsed.source.slice(parent.range[0], child.range[0]);
            frame.suffix = parsed.source.slice(child.range[1], parent.range[1]);
        }
        frames.push(frame);
        child = parent;
    }
    const result = crypto.createHash('sha256').update(JSON.stringify(frames)).digest('hex');
    cache.set(node, result);
    return result;
}

function layoutLocation(parsed, finding)
{
    const position = span(parsed, finding);
    if (!position || !layoutRules.has(finding.rule))
    {
        return null;
    }
    const { source, ast } = parsed;
    const tokens = ast.tokens;
    const token = tokens.find(value => value.range[1] > position.start && value.range[0] < position.end)
        ?? tokens.find(value => value.range[0] >= position.start);
    if (!token)
    {
        return null;
    }
    // Indent spans whitespace; missing-semicolon spans the line terminator.
    // Bind those spans to their actual adjacent syntax rather than pretending
    // that whitespace is contained by an AST statement.
    const anchor = finding.rule === '@stylistic/semi'
        ? [...tokens].reverse().find(value => value.range[1] <= position.start) : token;
    if (!anchor)
    {
        return null;
    }
    const eligible = parsed.syntax.filter(node => node.type !== 'Program'
        && (node.type.endsWith('Statement') || ['VariableDeclaration', 'ImportDeclaration', 'Property',
            'VariableDeclarator', 'MethodDefinition'].includes(node.type)
            || (finding.rule === '@stylistic/indent' && node.type === 'CatchClause'))
        && node.range[0] <= anchor.range[0] && node.range[1] >= anchor.range[1]);
    let owner = eligible.sort((a, b) => a.range[1] - a.range[0] - (b.range[1] - b.range[0]))[0];
    if (!owner)
    {
        return null;
    }
    let moduleStatement = owner;
    let insideFunction = false;
    for (let link = parsed.parents.get(moduleStatement); link && link.parent.type !== 'Program';
        link = parsed.parents.get(moduleStatement))
    {
        insideFunction ||= functionTypes.has(link.parent.type);
        moduleStatement = link.parent;
    }
    let moduleContext = null;
    if (!insideFunction)
    {
        const declaration = moduleStatement.type === 'ExportNamedDeclaration'
            ? moduleStatement.declaration : moduleStatement;
        if (!['@stylistic/indent', '@stylistic/semi'].includes(finding.rule)
            || !['ImportDeclaration', 'VariableDeclaration'].includes(declaration?.type)
            || !ast.body.includes(moduleStatement))
        {
            return null;
        }
        // Global layout has its own finite declaration port. Retain the whole
        // declaration/export wrapper, both neighbouring statements and every
        // physical byte between them so that ASI and scope moves stay strict.
        owner = moduleStatement;
        const ordinal = ast.body.indexOf(owner);
        const previousStatement = ast.body[ordinal - 1];
        const nextStatement = ast.body[ordinal + 1];
        function adjacentStatement(statement)
        {
            if (!statement)
            {
                return null;
            }
            const functionDeclaration = statement.type === 'ExportNamedDeclaration'
                ? statement.declaration : statement;
            if (functionDeclaration?.type === 'FunctionDeclaration')
            {
                return [statement.type, functionDeclaration.type,
                    source.slice(statement.range[0], functionDeclaration.body.range[0]),
                    source.slice(functionDeclaration.range[1], statement.range[1]),
                    ['{', '}'], declarationRoster(parsed, functionDeclaration.body)];
            }
            return [statement.type, syntaxIdentity(statement)];
        }
        moduleContext = [adjacentStatement(previousStatement),
            source.slice(previousStatement?.range[1] ?? 0, owner.range[0]),
            adjacentStatement(nextStatement),
            source.slice(owner.range[1], nextStatement?.range[0] ?? source.length)];
        if (ast.body.filter(node => node.type === owner.type
            && source.slice(...node.range) === source.slice(...owner.range)).length !== 1)
        {
            return null;
        }
    }
    let text = syntaxIdentity(owner);
    if (owner.type === 'BlockStatement')
    {
        if (finding.rule !== '@stylistic/indent' || !['{', '}'].includes(anchor.value))
        {
            return null;
        }
        // A brace-only indentation proof retains the original owner's header,
        // lexical roster and syntax role. No semantic finding uses this path.
        text = anchor.value;
    }
    if (parsed.syntax.filter(node => node.type === owner.type
        && (owner.type === 'BlockStatement' || syntaxIdentity(node) === text)
        && syntaxContext(parsed, node, true) === syntaxContext(parsed, owner, true)).length !== 1)
    {
        return null;
    }
    // A parsed complete statement retains its ASI identity with or without a
    // semicolon. Other neighbouring syntax tokens remain byte-exact.
    const neighbours = tokens.filter(value => (value.value !== ';'
        || parsed.syntax.some(node => node.type === 'EmptyStatement'
            && node.range[0] === value.range[0] && node.range[1] === value.range[1])
        || !parsed.syntax.some(node =>
            node.type !== 'EmptyStatement'
        && (node.type.endsWith('Statement') || ['VariableDeclaration', 'ImportDeclaration'].includes(node.type))
        && node.range[1] === value.range[1]))
        && (value.range[1] <= owner.range[0] || value.range[0] >= owner.range[1]));
    const previous = neighbours.filter(value => value.range[1] <= owner.range[0]).at(-1);
    const next = neighbours.find(value => value.range[0] >= owner.range[1]);
    const relativeAnchor = owner.type === 'BlockStatement' ? anchor.range[0] : owner.range[0];
    return { kind: moduleContext ? 'module-declaration-layout' : 'layout', unitType: owner.type, text,
        context: moduleContext ? crypto.createHash('sha256')
            .update(JSON.stringify([syntaxContext(parsed, owner, true), moduleContext])).digest('hex') : syntaxContext(parsed, owner, true),
        lines: parsed.lines.slice(finding.line - 1,
            finding.endLine - (finding.endLine > finding.line && finding.endColumn === 1 ? 1 : 0)).join('\n'),
        diagnosticSpan: source.slice(position.start, position.end),
        start: position.start - relativeAnchor, end: position.end - relativeAnchor,
        neighbours: [previous ? source.slice(...previous.range) : null, next ? source.slice(...next.range) : null] };
}

function unusedLocation(parsed, finding)
{
    const position = span(parsed, finding);
    if (!position || finding.rule !== 'no-unused-vars')
    {
        return null;
    }
    parsed.scopeManager ??= toolchainRequire('eslint-scope').analyze(parsed.ast,
        { ecmaVersion: 2024, sourceType: 'module', ignoreEval: false });
    const variables = parsed.scopeManager.scopes.flatMap(scope => scope.variables.map(variable => ({ scope, variable })))
        .filter(({ variable }) => variable.identifiers.some(id => id.range[0] === position.start && id.range[1] === position.end));
    if (variables.length !== 1)
    {
        return null;
    }
    const { scope, variable } = variables[0];
    // Writes from the exact initializer are recorded by eslint-scope. Reads,
    // multiple definitions, direct eval and dynamic scopes remain strict.
    if (scope.type !== 'function' || variable.defs.length !== 1
        || variable.references.some(reference => reference.isRead() || !reference.init)
        || parsed.syntax.some(node => node.type === 'WithStatement'
            || (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'eval')))
    {
        return null;
    }
    const definition = variable.defs[0];
    const node = definition.type === 'Parameter' ? definition.name : definition.node;
    return { kind: 'unused-binding', unitType: definition.type, text: parsed.source.slice(...node.range),
        context: syntaxContext(parsed, node), lines: parsed.lines.slice(finding.line - 1, finding.endLine).join('\n'),
        start: position.start - node.range[0], end: position.end - node.range[0],
        references: variable.references.map(reference => ({ init: reference.init, read: reference.isRead(),
            write: reference.isWrite(), text: parsed.source.slice(...reference.identifier.range) })) };
}

function proofKey(finding, proof)
{
    return JSON.stringify([finding.tool, finding.rule, finding.message, finding.severity, proof]);
}

function importsLocation(parsed, finding, witness)
{
    const position = span(parsed, finding);
    if (!position || !['import-x/order', 'import-x/no-relative-parent-imports'].includes(finding.rule) || !witness)
    {
        return null;
    }
    const imports = parsed.ast.body.filter(node => node.type === 'ImportDeclaration');
    const target = imports.filter(node => node.range[0] <= position.start && node.range[1] >= position.end);
    if (target.length !== 1 || !imports.length || typeof witness.sourcePath !== 'string'
        || !Array.isArray(witness.dependencies) || !Array.isArray(witness.configurationIdentities)
        || !witness.configurationIdentities.length)
    {
        return null;
    }
    const rows = witness.dependencies;
    if (imports.some(node => rows.filter(row => row.owner === witness.sourcePath
        && row.specifier === node.source.value).length !== 1)
        || rows.some(row => typeof row.owner !== 'string' || typeof row.specifier !== 'string'
            || !['repository', 'builtin'].includes(row.kind)
            || (row.kind === 'repository' && (typeof row.path !== 'string'
                || !/^[a-f0-9]{40}$/u.test(row.blob) || !/^[a-f0-9]{64}$/u.test(row.sha256)))
            || (row.kind === 'builtin' && (!row.specifier.startsWith('node:') || typeof row.nodeVersion !== 'string')))
        || witness.configurationIdentities.some(row => typeof row.file !== 'string' || !/^[a-f0-9]{64}$/u.test(row.sha256)))
    {
        return null;
    }
    const first = imports[0].range[0];
    const last = imports.at(-1).range[1];
    if (parsed.ast.body.some(node => node.type !== 'ImportDeclaration' && node.range[0] >= first && node.range[1] <= last))
    {
        return null;
    }
    return { kind: 'import-roster', unitType: 'ImportDeclaration', text: parsed.source.slice(first, last),
        start: position.start - first, end: position.end - first,
        lines: parsed.lines.slice(finding.line - 1, finding.endLine).join('\n'), witness };
}

// Only the declared source-local rules can inherit findings. All other rules stay strict.
export function compareSourceUnitFindings({ baseSource, candidateSource, baseFindings, candidateFindings, importContext = null })
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
    // Every parse, line table, located finding and index belongs to this call.
    // Neither a previous candidate nor a mutated findings array can reuse it.
    function unitCounts(parsed)
    {
        const counts = new Map();
        for (const unit of parsed.units)
        {
            unit.key = JSON.stringify([unit.type, unit.text]);
            counts.set(unit.key, (counts.get(unit.key) ?? 0) + 1);
        }
        return counts;
    }
    const baseCounts = unitCounts(base);
    const candidateCounts = unitCounts(candidate);
    function proofs(parsed, source, finding, witness)
    {
        const result = [];
        const location = locate(source, parsed, finding);
        if (location && baseCounts.get(location.unit.key) === 1 && candidateCounts.get(location.unit.key) === 1)
        {
            result.push({ kind: 'whole-function', unitType: location.unit.type,
                text: crypto.createHash('sha256').update(location.unit.text).digest('hex'),
                start: location.start, end: location.end,
                lines: contextRules.has(finding.rule) ? location.lines : null,
                context: contextRules.has(finding.rule) ? location.context : null,
                // Literal regex proofs also bind the original module declarations.
                // RegExp constructors still have no source inheritance proof.
                bindings: finding.rule === 'no-control-regex'
                    ? location.unit.identifiers.map(name => [name, parsed.bindings.get(name) ?? []]) : null });
        }
        for (const resolve of [layoutLocation, unusedLocation])
        {
            const proof = resolve(parsed, finding);
            if (proof)
            {
                result.push(proof);
            }
        }
        const imports = importsLocation(parsed, finding, witness);
        if (imports)
        {
            result.push(imports);
        }
        return result;
    }
    const index = new Map();
    try
    {
        if (baseSource !== null)
        {
            baseFindings.forEach((finding, ordinal) =>
            {
                for (const proof of proofs(base, baseSource, finding, importContext?.base))
                {
                    const key = proofKey(finding, proof);
                    const bucket = index.get(key) ?? new Map();
                    bucket.set(ordinal, { finding, proof });
                    index.set(key, bucket);
                }
            });
        }
    }
    catch (error)
    {
        return { existing, unexpected: candidateFindings, failure: `source proof failed: ${error.message}` };
    }
    const consumed = new Set();
    for (const finding of candidateFindings)
    {
        const matches = new Map();
        let available;
        try
        {
            available = proofs(candidate, candidateSource, finding, importContext?.candidate);
        }
        catch (error)
        {
            return { existing: [], unexpected: candidateFindings, failure: `source proof failed: ${error.message}` };
        }
        for (const proof of available)
        {
            for (const [ordinal, prior] of index.get(proofKey(finding, proof)) ?? [])
            {
                if (!consumed.has(ordinal))
                {
                    matches.set(ordinal, prior);
                }
            }
        }
        if (matches.size !== 1)
        {
            unexpected.push(finding);
            continue;
        }
        const [ordinal, { finding: prior, proof }] = [...matches][0];
        consumed.add(ordinal);
        existing.push({ finding, baseFinding: prior, proofKind: proof.kind,
            unitType: proof.unitType,
            unitSha256: proof.kind === 'whole-function' ? proof.text : crypto.createHash('sha256').update(proof.text).digest('hex'),
            relativeStart: proof.start, relativeEnd: proof.end,
            lineContextSha256: proof.lines ? crypto.createHash('sha256').update(proof.lines).digest('hex') : null,
            statementContextSha256: proof.context ? crypto.createHash('sha256').update(proof.context).digest('hex') : null });
    }
    return { existing, unexpected, failure: null };
}
