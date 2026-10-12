#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ts = createRequire(path.join(root, 'src/frontend/package.json'))('typescript');
const storeFile = 'src/frontend/src/locales/localeDomainBundleStore.ts';
// Supported original leafKind/FNV algorithm, canonicalized by the compiler printer.
// This is a producer compatibility guard, not a release SOURCE-authority registration.
const supportedAlgorithm = '52736241ae9f8104f5b1437744b33df1a601474ce9b4283758e31557e14eefc7';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const fail = reason =>
{
    throw new Error(`locale-domain-schema-source:${reason}`);
};

function unwrap(node)
{
    while (node && (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)))
    {
        node = node.expression;
    }
    return node;
}

function parse(file, source)
{
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    if (tree.parseDiagnostics.length)
    {
        fail(`syntax:${file}`);
    }
    return tree;
}

function declaration(tree, name)
{
    const matches = tree.statements.flatMap(node => ts.isVariableStatement(node)
        ? [...node.declarationList.declarations] : []).filter(node => ts.isIdentifier(node.name) && node.name.text === name);
    if (matches.length !== 1 || !matches[0].initializer)
    {
        fail(`missing-or-ambiguous-declaration:${name}`);
    }
    return matches[0];
}

/** Interpret the supported literal locale module grammar without evaluating its source. */
export function literalLocaleSchema(source, exportName, identity)
{
    const tree = parse('<literal-locale-source>', source);
    for (const statement of tree.statements)
    {
        if (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly)
        {
            continue;
        }
        if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)
            || !statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
            || statement.declarationList.declarations.some(node => !ts.isIdentifier(node.name)
                || ![exportName, 'localeDomainIdentity'].includes(node.name.text)))
        {
            fail('unsupported-locale-module-statement');
        }
    }
    const actual = literalValue(objectInitializer(declaration(tree, 'localeDomainIdentity').initializer));
    if (Object.keys(actual).sort().join(',') !== 'domain,locale'
        || actual.locale !== identity.locale || actual.domain !== identity.domain)
    {
        fail('locale-module-identity-mismatch');
    }
    return literalShape(literalValue(declaration(tree, exportName).initializer));
}

function objectInitializer(node)
{
    node = unwrap(node);
    if (node && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.expression.getText() === 'Object' && node.expression.name.text === 'freeze'
        && node.arguments.length === 1)
    {
        node = unwrap(node.arguments[0]);
    }
    if (!node || !ts.isObjectLiteralExpression(node))
    {
        fail('expected-literal-object');
    }
    return node;
}

function properties(node)
{
    const result = new Map();
    for (const property of node.properties)
    {
        if (!ts.isPropertyAssignment(property)
            || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)))
        {
            fail('unsupported-property-expression');
        }
        const key = property.name.text;
        if (key === '__proto__' || result.has(key))
        {
            fail(`duplicate-or-prototype-key:${key}`);
        }
        result.set(key, property.initializer);
    }
    return result;
}

function literalValue(node)
{
    node = unwrap(node);
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)))
    {
        return node.text;
    }
    if (!node || !ts.isObjectLiteralExpression(node))
    {
        fail('unsupported-locale-value-expression');
    }
    const result = Object.create(null);
    for (const [key, value] of properties(node))
    {
        result[key] = literalValue(value);
    }
    return result;
}

// Static interpretation of the supported original leafKind algorithm on literal data.
// No TS module, function excerpt, eval or dynamic import is executed.
function literalShape(value)
{
    if (typeof value === 'string')
    {
        return 'string';
    }
    if (value.kind === 'plural' && value.forms && typeof value.forms === 'object')
    {
        return 'plural';
    }
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${literalShape(value[key])}`).join(',')}}`;
}

function algorithm(tree)
{
    const functions = tree.statements.filter(node => ts.isFunctionDeclaration(node)
        && ['leafKind', 'localeDomainSchemaDigest'].includes(node.name?.text));
    const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
    const canonical = functions.map(node => printer.printNode(ts.EmitHint.Unspecified, node, tree)).join('\n');
    if (functions.length !== 2 || sha256(canonical) !== supportedAlgorithm)
    {
        fail('original-calculation-algorithm-drift');
    }
    // Read constants from the original validated function AST, not a replacement hash table.
    const constants = [];
    const visit = node =>
    {
        if (ts.isBigIntLiteral(node))
        {
            constants.push(BigInt(node.text.slice(0, -1)));
        }
        ts.forEachChild(node, visit);
    };
    visit(functions.find(node => node.name.text === 'localeDomainSchemaDigest'));
    if (constants.length !== 2)
    {
        fail('original-calculation-constants');
    }
    return { identity: sha256(canonical), seed: constants[0], multiplier: constants[1] };
}

