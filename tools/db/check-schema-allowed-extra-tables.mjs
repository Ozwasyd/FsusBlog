#!/usr/bin/env node
// Checks the complete current entity/required-recipe target against original
// ordered migration source. Retirement is an effect, never an optional grant.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const argRootIndex = process.argv.indexOf('--root');
const root = resolve(argRootIndex >= 0 ? process.argv[argRootIndex + 1]
    : join(dirname(fileURLToPath(import.meta.url)), '../..'));
const failures = [];
const idPattern = /^[a-z_][a-z0-9_]*$/u;
function fail(message) { failures.push(message); }
function read(path) { return readFileSync(join(root, path), 'utf8'); }
function files(path) {
    const directory = join(root, path);
    if (!existsSync(directory)) throw new Error(`${path}: missing source directory`);
    return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
        .flatMap((entry) => {
            const child = `${path}/${entry.name}`;
            if (entry.isDirectory()) return files(child);
            if (entry.isFile()) return entry.name.endsWith('.cs') ? [child] : [];
            throw new Error(`${child}: non-regular source entry`);
        });
}

// Closed C# source lexer, not a compiler: static literals and balanced calls
// only. Unsupported/interpolated SQL cannot supply schema ownership evidence.
function tokens(source) {
    const result = [];
    let offset = 0;
    while (offset < source.length) {
        const rest = source.slice(offset);
        const space = rest.match(/^\s+/u);
        if (space) { offset += space[0].length; continue; }
        if (rest.startsWith('//')) {
            const end = source.indexOf('\n', offset); offset = end < 0 ? source.length : end; continue;
        }
        if (rest.startsWith('/*')) {
            const end = source.indexOf('*/', offset + 2);
            if (end < 0) throw new Error('unterminated C# comment');
            offset = end + 2; continue;
        }
        const start = offset;
        const prefix = rest.match(/^(\$*@?)("+)/u);
        if (prefix) {
            const [opening, flags, quotes] = prefix;
            offset += opening.length;
            let value = '';
            if (quotes.length >= 3) {
                const end = source.indexOf(quotes, offset);
                if (end < 0) throw new Error('unterminated C# raw literal');
                value = source.slice(offset, end); offset = end + quotes.length;
            } else if (quotes.length === 2) {
                // Empty ordinary literal: both quotes were consumed.
            } else {
                if (quotes.length !== 1) throw new Error('unsupported C# literal');
                let closed = false;
                while (offset < source.length) {
                    const character = source[offset++];
                    if (character === '"') {
                        if (flags.includes('@') && source[offset] === '"') { value += '"'; offset++; continue; }
                        closed = true; break;
                    }
                    if (character === '\\' && !flags.includes('@')) {
                        const escape = source[offset++];
                        const simple = { a: '\x07', b: '\b', f: '\f', v: '\v', n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"', "'": "'", '0': '\0' };
                        if (escape in simple) value += simple[escape];
                        else if (['u', 'U', 'x'].includes(escape)) {
                            const count = escape === 'u' ? 4 : escape === 'U' ? 8 : null;
                            const hex = source.slice(offset).match(count ? new RegExp(`^[a-fA-F0-9]{${count}}`, 'u') : /^[a-fA-F0-9]{1,4}/u);
                            if (!hex) throw new Error('unsupported C# literal escape');
                            value += String.fromCodePoint(Number.parseInt(hex[0], 16)); offset += hex[0].length;
                        } else throw new Error('unsupported C# literal escape');
                    } else value += character;
                }
                if (!closed) throw new Error('unterminated C# literal');
            }
            result.push({ kind: flags.includes('$') ? 'dynamic' : 'string', value, start, end: offset });
            continue;
        }
        if (rest.startsWith("'")) {
            offset++;
            while (offset < source.length && source[offset] !== "'") {
                if (source[offset] === '\\') offset += 2; else offset++;
            }
            if (source[offset++] !== "'") throw new Error('unsupported C# character literal');
            result.push({ kind: 'char', value: '', start, end: offset }); continue;
        }
        const identifier = rest.match(/^@?[A-Za-z_][A-Za-z_0-9]*/u);
        const value = identifier?.[0] ?? source[offset];
        offset += value.length;
        result.push({ kind: identifier ? 'identifier' : 'punctuation', value, start, end: offset });
    }
    return result;
}
function close(ts, start) {
    const pairs = { '(': ')', '[': ']', '{': '}' };
    const stack = [];
    for (let index = start; index < ts.length; index++) {
        const value = ts[index].value;
        if (ts[index].kind !== 'punctuation') continue;
        if (value in pairs) stack.push(pairs[value]);
        else if ([')', ']', '}'].includes(value)) {
            if (value !== stack.pop()) throw new Error('unbalanced C# source');
            if (stack.length === 0) return index;
        }
    }
    throw new Error('unclosed C# source');
}
function split(ts) {
    const result = [];
    let start = 0;
    for (let index = 0; index < ts.length; index++) {
        if (ts[index].kind !== 'punctuation') continue;
        if (['(', '[', '{'].includes(ts[index].value)) index = close(ts, index);
        else if (ts[index].value === ',') { result.push(ts.slice(start, index)); start = index + 1; }
    }
    if (start < ts.length) result.push(ts.slice(start));
    return result.filter((part) => part.length);
}
function text(ts) { return ts.map((token) => token.value).join(''); }
function literal(ts) {
    if (ts.length !== 1 || ts[0].kind !== 'string') throw new Error('unresolved static C# literal');
    return ts[0].value;
}
function name(ts) {
    const value = literal(ts);
    if (!idPattern.test(value)) throw new Error(`unresolved schema identifier ${value}`);
    return value;
}
function named(args, key) {
    const matches = args.filter((part) => part[0]?.value === key && part[1]?.value === ':');
    if (matches.length !== 1) throw new Error(`missing/duplicate ${key}`);
    return matches[0].slice(2);
}
function collection(ts) {
    if (ts[0]?.value !== '[' || close(ts, 0) !== ts.length - 1) throw new Error('unresolved source collection');
    return split(ts.slice(1, -1));
}
function call(ts, type) {
    if (text(ts.slice(0, 3)) !== `new${type}(` || close(ts, 2) !== ts.length - 1)
        throw new Error(`unresolved ${type} construction`);
    return split(ts.slice(3, -1));
}

// Normalize insignificant SQL whitespace while preserving single-quoted data.
function normalizeSql(sql) {
    let quoted = false;
    let pending = false;
    let value = '';
    for (let index = 0; index < sql.length; index++) {
        const character = sql[index];
        if (character === "'") {
            if (pending && value) value += ' ';
            pending = false; value += character;
            if (quoted && sql[index + 1] === "'") value += sql[++index]; else quoted = !quoted;
        } else if (!quoted && /\s/u.test(character)) pending = true;
        else { if (pending && value) value += ' '; pending = false; value += character; }
    }
    if (quoted) throw new Error('unclosed SQL literal');
    return value.trim();
}
function statements(sql) {
    const result = [];
    let start = 0;
    let quoted = false;
    let dollar = null;
    for (let index = 0; index < sql.length; index++) {
        if (dollar) {
            if (sql.startsWith(dollar, index)) { index += dollar.length - 1; dollar = null; }
        } else if (sql[index] === "'") {
            if (quoted && sql[index + 1] === "'") index++; else quoted = !quoted;
        } else if (!quoted) {
            const marker = sql.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/u);
            if (marker) { dollar = marker[0]; index += dollar.length - 1; }
            else if (sql[index] === ';') { result.push(sql.slice(start, index + 1).trim()); start = index + 1; }
        }
    }
    if (quoted || dollar || sql.slice(start).trim()) throw new Error('unclosed/unparsed SQL statement');
    return result.filter(Boolean);
}
function plainSql(sql) {
    // Preserve offsets, but remove literals/comments so inert text is not DDL.
    return sql.replace(/'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//gu,
        (match) => match.replace(/[^\n]/gu, ' '));
}
function createStatements(sql) {
    const plain = plainSql(sql);
    const result = [];
    for (const match of plain.matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_0-9]+)\s*\(/giu)) {
        const end = plain.indexOf(';', match.index);
        if (end < 0) throw new Error('unclosed CREATE TABLE');
        result.push({ table: match[1], sql: normalizeSql(sql.slice(match.index, end + 1)), offset: match.index });
    }
    const count = [...plain.matchAll(/\bCREATE\s+(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?TABLE\b/giu)].length;
    if (count !== result.length) throw new Error('unresolved CREATE TABLE syntax');
    return result;
}
function closedDynamicAlter(command) {
    const match = command.match(/^ALTER TABLE [a-z_][a-z_0-9]* (.*)$/u);
    if (!match || /;|%|--|\/\*/u.test(command)) return false;
    let depth = 0;
    let quoted = false;
    let start = 0;
    const changes = [];
    const body = match[1];
    for (let index = 0; index < body.length; index++) {
        if (body[index] === "'") quoted = !quoted;
        if (quoted) continue;
        if (body[index] === '(') depth++;
        if (body[index] === ')' && --depth < 0) return false;
        if (body[index] === ',' && depth === 0) { changes.push(body.slice(start, index).trim()); start = index + 1; }
    }
    if (depth || quoted) return false;
    changes.push(body.slice(start).trim());
    return changes.every((change) =>
        /^ADD COLUMN IF NOT EXISTS [a-z_][a-z_0-9]* (?:integer|bigint) (?:NULL|NOT NULL DEFAULT [0-9]+)$/u.test(change)
        || /^ADD CONSTRAINT [a-z_][a-z_0-9]* FOREIGN KEY \([a-z_][a-z_0-9]*(?:, [a-z_][a-z_0-9]*)*\) REFERENCES [a-z_][a-z_0-9]*\([a-z_][a-z_0-9]*(?:, [a-z_][a-z_0-9]*)*\) ON DELETE (?:CASCADE|RESTRICT)$/u.test(change)
        || /^ALTER COLUMN [a-z_][a-z_0-9]* SET NOT NULL$/u.test(change)
        || /^ALTER COLUMN [a-z_][a-z_0-9]* SET DEFAULT \(now\(\) AT TIME ZONE 'utc'\)$/u.test(change));
}

function formatArguments(remaining) {
    if (!remaining.startsWith(',')) throw new Error('unresolved formatted schema arguments');
    const result = [];
    let start = 1;
    let depth = 1;
    let quoted = false;
    for (let index = 1; index < remaining.length; index++) {
        const character = remaining[index];
        if (character === "'") {
            if (quoted && remaining[index + 1] === "'") index++; else quoted = !quoted;
        } else if (!quoted) {
            if (character === '(') depth++;
            if (character === ')') {
                if (--depth === 0) {
                    if (!/^\s*(?:;|INTO\b)/iu.test(remaining.slice(index + 1)))
                        throw new Error('unresolved formatted schema concatenation');
                    result.push(remaining.slice(start, index).trim()); return result;
                }
            }
            if (character === ',' && depth === 1) { result.push(remaining.slice(start, index).trim()); start = index + 1; }
        }
    }
    throw new Error('unclosed formatted schema arguments');
}
function bindFormattedSchemaTarget(command, remaining, sql, executeOffset, descriptor) {
    const args = formatArguments(remaining);
    const fixed = command.match(/^ALTER TABLE ([a-z_][a-z_0-9]*(?:\.[a-z_][a-z_0-9]*)?) DROP CONSTRAINT %I$/u);
    if (fixed) {
        if (args.length !== 1 || !/^(?:'[a-z_][a-z_0-9]*'|[a-z_][a-z_0-9]*(?:\.[a-z_][a-z_0-9]*)?)$/u.test(args[0]))
            throw new Error(`${descriptor.id}: unresolved formatted constraint argument`);
        const table = fixed[1].replace(/^public\./u, '');
        if (required.has(table)) throw new Error(`${descriptor.id}: unsupported formatted required-table constraint mutation`);
        if (!entityTables.has(table) || (fixed[1].includes('.') && !fixed[1].startsWith('public.')))
            throw new Error(`${descriptor.id}: unbound formatted schema target`);
        return;
    }
    if (command !== 'ALTER TABLE %I DROP CONSTRAINT %I' || args.length !== 2)
        throw new Error(`${descriptor.id}: unresolved formatted schema effect`);
    const literalTarget = args[0].match(/^'([a-z_][a-z_0-9]*)'$/u);
    if (literalTarget) {
        if (required.has(literalTarget[1])) throw new Error(`${descriptor.id}: unsupported formatted required-table constraint mutation`);
        if (!entityTables.has(literalTarget[1])) throw new Error(`${descriptor.id}: unbound formatted schema target`);
        if (!/^(?:'[a-z_][a-z_0-9]*'|[a-z_][a-z_0-9]*(?:\.[a-z_][a-z_0-9]*)?)$/u.test(args[1]))
            throw new Error(`${descriptor.id}: unresolved formatted constraint argument`);
        return;
    }
    // The original prototype loop has a closed pg_constraint relation query.
    // It supplies source dependency evidence, never native database evidence.
    const prefix = normalizeSql(sql.slice(0, executeOffset));
    const relation = prefix.match(/FOR ([a-z_][a-z_0-9]*) IN SELECT ([a-z_][a-z_0-9]*)\.relname AS table_name, ([a-z_][a-z_0-9]*)\.conname AS constraint_name FROM pg_constraint \3 JOIN pg_class \2 ON \2\.oid = \3\.conrelid WHERE \3\.contype = 'f' AND \3\.confrelid = 'public\.([a-z_][a-z_0-9]*)'::regclass LOOP$/u);
    if (!relation || args[0] !== `${relation[1]}.table_name` || args[1] !== `${relation[1]}.constraint_name`
        || !entityTables.has(relation[4])) throw new Error(`${descriptor.id}: unresolved formatted schema target relation`);
    const reference = new RegExp(`\\bREFERENCES\\s+(?:(?:public|"public")\\.)?"?${relation[4]}"?\\s*\\(`, 'iu');
    for (const recipe of required.values()) if ([recipe.create, ...recipe.additional].some((source) => reference.test(plainSql(source))))
        throw new Error(`${descriptor.id}: formatted schema target relation may mutate a required-table constraint`);
}

function retirement(sql) {
    const normalized = normalizeSql(sql);
    const pattern = /^DO \$\$ DECLARE ([a-z_][a-z_0-9]*) text; BEGIN FOREACH \1 IN ARRAY ARRAY\[(.*?)\] LOOP EXECUTE 'DROP TABLE IF EXISTS ' \|\| quote_ident\(\1\); END LOOP; END \$\$;$/u;
    const match = normalized.match(pattern);
    if (!match) throw new Error('unresolved dynamic/conditional table retirement');
    return match[2].split(',').map((expression) => {
        if (!/^\s*'[a-z_0-9]+'(?:\s*\|\|\s*'[a-z_0-9]+')*\s*$/u.test(expression))
            throw new Error('unresolved retirement array expression');
        const table = [...expression.matchAll(/'([a-z_0-9]+)'/gu)].map((item) => item[1]).join('');
        if (!idPattern.test(table)) throw new Error('invalid retirement table');
        return table;
    });
}

const nonLifecycleSteps = new Set(['EnsureColumnStep', 'RenameColumnStep', 'DropColumnStep',
    'CopyColumnToColumnStep', 'CopyColumnToTableStep', 'ContentAssetCutoverBackfillStep',
    'ClearLegacyPublicArtifactsStep', 'BackfillCommentInitialRevisionStep',
    'AccountSubjectHashBackfillStep', 'CreateScheduledPublishDueIndexStep']);
function descriptors(path, source) {
    const ts = tokens(source);
    const constants = new Map();
    const className = ts.findIndex((token) => token.value === 'class');
    const owner = ts[className + 1]?.value;
    if (!owner) throw new Error(`${path}: missing definition owner`);
    for (let index = 0; index < ts.length - 4; index++) {
        if (text(ts.slice(index, index + 2)) === 'conststring' && ts[index + 3].value === '=')
            constants.set(ts[index + 2].value, literal([ts[index + 4]]));
    }
    const helpers = new Map();
    for (let index = 0; index < ts.length - 8; index++) {
        if (ts[index].value.endsWith('Step') && ts[index + 2]?.value === '(' && ts[index + 3]?.value === ')'
            && ts[index + 4]?.value === '=' && ts[index + 5]?.value === '>' && ts[index + 6]?.value === 'new'
            && ts[index + 7]?.value === '(') {
            const end = close(ts, index + 7);
            helpers.set(ts[index + 1].value, [ts[index + 6], { ...ts[index], value: ts[index].value }, ...ts.slice(index + 7, end + 1)]);
        }
    }
    const result = [];
    let method;
    for (let index = 0; index < ts.length - 2; index++) {
        if (ts[index].value === 'ISchemaMigrationDescriptor' && ts[index + 2]?.value === '(')
            method = ts[index + 1].value;
        if (text(ts.slice(index, index + 3)) !== 'newSchemaMigrationDescriptor(') continue;
        const end = close(ts, index + 2);
        const args = split(ts.slice(index + 3, end));
        const id = args[0]?.length === 1 && args[0][0].kind === 'identifier'
            ? constants.get(args[0][0].value) : literal(args[0]);
        if (!/^[0-9]{8}-(?:pre|post)-[a-z0-9-]+$/u.test(id ?? '')) throw new Error(`${path}: unresolved migration id`);
        const phase = text(args[2]);
        const expected = id.includes('-pre-') ? 'SchemaMigrationPhase.PreCodeFirst' : 'SchemaMigrationPhase.PostCodeFirst';
        if (phase !== expected) throw new Error(`${id}: phase/id mismatch`);
        if (!method) throw new Error(`${id}: unresolved descriptor factory`);
        result.push({ id, phase: phase.endsWith('PreCodeFirst') ? 0 : 1,
            factory: `${owner}.${method}`, path, steps: collection(named(args, 'Steps')).map((step) => {
                if (step.length === 3 && text(step.slice(1)) === '()') {
                    const helper = helpers.get(step[0].value);
                    if (!helper) throw new Error(`${id}: unresolved step factory ${step[0].value}`);
                    return helper;
                }
                return step;
            }) });
        index = end;
    }
    // A static SQL literal outside any parsed descriptor cannot disappear merely
    // because a new recursive source file is not registered in the catalog.
    for (const descriptor of result) descriptor.steps = descriptor.steps.flatMap((step) => {
        if (text(step.slice(0, 2)) !== '..') return [step];
        const spread = text(step).match(/^\.\.([A-Za-z_][A-Za-z_0-9]*)\(\)\.Steps\.OfType<([A-Za-z_][A-Za-z_0-9]*Step)>\(\)$/u);
        if (!spread) throw new Error(`${descriptor.id}: unresolved step spread`);
        const referenced = result.find((item) => item.factory === `${owner}.${spread[1]}`);
        if (!referenced || referenced === descriptor || referenced.steps.some((item) => item[0]?.value !== 'new'))
            throw new Error(`${descriptor.id}: unresolved/cyclic step source`);
        return referenced.steps.filter((item) => item[1].value === spread[2]);
    });
    const covered = result.flatMap((descriptor) => descriptor.steps.flat());
    const ownedStarts = new Set(covered.map((token) => token.start));
    for (const token of ts) {
        if ((token.kind === 'string' || token.kind === 'dynamic')
            && /\b(?:CREATE|DROP|ALTER)\s+TABLE\b/iu.test(token.value)
            && !ownedStarts.has(token.start)) throw new Error(`${path}: unbound schema source outside descriptor steps`);
    }
    return result;
}

function catalogFactories() {
    const manifest = tokens(read('src/migration/SchemaMigrationManifest.cs'));
    const activeCatalogs = new Set();
    const currents = manifest.flatMap((token, index) => text(manifest.slice(index, index + 11)) === 'internalstaticSchemaMigrationManifestCurrent{get;}=Create(' ? [index] : []);
    if (currents.length !== 1) throw new Error('unresolved current manifest owner');
    const create = currents[0] + 9;
    if (create < 0) throw new Error('unresolved current manifest');
    const currentArgs = split(manifest.slice(create + 2, close(manifest, create + 1)));
    function visitCatalog(part) {
        if (part.length === 5 && text(part.slice(1)) === '.Create()') {
            if (activeCatalogs.has(part[0].value)) throw new Error('duplicate manifest catalog');
            activeCatalogs.add(part[0].value); return;
        }
        if (part.length !== 3 || text(part.slice(1)) !== '()') throw new Error('unresolved manifest catalog entry');
        const method = manifest.findIndex((token, index) => token.value === part[0].value
            && manifest[index - 1]?.value === 'SchemaMigrationCatalog' && manifest[index + 3]?.value === '{');
        if (method < 0) throw new Error('unresolved manifest catalog helper');
        const body = manifest.slice(method + 4, close(manifest, method + 3));
        if (text(body.slice(0, 6)) !== 'SchemaMigrationCatalog[]catalogs=[') throw new Error('unresolved catalog helper input');
        const end = close(body, 5);
        for (const item of collection(body.slice(5, end + 1))) visitCatalog(item);
        if (text(body.slice(end + 1, end + 6)) !== ';returnnewSchemaMigrationCatalog(')
            throw new Error('unresolved catalog helper return');
        const returnEnd = close(body, end + 5);
        if (returnEnd !== body.length - 2 || body.at(-1).value !== ';') throw new Error('unresolved catalog helper tail');
        const args = split(body.slice(end + 6, returnEnd));
        if (text(named(args, 'Descriptors')) !== 'Array.AsReadOnly([..catalogs.SelectMany(staticcatalog=>catalog.Descriptors).Order(SchemaMigrationExecutionOrder.Instance)])')
            throw new Error('unresolved catalog helper descriptor composition');
    }
    for (const part of collection(currentArgs[0])) visitCatalog(part);
    const result = new Set();
    for (const path of files('src/migration/Catalogs')) {
        const ts = tokens(read(path));
        const classIndex = ts.findIndex((token) => token.value === 'class');
        if (!activeCatalogs.has(ts[classIndex + 1]?.value)) continue;
        const declarations = ts.flatMap((token, index) => text(ts.slice(index, index + 10)) === 'internalstaticSchemaMigrationCatalogCreate()=>new(' ? [index] : []);
        if (declarations.length !== 1) throw new Error(`${path}: unresolved catalog Create owner`);
        const opening = declarations[0] + 9;
        const args = split(ts.slice(opening + 1, close(ts, opening)));
        for (const part of collection(named(args, 'Descriptors'))) {
            if (part.length !== 5 || text(part.slice(1)) !== `.${part[2].value}()`)
                throw new Error(`${path}: unresolved catalog factory`);
            const factory = `${part[0].value}.${part[2].value}`;
            if (result.has(factory)) throw new Error(`${factory}: duplicate catalog factory`);
            result.add(factory);
        }
        activeCatalogs.delete(ts[classIndex + 1].value);
    }
    if (activeCatalogs.size) throw new Error(`unresolved manifest catalogs ${[...activeCatalogs].join(',')}`);
    return result;
}
function recipes(source) {
    const ts = tokens(source);
    const start = ts.findIndex((token) => token.value === 'Tables');
    const open = ts.findIndex((token, index) => index > start && token.value === '[');
    const result = new Map();
    for (const part of collection(ts.slice(open, close(ts, open) + 1))) {
        if (text(part.slice(0, 2)) !== 'new(' || close(part, 1) !== part.length - 1)
            throw new Error('unresolved required recipe construction');
        const args = split(part.slice(2, -1));
        const table = name(args[0]);
        const createSource = literal(args[1]);
        const creates = createStatements(createSource);
        if (statements(createSource).length !== 1 || creates[0]?.sql !== normalizeSql(createSource)) throw new Error(`${table}: unparsed required CREATE tail`);
        if (creates.length !== 1 || creates[0].table !== table) throw new Error(`${table}: required CREATE owner mismatch`);
        let additional = [];
        if (args.length === 3) additional = collection(named(args, 'AdditionalSql')).flatMap((item) => statements(literal(item)));
        else if (args.length !== 2) throw new Error(`${table}: unresolved required recipe fields`);
        if (result.has(table)) throw new Error(`${table}: duplicate required owner`);
        for (const effect of additional) {
            const normalized = normalizeSql(effect);
            if (!/^(?:CREATE (?:UNIQUE )?INDEX IF NOT EXISTS |CREATE SEQUENCE IF NOT EXISTS |CREATE OR REPLACE FUNCTION |DROP TRIGGER IF EXISTS |CREATE TRIGGER |INSERT INTO |ALTER TABLE [a-z_][a-z_0-9]* ADD COLUMN IF NOT EXISTS |DO \$\$ BEGIN IF NOT EXISTS \()/u.test(normalized)
                || /\bEXECUTE\b(?!\s+FUNCTION\b)/iu.test(plainSql(effect))) throw new Error(`${table}: unresolved required additional operation`);
        }
        result.set(table, { create: creates[0].sql, additional: additional.map(normalizeSql) });
    }
    if (!result.size) throw new Error('empty required recipe catalog');
    return result;
}

const surviving = new Map();
const everCreated = new Set();
const proofIds = new Set();
function forgetTable(table) {
    surviving.delete(table);
    for (const [key, effect] of finalEffects) if (effect.table === table) finalEffects.delete(key);
}
const sourceSql = new Set();
const finalEffects = new Map();
function retainEffect(key, effect, descriptor) {
    const existing = finalEffects.get(key);
    if (existing && (existing.table !== effect.table || existing.sql !== effect.sql)
        && (required.has(existing.table) || required.has(effect.table)))
        throw new Error(`${descriptor.id}: conflicting final effect without retirement ${key}`);
    if (!existing) finalEffects.set(key, effect);
}

function sqlEffects(sql, descriptor) {
    const plain = plainSql(sql);
    const drops = [...plain.matchAll(/\bDROP\s+TABLE\b/giu)];
    if (drops.length || /'DROP\s+TABLE\b/iu.test(sql)) {
        for (const table of retirement(sql)) {
            if (!surviving.has(table) && everCreated.has(table)) throw new Error(`${descriptor.id}: retirement precedes CREATE for ${table}`);
            forgetTable(table);
        }
        return;
    }
    if (/\bALTER\s+TABLE\b[^;]*\bRENAME\s+TO\b/iu.test(plain)) throw new Error('unresolved raw table rename');
    // Dynamic EXECUTE must have a closed non-lifecycle command prefix. Trigger
    // EXECUTE FUNCTION is not dynamic SQL. No opaque variable gets authority.
    let dynamic = false;
    for (const match of plain.matchAll(/\bEXECUTE\b(?!\s+FUNCTION\b)/giu)) {
        dynamic = true;
        let tail = sql.slice(match.index + match[0].length).trimStart();
        const formatting = tail.match(/^format\(\s*/iu);
        if (formatting) tail = tail.slice(formatting[0].length);
        const quoted = tail.match(/^'((?:[^']|'')*)'/u);
        const dollar = tail.match(/^(\$[A-Za-z_]*\$)([\s\S]*?)\1/u);
        if (!quoted && !dollar) throw new Error(`${descriptor.id}: unresolved dynamic SQL command`);
        const command = quoted ? quoted[1].replaceAll("''", "'") : dollar[2];
        const remaining = tail.slice((quoted ?? dollar)[0].length).trimStart();
        const formatted = Boolean(formatting);
        if (formatted ? !/^[,)]/u.test(remaining) : !/^(?:;|INTO\b)/iu.test(remaining))
            throw new Error(`${descriptor.id}: unresolved dynamic SQL concatenation`);
        const commandPlain = plainSql(command);
        const commandNormalized = normalizeSql(command);
        if (/\b(?:CREATE|DROP)\s+(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?TABLE\b|\bALTER\s+TABLE\b[^;]*\bRENAME\s+TO\b/iu.test(commandPlain))
            throw new Error(`${descriptor.id}: unresolved dynamic table lifecycle`);
        if (/^\s*ALTER\s+TABLE\b/iu.test(command)) {
            if (formatted && !/^ALTER TABLE (?:%I|[a-z_][a-z_0-9]*(?:\.[a-z_][a-z_0-9]*)?) DROP CONSTRAINT %I$/u.test(normalizeSql(command)))
                throw new Error(`${descriptor.id}: unresolved formatted schema effect`);
            if (formatted) bindFormattedSchemaTarget(commandNormalized, remaining, sql, match.index, descriptor);
            if (!formatted) {
                const table = commandNormalized.match(/^ALTER TABLE ([a-z_][a-z_0-9]*) /u)?.[1];
                if (required.has(table)) throw new Error(`${descriptor.id}: unsupported dynamic required-table schema mutation`);
                if (!table || !entityTables.has(table) || !closedDynamicAlter(commandNormalized))
                    throw new Error(`${descriptor.id}: unresolved dynamic schema effect`);
            }
        } else if (/^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\b/iu.test(command)) {
            if (formatted || !/^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS [a-z_][a-z_0-9]* ON [a-z_][a-z_0-9]*\([a-z_][a-z_0-9]*(?:, [a-z_][a-z_0-9]*)*\)$/u.test(commandNormalized) || /%/u.test(command))
                throw new Error(`${descriptor.id}: unresolved dynamic index effect`);
            const table = commandNormalized.match(/ ON ([a-z_][a-z_0-9]*)\(/u)?.[1];
            if (required.has(table) || !entityTables.has(table)) throw new Error(`${descriptor.id}: unsupported dynamic index target`);
        } else if (!/^\s*(?:SELECT|UPDATE|INSERT INTO|DELETE FROM)\b/iu.test(command))
            throw new Error(`${descriptor.id}: unresolved dynamic SQL command`);
    }
    for (const create of createStatements(sql)) {
        const existing = surviving.get(create.table);
        if (existing && existing.sql !== create.sql) throw new Error(`${descriptor.id}: conflicting CREATE without retirement for ${create.table}`);
        if (!existing) surviving.set(create.table, { sql: create.sql, id: descriptor.id });
    }
    for (const statement of statements(sql)) {
        if (!dynamic) sourceSql.add(normalizeSql(statement));
        const match = statement.match(/^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF NOT EXISTS\s+)?([a-z_0-9]+)\s+ON\s+([a-z_0-9]+)/iu);
        if (match) retainEffect(`index:${match[1]}`, { kind: 'index', table: match[2], sql: normalizeSql(statement) }, descriptor);
        const trigger = statement.match(/^CREATE TRIGGER ([a-z_0-9]+).*?\bON ([a-z_0-9]+)/isu);
        if (trigger) retainEffect(`trigger:${trigger[1]}`, { kind: 'trigger', table: trigger[2], sql: normalizeSql(statement) }, descriptor);
        const functionCreate = statement.match(/^CREATE OR REPLACE FUNCTION ([a-z_0-9]+)\(\)/u);
        if (functionCreate) finalEffects.set(`function:${functionCreate[1]}`, { kind: 'function', table: null, sql: normalizeSql(statement) });
        const sequenceCreate = statement.match(/^CREATE SEQUENCE IF NOT EXISTS ([a-z_0-9]+) AS bigint;$/u);
        if (sequenceCreate) {
            const key = `sequence:${sequenceCreate[1]}`;
            const existing = finalEffects.get(key);
            if (existing && existing.sql !== normalizeSql(statement)) throw new Error('conflicting sequence without retirement');
            finalEffects.set(key, { kind: 'sequence', table: null, sql: normalizeSql(statement) });
        }
        const globalDrop = statement.match(/^DROP (FUNCTION|SEQUENCE) (?:IF EXISTS )?(?:public\.)?([a-z_0-9]+)(?:\(\))?(?: CASCADE| RESTRICT)?;$/u);
        if (globalDrop) finalEffects.delete(`${globalDrop[1].toLowerCase()}:${globalDrop[2]}`);
        else if (/^DROP (?:FUNCTION|SEQUENCE)\b/u.test(statement)) throw new Error('unresolved independent effect retirement');
        const dropIndex = statement.match(/^DROP INDEX (?:CONCURRENTLY )?(?:IF EXISTS )?([a-z_0-9]+);$/u);
        if (dropIndex) finalEffects.delete(`index:${dropIndex[1]}`);
        const dropTrigger = statement.match(/^DROP TRIGGER (?:IF EXISTS )?([a-z_0-9]+) ON ([a-z_0-9]+);$/u);
        if (dropTrigger) finalEffects.delete(`trigger:${dropTrigger[1]}`);
        for (const alter of plainSql(statement).matchAll(/\bALTER\s+TABLE\s+([a-z_0-9]+)\s+([^;]+);/giu)) {
            if (!required.has(alter[1])) continue;
            if (dynamic) throw new Error(`${descriptor.id}: dynamic required-table schema effect cannot supply final facts`);
            const added = alter[2].match(/^ADD\s+(COLUMN IF NOT EXISTS|CONSTRAINT)\s+([a-z_0-9]+)/iu);
            if (!added) throw new Error(`${descriptor.id}: unsupported required-table ALTER effect`);
            const kind = added[1] === 'CONSTRAINT' ? 'constraint' : 'column';
            const create = surviving.get(alter[1]);
            const present = create && (kind === 'constraint'
                ? new RegExp(`\\bCONSTRAINT\\s+${added[2]}\\b`, 'u').test(plainSql(create.sql))
                : new RegExp(`(?:\\(|,)\\s*${added[2]}\\s+`, 'u').test(plainSql(create.sql)));
            if (!present) retainEffect(`${kind}:${alter[1]}:${added[2]}`, { kind, table: alter[1], sql: normalizeSql(statement) }, descriptor);
        }
    }
    // CREATEs nested in a legacy conditional block remain possible survivors;
    // a conditional DROP is never accepted as final retirement evidence.
}
function stepEffects(step, descriptor) {
    const type = step[1]?.value;
    const args = call(step, type);
    if (type === 'DropTableStep') {
        const table = name(args[0]);
        if (args.length !== 2 || text(args[1].slice(0, 4)) !== 'DestructiveMigrationProofs.For(' || close(args[1], 3) !== args[1].length - 1
            || literal(args[1].slice(4, -1)) !== descriptor.id || !proofIds.has(descriptor.id)) throw new Error(`${descriptor.id}: unbound destructive retirement proof`);
        if (!surviving.has(table) && everCreated.has(table)) throw new Error(`${descriptor.id}: retirement precedes CREATE for ${table}`);
        forgetTable(table);
    } else if (type === 'EnsureTableStep') {
        if (args.length !== 2) throw new Error('unresolved EnsureTableStep');
        const table = name(args[0]); const sql = literal(args[1]);
        const creates = createStatements(sql);
        if (!creates.some((create) => create.table === table)) throw new Error(`${descriptor.id}: EnsureTableStep owner mismatch ${table}`);
        sqlEffects(sql, descriptor);
    } else if (['RawSqlStep', 'BackfillSqlStep', 'AssertSqlStep', 'CreateIndexStep'].includes(type)) {
        const sql = literal(args[type === 'AssertSqlStep' || type === 'CreateIndexStep' ? 1 : 0]);
        sqlEffects(sql, descriptor);
    } else if (type === 'DropIndexStep') {
        finalEffects.delete(`index:${name(args[0])}`);
    } else if (type === 'EnsureColumnStep') {
        const table = name(args[0]); const column = name(args[1]);
        const sql = normalizeSql(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${literal(args[2])};`);
        sourceSql.add(sql);
        const create = surviving.get(table);
        const present = create && new RegExp(`(?:\\(|,)\\s*${column}\\s+`, 'u').test(plainSql(create.sql));
        if (!present) {
            const key = `column:${table}:${column}`;
            const old = finalEffects.get(key);
            if (old && old.sql !== sql && required.has(table)) throw new Error(`${descriptor.id}: conflicting column ensure without retirement`);
            finalEffects.set(key, { kind: 'column', table, sql });
        }
    } else if (['DropColumnStep', 'RenameColumnStep', 'CopyColumnToTableStep'].includes(type)) {
        const table = name(args[type === 'CopyColumnToTableStep' ? 1 : 0]);
        if (required.has(table)) throw new Error(`${descriptor.id}: unsupported required-table shape mutation ${type}`);
        if (type === 'DropColumnStep') finalEffects.delete(`column:${table}:${name(args[1])}`);
        if (type === 'RenameColumnStep') finalEffects.delete(`column:${table}:${name(args[1])}`);
    } else if (!nonLifecycleSteps.has(type)) throw new Error(`${descriptor.id}: unresolved migration step ${type}`);
}

let entityTables = new Set();
let required = new Map();
let original = [];
try {
    for (const path of files('src/backend')) {
        const ts = (() => { try { return tokens(read(path)); } catch (error) { throw new Error(`${path}: ${error.message}`); } })();
        if (ts.some((token) => token.kind === 'identifier' && token.value === 's_allowedExtraTables'))
            fail(`${path}: optional table grants are forbidden by the complete current target`);
        for (let index = 0; index < ts.length; index++) {
            if (ts[index].kind !== 'punctuation' || ts[index].value !== '[') continue;
            const end = close(ts, index);
            let declaration = end + 1;
            while (ts[declaration]?.value === '[') declaration = close(ts, declaration) + 1;
            while (['public', 'internal', 'private', 'protected', 'static', 'sealed', 'abstract', 'partial', 'readonly', 'ref', 'unsafe'].includes(ts[declaration]?.value)) declaration++;
            if (!['class', 'record', 'struct'].includes(ts[declaration]?.value)) continue;
            for (const attribute of split(ts.slice(index + 1, end))) {
                const opening = attribute.findIndex((token) => token.value === '(');
                if (opening < 0 || close(attribute, opening) !== attribute.length - 1) continue;
                const type = text(attribute.slice(0, opening)).replace(/^type:/u, '');
                if (!/^(?:global::)?(?:SqlSugar\.)?SugarTable(?:Attribute)?$/u.test(type)) continue;
                const table = literal(attribute.slice(opening + 1, -1)).trim().toLowerCase();
                if (!idPattern.test(table)) throw new Error(`${path}: unresolved entity table ${table}`);
                entityTables.add(table);
            }
        }
    }
    required = recipes(read('src/backend/Infrastructure/SchemaMigration/CurrentSchemaRuntimeRollupTables.cs'));
    const proofSource = tokens(read('src/migration/DestructiveMigrationProofs.cs'));
    const registry = proofSource.findIndex((token, index) => token.value === 's_proofs' && proofSource[index + 1]?.value === '=');
    if (registry < 0) throw new Error('unresolved destructive proof registry owner');
    const registryOpen = proofSource.findIndex((token, index) => index > registry && token.value === '{');
    const proofTokens = proofSource.slice(registryOpen + 1, close(proofSource, registryOpen));
    const forMethod = proofSource.findIndex((token, index) => text(proofSource.slice(index, index + 9)) === 'publicstaticDestructiveMigrationProofFor(stringmigrationId){');
    if (forMethod < 0) throw new Error('unresolved destructive proof lookup owner');
    const forBody = proofSource.slice(forMethod + 9, close(proofSource, forMethod + 8));
    const lookup = forBody.map((token) => token.kind === 'string' ? 'literal' : token.value).join('');
    if (lookup !== 'if(!s_proofs.TryGetValue(migrationId,outDestructiveMigrationProof?proof)){thrownewArgumentException(literal,nameof(migrationId));}returnproof;')
        throw new Error('unresolved destructive proof lookup flow');
    for (const entry of split(proofTokens)) {
        if (entry[0]?.value !== '[' || entry[1]?.kind !== 'string' || text(entry.slice(2, 6)) !== ']=Create(' || close(entry, 5) !== entry.length - 1)
            throw new Error('unresolved destructive proof registry entry');
        const args = split(entry.slice(6, -1));
        const id = entry[1].value;
        if (literal(args[0]) !== id || args.length !== 3 || !/^[a-f0-9]{40}$/u.test(literal(args[1]))
            || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(literal(args[2])) || proofIds.has(id))
            throw new Error('unresolved destructive proof registry entry');
        proofIds.add(id);
    }
    const registered = catalogFactories();
    for (const path of files('src/migration/Definitions')) original.push(...descriptors(path, read(path)));
    const classificationSource = tokens(read('src/migration/OfflineMigrationClassificationFacts.cs'));
    const classificationClass = classificationSource.findIndex((token, index) => text(classificationSource.slice(index, index + 5)) === 'publicstaticclassOfflineMigrationClassificationFacts{');
    if (classificationClass < 0) throw new Error('unresolved classification source owner');
    const classificationBody = classificationSource.slice(classificationClass + 5, close(classificationSource, classificationClass + 4));
    if (!text(classificationBody).includes('s_metadata=BuildMetadata();') || !text(classificationBody).includes('All=>s_metadata;'))
        throw new Error('unresolved classification producer flow');
    const builders = classificationBody.flatMap((token, index) => text(classificationBody.slice(index, index + 4)) === 'BuildMetadata(){' ? [index] : []);
    if (builders.length !== 1) throw new Error('unresolved classification BuildMetadata owner');
    const classifications = classificationBody.slice(builders[0] + 4, close(classificationBody, builders[0] + 3));
    const classified = new Set();
    for (let index = 0; index < classifications.length - 4; index++) {
        if (text(classifications.slice(index, index + 4)) === 'result.Add(' && classifications[index + 4]?.kind === 'string')
            classified.add(classifications[index + 4].value);
    }
    const legacy = classifications.findIndex((token, index) => token.value === 'explicitlyClassifiedLegacyContracts' && classifications[index + 1]?.value === '=');
    if (legacy < 0) throw new Error('unresolved original legacy classification source');
    for (const part of collection(classifications.slice(legacy + 2, close(classifications, legacy + 2) + 1))) classified.add(literal(part));
    const ids = new Set();
    for (const descriptor of original) {
        if (!registered.delete(descriptor.factory)) throw new Error(`${descriptor.path}: unregistered/duplicate descriptor ${descriptor.factory}`);
        if (ids.has(descriptor.id)) throw new Error(`duplicate migration id ${descriptor.id}`);
        if (!classified.has(descriptor.id)) throw new Error(`${descriptor.id}: descriptor has no original source classification`);
        ids.add(descriptor.id);
    }
    if (registered.size) throw new Error(`missing catalog factories ${[...registered].join(',')}`);
    for (const descriptor of original) for (const step of descriptor.steps)
        for (const token of step) if (token.kind === 'string')
            for (const create of createStatements(token.value)) everCreated.add(create.table);
    original.sort((a, b) => a.phase - b.phase || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const descriptor of original) for (const step of descriptor.steps) {
        try { stepEffects(step, descriptor); }
        catch (error) { throw new Error(`${descriptor.id}: ${error.message} [${step[1]?.value}]`); }
    }
    for (const [table, recipe] of required) {
        if (entityTables.has(table)) fail(`${table}: entity/required recipe owner overlap`);
        const historical = surviving.get(table);
        if (!historical) fail(`${table}: required table has no surviving registered CREATE`);
        else if (historical.sql !== recipe.create) fail(`CREATE TABLE SQL for "${table}" does not match original surviving source`);
        for (const effect of recipe.additional) {
            if (!sourceSql.has(effect)) fail(`${table}: required additional SQL does not match original source: ${effect}`);
            const index = effect.match(/^CREATE (?:UNIQUE )?INDEX (?:CONCURRENTLY )?(?:IF NOT EXISTS )?([a-z_0-9]+)/u);
            const trigger = effect.match(/^CREATE TRIGGER ([a-z_0-9]+)/u);
            const global = effect.match(/^CREATE (OR REPLACE FUNCTION|SEQUENCE IF NOT EXISTS) ([a-z_0-9]+)/u);
            const key = index ? `index:${index[1]}` : trigger ? `trigger:${trigger[1]}`
                : global ? `${global[1].startsWith('OR') ? 'function' : 'sequence'}:${global[2]}` : null;
            if (key && finalEffects.get(key)?.sql !== effect) fail(`${table}: required operation is not a final surviving effect: ${effect}`);
        }
    }
    for (const [table] of surviving) if (!entityTables.has(table) && !required.has(table))
        fail(`${table}: surviving migration table is missing from the complete current entity/required catalog`);
    const requiredEffects = new Set([...required.values()].flatMap((recipe) => recipe.additional));
    for (const effect of finalEffects.values()) if (required.has(effect.table) && !requiredEffects.has(effect.sql))
        fail(`${effect.table}: original final effect is missing from required additional SQL: ${effect.sql}`);
} catch (error) { fail(error.message); }

if (failures.length) {
    for (const issue of failures) process.stderr.write(`[schema-allowed-extra-tables] ${issue}\n`);
    process.exitCode = 1;
} else process.stdout.write(`[schema-allowed-extra-tables] ok entities=${entityTables.size} descriptors=${original.length} surviving=${surviving.size} required=${required.size}\n`);
