import { maskCSharp } from '../architecture/backend-physical-topology/csharp-mask.mjs';

const canonicalNamespace = 'FsusBlog.Contracts.Schema';
const mappingAttributes = new Set(['SugarTable', 'SugarColumn', 'SugarIndex']);
const declarationKeywords = new Set(['class', 'struct', 'interface', 'enum', 'record']);

function tokens(source)
{
    const masked = maskCSharp(source).replace(/\\(?:u([a-fA-F0-9]{4})|U([a-fA-F0-9]{8}))/gu,
        (_, short, long) => String.fromCodePoint(Number.parseInt(short ?? long, 16))).replace(/\p{Cf}/gu, '');
    return [...masked.matchAll(/@?[\p{ID_Start}_][\p{ID_Continue}_]*|::|=>|[^\s]/gu)]
        .map(match => match[0].replace(/^@/u, ''));
}

function declaredTypes(values)
{
    return values.flatMap((value, index) =>
    {
        if (!declarationKeywords.has(value)) return [];
        const next = value === 'record' && ['class', 'struct'].includes(values[index + 1])
            ? values[index + 2] : values[index + 1];
        return next && /^[\p{ID_Start}_][\p{ID_Continue}_]*$/u.test(next) ? [next] : [];
    });
}

function typeParameterShadows(values, canonicalNames)
{
    const shadows = [];
    for (let index = 0; index < values.length; index++)
    {
        if (!declarationKeywords.has(values[index])) continue;
        let name = index + 1;
        if (values[index] === 'record' && ['class', 'struct'].includes(values[name])) name++;
        if (values[name + 1] !== '<') continue;
        for (const parameter of genericParameters(values, name + 1)?.names ?? [])
            if (canonicalNames.has(parameter)) shadows.push(parameter);
    }
    for (let index = 1; index < values.length; index++)
    {
        if (values[index] !== '<') continue;
        const parameters = genericParameters(values, index);
        if (!parameters || values[parameters.end + 1] !== '(') continue;
        const end = parameters.end;
        let start = index - 2;
        while (start >= 0 && ![';', '{', '}', '=', '=>'].includes(values[start])) start--;
        const prefix = values.slice(start + 1, index - 1);
        if (!declarationPrefix(prefix)) continue;
        let close = end + 1;
        let depth = 0;
        do
        {
            if (values[close] === '(') depth++;
            if (values[close] === ')') depth--;
            close++;
        } while (close < values.length && depth > 0);
        if (depth !== 0 || !['{', '=>', 'where', ';'].includes(values[close])) continue;
        for (const parameter of parameters.names)
            if (canonicalNames.has(parameter)) shadows.push(parameter);
    }
    return shadows;
}

function genericParameters(values, start)
{
    const names = [];
    let cursor = start + 1;
    while (cursor < values.length)
    {
        while (values[cursor] === '[')
        {
            let depth = 0;
            do
            {
                if (values[cursor] === '[') depth++;
                if (values[cursor] === ']') depth--;
                cursor++;
            } while (cursor < values.length && depth > 0);
            if (depth !== 0) return null;
        }
        if (['in', 'out'].includes(values[cursor])) cursor++;
        if (!/^[\p{ID_Start}_][\p{ID_Continue}_]*$/u.test(values[cursor] ?? '')) return null;
        names.push(values[cursor++]);
        if (values[cursor] === '>') return { names, end: cursor };
        if (values[cursor++] !== ',') return null;
    }
    return null;
}

function declarationPrefix(values)
{
    const identifier = value => typeof value === 'string' && /^[\p{ID_Start}_][\p{ID_Continue}_]*$/u.test(value);
    const modifiers = new Set(['public', 'private', 'protected', 'internal', 'static', 'abstract', 'virtual',
        'override', 'sealed', 'extern', 'unsafe', 'async', 'partial', 'new', 'readonly', 'ref', 'delegate']);
    let cursor = 0;
    while (values[cursor] === '[')
    {
        let depth = 0;
        do
        {
            if (values[cursor] === '[') depth++;
            if (values[cursor] === ']') depth--;
            cursor++;
        } while (cursor < values.length && depth > 0);
        if (depth !== 0) return false;
    }
    while (modifiers.has(values[cursor])) cursor++;
    if (values[cursor] === '(')
    {
        let depth = 0;
        let tuple = false;
        do
        {
            if (values[cursor] === '(') depth++;
            if (values[cursor] === ')') depth--;
            if (depth === 1 && values[cursor] === ',') tuple = true;
            cursor++;
        } while (cursor < values.length && depth > 0);
        if (depth !== 0 || !tuple) return false;
    }
    else
    {
        if (!identifier(values[cursor]) || ['return', 'await', 'throw'].includes(values[cursor])) return false;
        cursor++;
        while (['.', '::'].includes(values[cursor]) && identifier(values[cursor + 1])) cursor += 2;
    }
    if (values[cursor] === '<')
    {
        let depth = 0;
        do
        {
            if (values[cursor] === '<') depth++;
            if (values[cursor] === '>') depth--;
            cursor++;
        } while (cursor < values.length && depth > 0);
        if (depth !== 0) return false;
    }
    while (['?', '*', '[', ']', ','].includes(values[cursor])) cursor++;
    if (cursor === values.length) return true;
    // An explicit-interface method has a separate interface name after its return type.
    if (!identifier(values[cursor])) return false;
    cursor++;
    while (values[cursor] === '.' && identifier(values[cursor + 1])) cursor += 2;
    return cursor === values.length - 1 && values[cursor] === '.';
}