/** Refuse unsupported changes to the existing application's original calculation source. */
export function assertLocaleSchemaAlgorithm(source)
{
    return algorithm(parse(storeFile, source));
}

function digest(shape, original)
{
    let hash = original.seed;
    for (let index = 0; index < shape.length; index++)
    {
        hash ^= BigInt(shape.charCodeAt(index));
        hash = BigInt.asUintN(64, hash * original.multiplier);
    }
    return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

/** Derive one application domain from the canonical catalog and all literal locale schemas. */
export function deriveLocaleDomainSchema(domain)
{
    const inputs = [];
    const read = file =>
    {
        const absolute = path.join(root, file);
        if (!lstatSync(absolute).isFile() || lstatSync(absolute).isSymbolicLink())
        {
            fail(`non-regular-source:${file}`);
        }
        const source = readFileSync(absolute, 'utf8');
        inputs.push({ path: file, sha256: sha256(source), source });
        return source;
    };
    const catalog = JSON.parse(read('src/shared/Contracts/Localization/locale-catalog.json'));
    const locales = catalog.locales.filter(locale => locale.status === 'enabled').map(locale => locale.code);
    if (!locales.length || new Set(locales).size !== locales.length || !locales.includes(catalog.defaultCode)
        || locales.some(locale => typeof locale !== 'string' || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})+$/u.test(locale)))
    {
        fail('invalid-canonical-catalog');
    }
    const storeSource = read(storeFile);
    const tree = parse(storeFile, storeSource);
    const original = algorithm(tree);
    const exports = properties(objectInitializer(declaration(tree, 'EXPORT_NAMES').initializer));
    const entries = properties(objectInitializer(declaration(tree, 'LOCALE_DOMAIN_SCHEMA_DIGESTS').initializer));
    if (!exports.has(domain) || !entries.has(domain))
    {
        fail('unknown-domain');
    }
    const exportName = literalValue(exports.get(domain));
    const entry = entries.get(domain);
    if (typeof exportName !== 'string' || !ts.isStringLiteral(entry))
    {
        fail('nonliteral-domain-mapping');
    }
    let canonicalShape;
    const schemas = locales.map(locale =>
    {
        const file = `src/frontend/src/locales/${locale}/${domain}.ts`;
        const shape = literalLocaleSchema(read(file), exportName, { locale, domain });
        if (canonicalShape === undefined)
        {
            canonicalShape = shape;
        }
        else if (shape !== canonicalShape)
        {
            fail(`locale-schema-mismatch:${locale}:${domain}`);
        }
        return { locale, path: file, shapeSha256: sha256(shape), schemaDigest: digest(shape, original) };
    });
    const expected = schemas[0].schemaDigest;
    const replacement = `${storeSource.slice(0, entry.getStart(tree))}'${expected}'${storeSource.slice(entry.getEnd())}`;
    return {
        domain,
        before: entry.text,
        derived: expected,
        algorithmAstSha256: original.identity,
        canonicalShapeSha256: sha256(canonicalShape),
        schemas,
        inputs,
        output: { path: storeFile, sha256: sha256(replacement), source: replacement }
    };
}

function main()
{
    const [mode, flag, domain] = process.argv.slice(2);
    if (process.argv.length !== 5 || !['--check', '--write'].includes(mode) || flag !== '--domain')
    {
        fail('usage: node tools/frontend/sync-locale-domain-schema.mjs --check|--write --domain <domain>');
    }
    const derived = deriveLocaleDomainSchema(domain);
    const matches = derived.before === derived.derived;
    if (mode === '--write' && !matches)
    {
        // Recheck observed source inputs before this normal isolated source update.
        // This is not a tamper/race/qualification claim or a frozen-authority refresh.
        for (const input of derived.inputs)
        {
            if (readFileSync(path.join(root, input.path), 'utf8') !== input.source)
            {
                fail(`source-changed-before-write:${input.path}`);
            }
        }
        writeFileSync(path.join(root, derived.output.path), derived.output.source);
    }
    const { inputs, output, ...facts } = derived;
    const report = {
        scope: 'literal source AST only; no product import/runtime/test/list; no authority/fixture/receipt refresh',
        mode,
        status: matches || mode === '--write' ? 'PASS' : 'FAIL',
        changed: mode === '--write' && !matches,
        ...facts,
        inputs: inputs.map(input => ({ path: input.path, sha256: input.sha256 })),
        output: { path: output.path, sha256: output.sha256 }
    };
    console.log(JSON.stringify(report, null, 4));
    process.exitCode = report.status === 'PASS' ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main();
}
