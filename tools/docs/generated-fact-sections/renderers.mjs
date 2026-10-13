/**
 * Unique typed RendererRegistry for FactObservation → Markdown sections.
 * Renderers only format; they know neither business source paths nor extractors/tests.
 */

import {
    GeneratedSectionErrorCode,
    makeGeneratedSectionError
} from './markers.mjs';

export const allowedRenderers = Object.freeze([
    'scalar',
    'boolean',
    'enum-set',
    'ordered-set',
    'key-value-table',
    'transition-table',
    'failure-mode-table',
    'route-table',
    'dependency-graph-table'
]);

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Fixed locale/Unicode policy for deterministic bytes. */
export function normalizeScalarText(value)
{
    return String(value).normalize('NFC');
}

export function compareOrdinal(left, right)
{
    const leftText = normalizeScalarText(left);
    const rightText = normalizeScalarText(right);
    if (leftText < rightText)
    {
        return -1;
    }
    if (leftText > rightText)
    {
        return 1;
    }
    return 0;
}

function failShape(renderer, message, details = {})
{
    throw makeGeneratedSectionError(
        GeneratedSectionErrorCode.RENDERER_SHAPE,
        `${renderer}: ${message}`,
        { renderer, ...details }
    );
}

function applyEmptyPolicy(renderer, emptyPolicy, emptyMarkdown)
{
    if (emptyPolicy === 'render-empty')
    {
        return emptyMarkdown;
    }
    throw makeGeneratedSectionError(
        GeneratedSectionErrorCode.EMPTY_POLICY,
        `${renderer}: empty observation rejected by emptyPolicy=fail`,
        { renderer, emptyPolicy }
    );
}

function isEmptyValue(value)
{
    if (value === null || value === undefined)
    {
        return true;
    }
    if (Array.isArray(value))
    {
        return value.length === 0;
    }
    if (isPlainObject(value))
    {
        if (Object.keys(value).length === 0)
        {
            return true;
        }
        // FactObservationReceipt canonicalizes an observed empty array as
        // {count:0}; treat only that exact shape as empty, never a general map.
        return Object.keys(value).length === 1 && value.count === 0;
    }
    if (typeof value === 'string')
    {
        return value.length === 0;
    }
    return false;
}

function formatDurationLike(value, unitHint)
{
    if (isPlainObject(value) && Object.hasOwn(value, 'value'))
    {
        const unit = value.unit ?? unitHint;
        if (unit == null || unit === '')
        {
            failShape('scalar', 'typed duration/quantity requires explicit unit');
        }
        return `${normalizeScalarText(value.value)} ${normalizeScalarText(unit)}`;
    }
    if (unitHint)
    {
        return `${normalizeScalarText(value)} ${normalizeScalarText(unitHint)}`;
    }
    return normalizeScalarText(value);
}

function escapeTableCell(value)
{
    return normalizeScalarText(value).replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ');
}