function delegateNames(values)
{
    const names = [];
    for (let index = 0; index < values.length; index++)
    {
        if (values[index] !== 'delegate' || ['*', '(', '{'].includes(values[index + 1])) continue;
        for (let name = index + 2; name < values.length && values[name] !== ';'; name++)
        {
            const parameters = values[name + 1] === '<' ? genericParameters(values, name + 1) : null;
            const next = parameters ? parameters.end + 1 : name + 1;
            if (values[next] !== '(' || !declarationPrefix(values.slice(index + 1, name))) continue;
            names.push(values[name]);
            break;
        }
    }
    return names;
}

function typeRanges(values)
{
    const ranges = [];
    for (let index = 0; index < values.length; index++)
    {
        if (!declarationKeywords.has(values[index])) continue;
        const name = values[index + (values[index] === 'record' && ['class', 'struct'].includes(values[index + 1]) ? 2 : 1)];
        let open = index + 2;
        while (open < values.length && !['{', ';'].includes(values[open])) open++;
        if (values[open] !== '{') continue;
        let close = open;
        let depth = 0;
        do
        {
            if (values[close] === '{') depth++;
            if (values[close] === '}') depth--;
            close++;
        } while (close < values.length && depth > 0);
        ranges.push({ name, declaration: index, open, close: close - 1 });
    }
    return ranges;
}

function aliases(values)
{
    const result = [];
    for (let index = 0; index < values.length; index++)
    {
        if (values[index] !== 'using' || values[index + 2] !== '=') continue;
        const end = values.indexOf(';', index + 3);
        if (end < 0) continue;
        result.push({ name: values[index + 1], target: values.slice(index + 3, end).join(''),
            global: values[index - 1] === 'global' });
    }
    return result;
}

function expandAlias(value, declared, seen = new Set())
{
    const normalized = value.replace(/^global::/u, '');
    const first = normalized.split(/[.:]/u)[0];
    if (!declared.has(first)) return normalized;
    if (seen.has(first)) return null;
    const next = new Set([...seen, first]);
    const target = expandAlias(declared.get(first), declared, next);
    return target === null ? null : target + normalized.slice(first.length);
}

function qualifiedName(values, index)
{
    let start = index;
    while (start >= 2 && ['.', '::'].includes(values[start - 1])
        && /^[\p{ID_Start}_][\p{ID_Continue}_]*$/u.test(values[start - 2])) start -= 2;
    return { name: values.slice(start, index + 1).join(''), start };
}

function isTypeUse(values, index, start)
{
    if (values[start - 1] === 'new') return true;
    if (values[start - 1] === '(' && ['typeof', 'default', 'sizeof'].includes(values[start - 2])) return true;
    let next = index + 1;
    while (['?', '[', ']', '*'].includes(values[next])) next++;
    return next < values.length && /^[\p{ID_Start}_][\p{ID_Continue}_]*$/u.test(values[next]);
}

function importsCanonical(values, globalOnly = false)
{
    return values.some((value, index) => value === 'using' && (!globalOnly || values[index - 1] === 'global')
        && values.slice(index + 1, index + 7).join('') === `${canonicalNamespace};`);
}

function attributeNames(values, index)
{
    const result = [];
    let start = index + 1;
    let depth = 0;
    for (let cursor = start; cursor < values.length; cursor++)
    {
        const value = values[cursor];
        if (depth === 0 && ['(', ',', ']'].includes(value))
        {
            if (start < cursor) result.push(values.slice(start, cursor).join('').replace(/^[A-Za-z]+:/u, ''));
            if (value === ']') break;
            if (value === ',') start = cursor + 1;
        }
        if (value === '(') depth++;
        if (value === ')') depth--;
        if (depth === 0 && value === ')')
        {
            while (cursor + 1 < values.length && ![',', ']'].includes(values[cursor + 1])) cursor++;
            start = cursor + 1;
        }
    }
    return result;
}