function serializeLiteralJson(value)
{
    // Compound observations are JSON text; scalar strings retain their Markdown contract.
    // Entities preserve literal punctuation without activating HTML, links, or escapes.
    // Escape URL scheme colons after ampersands to preserve their decoded JSON text.
    return normalizeScalarText(JSON.stringify(value)).replace(/[&<>\\`*_[\]~]/gu,
        (character) => `&#${character.codePointAt(0)};`)
        .replace(/(https?):\/\//giu, '$1&#58;//');
}

function markdownTable(headers, rows)
{
    const headerLine = `| ${headers.map(escapeTableCell).join(' | ')} |`;
    const separator = `| ${headers.map(() => '---').join(' | ')} |`;
    const body = rows.map((row) => `| ${row.map(escapeTableCell).join(' | ')} |`);
    return [headerLine, separator, ...body].join('\n');
}

function renderScalar(value, options = {})
{
    if (isEmptyValue(value))
    {
        return applyEmptyPolicy('scalar', options.emptyPolicy, '_empty_');
    }
    if (typeof value === 'boolean' || Array.isArray(value))
    {
        failShape('scalar', 'scalar renderer rejects boolean/array; use boolean/set renderers');
    }
    if (isPlainObject(value) && !Object.hasOwn(value, 'value'))
    {
        failShape('scalar', 'scalar object must be {value, unit?}');
    }
    return formatDurationLike(value, options.unit);
}

function renderBoolean(value, options = {})
{
    if (value === null || value === undefined)
    {
        return applyEmptyPolicy('boolean', options.emptyPolicy, '_empty_');
    }
    if (typeof value !== 'boolean')
    {
        failShape('boolean', `expected boolean, got ${typeof value}`);
    }
    return value ? 'true' : 'false';
}

function asScalarList(value, renderer)
{
    if (!Array.isArray(value))
    {
        failShape(renderer, 'expected array of scalars');
    }
    for (const entry of value)
    {
        if (typeof entry !== 'string' && typeof entry !== 'number' && typeof entry !== 'boolean')
        {
            failShape(renderer, 'set members must be scalar/boolean');
        }
    }
    return value.map((entry) => normalizeScalarText(entry));
}

function renderEnumSet(value, options = {})
{
    if (isEmptyValue(value))
    {
        return applyEmptyPolicy('enum-set', options.emptyPolicy, '_empty set_');
    }
    const items = asScalarList(value, 'enum-set');
    // Unordered sets always sort by ordinal regardless of observation/FS order.
    const sorted = [...items].sort(compareOrdinal);
    return sorted.map((item) => `- \`${item}\``).join('\n');
}

function renderOrderedSet(value, options = {})
{
    if (isEmptyValue(value))
    {
        return applyEmptyPolicy('ordered-set', options.emptyPolicy, '_empty set_');
    }
    const items = asScalarList(value, 'ordered-set');
    // Preserve observation order exactly.
    return items.map((item) => `- \`${item}\``).join('\n');
}

function renderKeyValueTable(value, options = {})
{
    if (isEmptyValue(value))
    {
        return applyEmptyPolicy('key-value-table', options.emptyPolicy, '_empty map_');
    }

    let pairs;
    if (Array.isArray(value))
    {
        pairs = value.map((entry, index) =>
        {
            if (!isPlainObject(entry) || !Object.hasOwn(entry, 'key') || !Object.hasOwn(entry, 'value'))
            {
                failShape('key-value-table', `row ${index} must be {key,value}`);
            }
            return [entry.key, entry.value];
        });
    }
    else if (isPlainObject(value))
    {
        pairs = Object.entries(value);
    }
    else
    {
        failShape('key-value-table', 'expected map object or [{key,value}]');
    }

    if (options.orderPolicy === 'ordinal' || options.orderPolicy == null)
    {
        pairs = [...pairs].sort((left, right) => compareOrdinal(left[0], right[0]));
    }

    const rows = pairs.map(([key, entryValue]) =>
    {
        const rendered = isPlainObject(entryValue)
            && Object.hasOwn(entryValue, 'value')
            && (Object.hasOwn(entryValue, 'unit') || options.unit)
            ? formatDurationLike(entryValue, options.unit)
            : normalizeScalarText(typeof entryValue === 'string' || typeof entryValue === 'number' || typeof entryValue === 'boolean'
                ? entryValue
                : serializeLiteralJson(entryValue));
        return [key, rendered];
    });
    return markdownTable(['Key', 'Value'], rows);
}

function parseTransition(entry)
{
    if (isPlainObject(entry))
    {
        const from = entry.from ?? entry.source;
        const to = entry.to ?? entry.target;
        const guard = entry.guard ?? entry.guardId ?? entry.semanticId ?? '';
        if (from == null || to == null)
        {
            failShape('transition-table', 'transition object requires from/to');
        }
        return {
            from: normalizeScalarText(from),
            to: normalizeScalarText(to),
            guard: normalizeScalarText(guard)
        };
    }
    if (typeof entry !== 'string')
    {
        failShape('transition-table', 'transition must be string or object');
    }
    // Supports "Action:From->To" and "From->To[:guard]" forms.
    const withAction = entry.match(/^(?:([^:]+):)?([^:>-]+)->([^:]+)(?::(.+))?$/u);
    if (!withAction)
    {
        failShape('transition-table', `unparseable transition ${entry}`);
    }
    const action = withAction[1] ? normalizeScalarText(withAction[1]) : '';
    const from = normalizeScalarText(withAction[2]);
    const to = normalizeScalarText(withAction[3]);
    const guard = withAction[4] ? normalizeScalarText(withAction[4]) : action;
    return { from, to, guard };
}

function renderTransitionTable(value, options = {})
{
    if (isEmptyValue(value))
    {
        return applyEmptyPolicy('transition-table', options.emptyPolicy, '_empty transitions_');
    }
    if (!Array.isArray(value))
    {
        failShape('transition-table', 'expected transition array');
    }
    let rows = value.map(parseTransition);
    if (options.orderPolicy === 'ordinal' || options.orderPolicy == null)
    {
        rows = [...rows].sort((left, right) =>
            compareOrdinal(left.from, right.from)
            || compareOrdinal(left.to, right.to)
            || compareOrdinal(left.guard, right.guard));
    }
    return markdownTable(
        ['From', 'To', 'Guard'],
        rows.map((row) => [row.from, row.to, row.guard === '' ? '-' : row.guard])
    );
}

function renderFailureModeTable(value, options = {})
{
    if (isEmptyValue(value))
    {
        return applyEmptyPolicy('failure-mode-table', options.emptyPolicy, '_empty failure modes_');
    }

    let rows;
    if (Array.isArray(value))
    {
        rows = value.map((entry, index) =>
        {
            if (typeof entry === 'string')
            {
                return { id: normalizeScalarText(entry), description: '-' };
            }
            if (!isPlainObject(entry) || entry.id == null)
            {
                failShape('failure-mode-table', `row ${index} must be string id or {id, description?}`);
            }
            return {
                id: normalizeScalarText(entry.id),
                description: normalizeScalarText(entry.description ?? entry.semanticId ?? '-')
            };
        });
    }
    else if (isPlainObject(value))
    {
        rows = Object.entries(value).map(([id, description]) => ({
            id: normalizeScalarText(id),
            description: normalizeScalarText(description)
        }));
    }
    else
    {
        failShape('failure-mode-table', 'expected id list, map, or [{id,description}]');
    }

    if (options.orderPolicy === 'ordinal' || options.orderPolicy == null)
    {
        rows = [...rows].sort((left, right) => compareOrdinal(left.id, right.id));
    }
    return markdownTable(
        ['Failure mode', 'Semantic'],
        rows.map((row) => [row.id, row.description])
    );
}

const defaultRouteColumns = Object.freeze(['method', 'path', 'auth', 'protocol']);

function renderRouteTable(value, options = {})
{
    if (isEmptyValue(value))
    {
        return applyEmptyPolicy('route-table', options.emptyPolicy, '_empty routes_');
    }
    if (!Array.isArray(value))
    {
        failShape('route-table', 'expected route array');
    }
    const columns = options.columns?.length ? options.columns : defaultRouteColumns;
    let rows = value.map((entry, index) =>
    {
        if (!isPlainObject(entry))
        {
            failShape('route-table', `route ${index} must be an object`);
        }
        return columns.map((column) => normalizeScalarText(entry[column] ?? '-'));
    });
    if (options.orderPolicy === 'ordinal' || options.orderPolicy == null)
    {
        rows = [...rows].sort((left, right) =>
        {
            for (let index = 0; index < columns.length; index += 1)
            {
                const compared = compareOrdinal(left[index], right[index]);
                if (compared !== 0)
                {
                    return compared;
                }
            }
            return 0;
        });
    }
    const headers = columns.map((column) => column.charAt(0).toUpperCase() + column.slice(1));
    return markdownTable(headers, rows);
}

function renderDependencyGraphTable(value, options = {})
{
    if (isEmptyValue(value))
    {
        return applyEmptyPolicy('dependency-graph-table', options.emptyPolicy, '_empty dependencies_');
    }

    let edges;
    if (Array.isArray(value))
    {
        edges = value.map((entry, index) =>
        {
            if (typeof entry === 'string')
            {
                const match = entry.match(/^([^>]+)->(.+)$/u);
                if (!match)
                {
                    failShape('dependency-graph-table', `unparseable edge ${entry}`);
                }
                return {
                    from: normalizeScalarText(match[1]),
                    to: normalizeScalarText(match[2]),
                    kind: '-'
                };
            }
            if (!isPlainObject(entry) || entry.from == null || entry.to == null)
            {
                failShape('dependency-graph-table', `edge ${index} must be {from,to,kind?}`);
            }
            return {
                from: normalizeScalarText(entry.from),
                to: normalizeScalarText(entry.to),
                kind: normalizeScalarText(entry.kind ?? entry.type ?? '-')
            };
        });
    }
    else if (isPlainObject(value))
    {
        edges = [];
        for (const [from, targets] of Object.entries(value))
        {
            const list = Array.isArray(targets) ? targets : [targets];
            for (const target of list)
            {
                edges.push({
                    from: normalizeScalarText(from),
                    to: normalizeScalarText(target),
                    kind: '-'
                });
            }
        }
    }
    else
    {
        failShape('dependency-graph-table', 'expected edge list or adjacency map');
    }

    if (options.orderPolicy === 'ordinal' || options.orderPolicy == null)
    {
        edges = [...edges].sort((left, right) =>
            compareOrdinal(left.from, right.from)
            || compareOrdinal(left.to, right.to)
            || compareOrdinal(left.kind, right.kind));
    }
    return markdownTable(
        ['From', 'To', 'Kind'],
        edges.map((edge) => [edge.from, edge.to, edge.kind])
    );
}

const rendererImplementations = Object.freeze({
    scalar: renderScalar,
    boolean: renderBoolean,
    'enum-set': renderEnumSet,
    'ordered-set': renderOrderedSet,
    'key-value-table': renderKeyValueTable,
    'transition-table': renderTransitionTable,
    'failure-mode-table': renderFailureModeTable,
    'route-table': renderRouteTable,
    'dependency-graph-table': renderDependencyGraphTable
});

/**
 * Unique registry: one implementation per renderer kind.
 * No domain-private registries, feature flags, or warning-only modes.
 */
export const RendererRegistry = Object.freeze({
    kinds: allowedRenderers,
    has(kind)
    {
        return Object.hasOwn(rendererImplementations, kind);
    },
    get(kind)
    {
        if (!this.has(kind))
        {
            throw makeGeneratedSectionError(
                GeneratedSectionErrorCode.RENDERER_UNKNOWN,
                `unknown renderer ${kind}`
            );
        }
        return rendererImplementations[kind];
    },
    render(kind, value, options = {})
    {
        const renderer = this.get(kind);
        const markdown = renderer(value, options);
        // Deterministic trailing newline policy: body without final newline;
        // wrapGeneratedSection adds structural newlines around markers.
        return `${markdown.replace(/\n+$/u, '')}`;
    }
});

export function assertSingleRendererRegistry(sourceText, label = 'module')
{
    const matches = sourceText.match(/\bRendererRegistry\b/gu) ?? [];
    // Mentions are fine; a second exported registry object is not.
    if (/\bexport\s+const\s+\w*RendererRegistry\b/u.test(sourceText)
        && !/\bexport\s+const\s+RendererRegistry\b/u.test(sourceText))
    {
        throw makeGeneratedSectionError(
            GeneratedSectionErrorCode.SECOND_REGISTRY,
            `${label} must not export a second RendererRegistry`
        );
    }
    if (/\bcreateRendererRegistry\b|\blegacyRendererRegistry\b|\bdomainRendererRegistry\b/u.test(sourceText))
    {
        throw makeGeneratedSectionError(
            GeneratedSectionErrorCode.SECOND_REGISTRY,
            `${label} must not define alternate renderer registries`
        );
    }
    return matches.length;
}