/** Checks source ownership, not compiled C# semantics or native schema qualification. */
export function migrationCurrentSchemaBoundaryFailures({ migrationSources, canonicalSources })
{
    const canonicalNames = new Set([...canonicalSources.values()].flatMap(source => declaredTypes(tokens(source))));
    const failures = [];
    if (!canonicalNames.has('SchemaTableModel') || !canonicalNames.has('CurrentSchemaCanonicalAuthority'))
    {
        return ['Shared current-schema declaration authority is missing'];
    }
    const documents = [...migrationSources].map(([path, source]) =>
        ({ path, source, tokens: tokens(source) }));
    const globalCanonicalImport = documents.some(document => importsCanonical(document.tokens, true));
    const globals = new Map();
    for (const document of documents)
    {
        for (const alias of aliases(document.tokens).filter(value => value.global))
        {
            if (globals.has(alias.name) && globals.get(alias.name) !== alias.target)
                failures.push(`${document.path}: conflicting global alias ${alias.name}`);
            globals.set(alias.name, alias.target);
        }
    }
    for (const document of documents)
    {
        const backfillRows = document.path === 'src/migration/Definitions/CommentRevisionMigrationRows.cs';
        const rowTypes = backfillRows ? typeRanges(document.tokens) : [];
        let rowTables = 0;
        const declared = new Map(globals);
        const documentAliases = aliases(document.tokens);
        for (const alias of documentAliases)
        {
            if (declared.has(alias.name) && declared.get(alias.name) !== alias.target)
                failures.push(`${document.path}: conflicting alias ${alias.name} cannot establish ownership`);
            declared.set(alias.name, alias.target);
        }
        const hasCanonicalImport = globalCanonicalImport || importsCanonical(document.tokens);
        const isCanonicalName = name => canonicalNames.has(name);
        for (const name of [...declaredTypes(document.tokens), ...delegateNames(document.tokens),
            ...typeParameterShadows(document.tokens, canonicalNames)])
        {
            const target = expandAlias(name, declared);
            if (isCanonicalName(name) || target?.startsWith(`${canonicalNamespace}.`)
                || target === canonicalNamespace)
                failures.push(`${document.path}: declares or shadows Shared current-schema type ${name}`);
        }
        for (const { name, target } of [...[...globals].map(([name, target]) => ({ name, target })), ...documentAliases])
        {
            const expanded = expandAlias(target, declared);
            if (isCanonicalName(name) && expanded !== `${canonicalNamespace}.${name}`)
                failures.push(`${document.path}: alias shadows Shared current-schema type ${name}`);
            if (expanded === null)
                failures.push(`${document.path}: cyclic alias cannot establish current-schema ownership`);
            const leaf = expanded?.split(/[.:]/u).at(-1);
            if (isCanonicalName(leaf) && expanded !== `${canonicalNamespace}.${leaf}`)
                failures.push(`${document.path}: alias targets a foreign current-schema type ${expanded}`);
        }
        for (let index = 0; index < document.tokens.length; index++)
        {
            const name = document.tokens[index];
            if (name === 'namespace')
            {
                let end = index + 1;
                while (end < document.tokens.length && ![';', '{'].includes(document.tokens[end])) end++;
                const namespace = document.tokens.slice(index + 1, end).join('');
                if (namespace === canonicalNamespace || namespace.startsWith(`${canonicalNamespace}.`))
                    failures.push(`${document.path}: declares the Shared current-schema namespace`);
            }
            if (isCanonicalName(name))
            {
                const qualified = qualifiedName(document.tokens, index);
                const typeContext = isTypeUse(document.tokens, index, qualified.start)
                    || declared.has(qualified.name.split(/[.:]/u)[0]);
                if (typeContext
                    && qualified.name !== name && expandAlias(qualified.name, declared) !== `${canonicalNamespace}.${name}`)
                    failures.push(`${document.path}: current-schema type ${qualified.name} has a foreign owner`);
                if (typeContext
                    && qualified.name === name && !hasCanonicalImport
                    && expandAlias(name, declared) !== `${canonicalNamespace}.${name}`)
                    failures.push(`${document.path}: current-schema type ${name} lacks its Shared owner binding`);
            }
            if (name !== '[') continue;
            for (const attribute of attributeNames(document.tokens, index))
            {
                const expanded = expandAlias(attribute, declared);
                const leaf = expanded?.split(/[.:]/u).at(-1)?.replace(/Attribute$/u, '');
                if (!mappingAttributes.has(leaf)) continue;
                let permitted = false;
                if (backfillRows)
                {
                    const enclosing = rowTypes.filter(type => type.open < index && index < type.close).at(-1);
                    const attached = rowTypes.find(type => type.declaration > index
                        && !document.tokens.slice(index + 1, type.declaration).some(value => ['{', ';'].includes(value)));
                    const owner = leaf === 'SugarTable' ? attached : enclosing;
                    if (leaf === 'SugarTable') rowTables++;
                    permitted = ['SugarTable', 'SugarColumn'].includes(leaf)
                        && ['Comment', 'CommentRevision'].includes(owner?.name)
                        && rowTypes.filter(type => type.name === owner.name).length === 1;
                }
                if (!permitted)
                    failures.push(`${document.path}: declares an ORM current-schema field mapping`);
            }
        }
        if (backfillRows && rowTables !== 2)
            failures.push(`${document.path}: ORM mappings exceed or omit the two backfill tables`);
    }
    return [...new Set(failures)];
}
