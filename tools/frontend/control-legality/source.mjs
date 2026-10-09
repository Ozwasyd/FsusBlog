import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export const controlRegistryPath = 'config/frontend/control-legality.json';
export const controlLegalityVersion = 'fsusblog.control-legality.v1';
const packageId = '@ozwasyd/element-plus';
const sourceExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.d.ts', '.mts', '.d.mts'];
const nativeControls = new Set(['button', 'input', 'textarea', 'select', 'option', 'details', 'summary', 'a', 'audio', 'video']);
const interactiveRoles = new Set(['button', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'option', 'slider', 'spinbutton', 'dialog', 'listbox', 'treeitem', 'combobox', 'textbox']);
const genericApi = new Set(['items', 'modelValue', 'disabled', 'size', 'type', 'loading', 'icon', 'selected', 'open']);
const categories = new Set(['composition', 'semantic-native', 'browser-native-bridge', 'framework-bridge', 'capability-gap']);
const entryFields = ['schema', 'id', 'path', 'identity', 'sourceLocation', 'classification', 'productSemantics', 'fsusUiPrimitives', 'reason', 'owner', 'allowedResponsibilities', 'forbiddenGenericResponsibilities', 'requiredTestIds', 'upstreamIssue', 'reviewAfter', 'removalCondition', 'contentDigest'];

function canonical(value)
{
    return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
}

export function controlDigest(value)
{
    return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('hex');
}

function fail(message)
{
    throw new Error(`[control-legality] ${message}`);
}

function pascal(value)
{
    return value.split('-').map((part) => part[0]?.toUpperCase() + part.slice(1)).join('');
}

function locate(source, offset)
{
    const prefix = source.slice(0, offset).split('\n');
    return { offset, line: prefix.length, column: prefix.at(-1).length + 1 };
}

function exactFile(base)
{
    for (const candidate of [base, ...sourceExtensions.map((extension) => base + extension),
        ...sourceExtensions.map((extension) => path.join(base, 'index' + extension))])
    {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile())
        {
            return fs.realpathSync(candidate);
        }
    }
    const metadataPath = path.join(base, 'package.json');
    if (fs.existsSync(metadataPath))
    {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        const entry = metadata.exports?.['.'];
        const target = typeof entry === 'string' ? entry : entry?.types ?? metadata.types ?? entry?.import ?? metadata.module ?? metadata.main;
        if (target)
        {
            return exactFile(path.join(base, target));
        }
    }
    fail(`unresolved module ${base}`);
}

/** Resolves declarations from actual imports and public entry points, never tag prefixes. */
export function createControlSourceResolver({ repositoryRoot, fsusUIRoot, mode = 'local', parserRoot = repositoryRoot })
{
    const require = createRequire(path.join(parserRoot, 'src/frontend/package.json'));
    const ts = require('typescript');
    const sfc = require('@vue/compiler-sfc');
    const dom = require('@vue/compiler-dom');
    const src = path.join(repositoryRoot, 'src/frontend/src');
    const publicRoot = mode === 'local' ? path.join(fsusUIRoot, 'vue/packages/element-plus')
        : path.join(repositoryRoot, 'src/frontend/node_modules/@ozwasyd/element-plus');
    if (!fs.existsSync(publicRoot))
    {
        fail(`${mode} public package unavailable: ${publicRoot}`);
    }
    const metadata = JSON.parse(fs.readFileSync(path.join(publicRoot, 'package.json'), 'utf8'));
    if (mode === 'published' && (metadata.name !== packageId || fs.realpathSync(publicRoot) !== path.resolve(publicRoot)))
    {
        fail('published package identity is not the genuine installed package');
    }
    const parsed = new Map();
    const exported = new Map();
    const publicNames = new Map();
    const resolutionInputs = [];
    let upstreamPaths = [];
    if (mode === 'local')
    {
        const configFile = path.join(fsusUIRoot, 'vue/tsconfig.base.json');
        const config = ts.readConfigFile(configFile, (file) => fs.readFileSync(file, 'utf8'));
        if (config.error || config.config.extends)
        {
            fail('unresolved FsusUI source path configuration');
        }
        resolutionInputs.push({ path: configFile, digest: controlDigest(fs.readFileSync(configFile, 'utf8')) });
        upstreamPaths = Object.entries(config.config.compilerOptions?.paths ?? {})
            .sort(([left], [right]) => right.replace('*', '').length - left.replace('*', '').length)
            .map(([pattern, targets]) => ({ pattern, targets,
                base: path.resolve(path.dirname(configFile), config.config.compilerOptions?.baseUrl ?? '.') }));
    }
    const vueRuntime = require('vue');
    const upstreamIdentity = () =>
    {
        if (mode !== 'local')
        {
            return { kind: 'installed-public-package', version: metadata.version, packageDigest: controlDigest(metadata) };
        }
        const git = (args) =>
        {
            const result = spawnSync('git', args, { cwd: fsusUIRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
            if (result.status !== 0)
            {
                fail('local FsusUI git identity unavailable');
            }
            return result.stdout.trim();
        };
        return { kind: 'local-source', commit: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}']),
            diffDigest: controlDigest(git(['diff', '--binary', '--no-ext-diff', 'HEAD', '--'])) };
    };
    const initialUpstreamIdentity = upstreamIdentity();
    const modulePath = (specifier, importer, upstream = false) =>
    {
        if (specifier.startsWith('@/'))
        {
            return exactFile(path.join(src, specifier.slice(2)));
        }
        if (specifier.startsWith('.'))
        {
            return exactFile(path.resolve(path.dirname(importer), specifier));
        }
        if (specifier === packageId || specifier.startsWith(packageId + '/'))
        {
            const subpath = specifier.slice(packageId.length);
            const contract = metadata.exports?.[subpath ? '.' + subpath : '.'];
            if (!contract || subpath.startsWith('/es') || subpath.startsWith('/lib'))
            {
                fail(`private or absent public entry ${specifier}`);
            }
            return exactFile(path.join(publicRoot, mode === 'local' ? (subpath ? subpath.slice(1) + '.ts' : 'index.ts')
                : (typeof contract === 'string' ? contract : contract.types ?? contract.import)));
        }
        if (upstream && mode === 'local' && specifier.startsWith('@element-plus/'))
        {
            for (const { pattern, targets, base } of upstreamPaths)
            {
                const wildcard = pattern.indexOf('*');
                const matches = wildcard < 0 ? pattern === specifier
                    : specifier.startsWith(pattern.slice(0, wildcard)) && specifier.endsWith(pattern.slice(wildcard + 1));
                if (!matches)
                {
                    continue;
                }
                if (!Array.isArray(targets) || targets.length !== 1 || typeof targets[0] !== 'string')
                {
                    fail(`ambiguous FsusUI source alias ${specifier}`);
                }
                const capture = wildcard < 0 ? '' : specifier.slice(wildcard, specifier.length - (pattern.length - wildcard - 1));
                return exactFile(path.resolve(base, targets[0].replace('*', capture)));
            }
            fail(`absent FsusUI source alias ${specifier}`);
        }
        return { package: specifier };
    };
    const parseScript = (content, file) =>
    {
        const ast = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true,
            file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
        if (ast.parseDiagnostics.length)
        {
            fail(`${file}: TypeScript parser failure: ${ast.parseDiagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join('; ')}`);
        }
        return ast;
    };
    const parse = (file) =>
    {
        if (parsed.has(file))
        {
            return parsed.get(file);
        }
        const content = fs.readFileSync(file, 'utf8');
        let scripts;
        let template = null;
        if (file.endsWith('.vue'))
        {
            const result = sfc.parse(content, { filename: file });
            if (result.errors.length)
            {
                fail(`${file}: Vue parser failure: ${result.errors.map(String).join('; ')}`);
            }
            if (result.descriptor.template?.src || result.descriptor.template?.lang)
            {
                fail(`${file}: unsupported external/non-HTML template`);
            }
            scripts = [result.descriptor.script, result.descriptor.scriptSetup].filter(Boolean).map((block) =>
            {
                if (block.src)
                {
                    fail(`${file}: unresolved external script`);
                }
                return { ast: parseScript(block.content, file + (block.lang === 'tsx' ? '.tsx' : '.ts')),
                    offset: block.loc.start.offset };
            });
            if (result.descriptor.template)
            {
                const block = result.descriptor.template;
                const compiled = sfc.compileTemplate({ source: block.content, filename: file, id: controlDigest(file),
                    compilerOptions: { expressionPlugins: ['typescript'] } });
                if (compiled.errors.length)
                {
                    fail(`${file}: template expression parser failure: ${compiled.errors.map(String).join('; ')}`);
                }
                template = { ast: dom.parse(block.content), offset: block.loc.start.offset };
            }
        }
        else
        {
            scripts = [{ ast: parseScript(content, file), offset: 0 }];
        }
        const imports = new Map();
        const variables = new Map();
        const registrations = new Map();
        for (const { ast } of scripts)
        {
            const visit = (node) =>
            {
                if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !node.importClause?.isTypeOnly)
                {
                    const specifier = node.moduleSpecifier.text;
                    if (node.importClause?.name)
                    {
                        imports.set(node.importClause.name.text, { specifier, name: 'default' });
                    }
                    const bindings = node.importClause?.namedBindings;
                    if (bindings && ts.isNamedImports(bindings))
                    {
                        for (const entry of bindings.elements.filter((entry) => !entry.isTypeOnly))
                        {
                            imports.set(entry.name.text, { specifier, name: (entry.propertyName ?? entry.name).text });
                        }
                    }
                    else if (bindings && ts.isNamespaceImport(bindings))
                    {
                        imports.set(bindings.name.text, { specifier, name: '*' });
                    }
                }
                if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
                {
                    variables.set(node.name.text, node.initializer);
                }
                if (file.startsWith(src + path.sep) && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
                    && node.expression.name.text === 'component')
                {
                    const [name, component] = node.arguments;
                    if (!name || !ts.isStringLiteral(name) || !component)
                    {
                        fail(`${file}: unresolvable global component registration`);
                    }
                    registrations.set(name.text, component);
                }
                ts.forEachChild(node, visit);
            };
            visit(ast);
        }
        const result = { file, content, scripts, template, imports, variables, registrations };
        parsed.set(file, result);
        return result;
    };
    const exportsOf = (file, visiting = new Set()) =>
    {
        if (exported.has(file))
        {
            return exported.get(file);
        }
        if (visiting.has(file))
        {
            return new Map();
        }
        const next = new Set([...visiting, file]);
        const result = new Map();
        const record = parse(file);
        const set = (name, origin) =>
        {
            if (result.has(name) && JSON.stringify(result.get(name)) !== JSON.stringify(origin))
            {
                result.set(name, { ambiguous: true, file, name });
            }
            else
            {
                result.set(name, origin);
            }
        };
        for (const { ast } of record.scripts)
        {
            for (const statement of ast.statements)
            {
                if (ts.isExportDeclaration(statement) && !statement.isTypeOnly)
                {
                    const target = statement.moduleSpecifier ? modulePath(statement.moduleSpecifier.text, file, file.startsWith(publicRoot)
                        || (mode === 'local' && file.startsWith(path.join(fsusUIRoot, 'vue'))))
                        : file;
                    const origins = statement.moduleSpecifier && typeof target === 'string' ? exportsOf(target, next) : new Map();
                    if (!statement.exportClause)
                    {
                        for (const [name, origin] of origins)
                        {
                            if (name !== 'default')
                            {
                                set(name, origin);
                            }
                        }
                    }
                    else if (ts.isNamedExports(statement.exportClause))
                    {
                        for (const entry of statement.exportClause.elements.filter((entry) => !entry.isTypeOnly))
                        {
                            const name = (entry.propertyName ?? entry.name).text;
                            let origin = origins.get(name);
                            if (!statement.moduleSpecifier)
                            {
                                const imported = record.imports.get(name);
                                if (imported)
                                {
                                    const source = modulePath(imported.specifier, file, mode === 'local' && file.startsWith(path.join(fsusUIRoot, 'vue')));
                                    origin = typeof source === 'string' ? exportsOf(source, next).get(imported.name) : { package: source.package, name: imported.name };
                                }
                                else
                                {
                                    origin = { file, name };
                                }
                            }
                            set(entry.name.text, origin ?? { file: typeof target === 'string' ? target : null, name, unresolved: true });
                        }
                    }
                }
                else if (ts.isExportAssignment(statement))
                {
                    set('default', { file, name: ts.isIdentifier(statement.expression) ? statement.expression.text : 'default' });
                }
                else if (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
                {
                    if (ts.isVariableStatement(statement))
                    {
                        for (const declaration of statement.declarationList.declarations)
                        {
                            if (ts.isIdentifier(declaration.name))
                            {
                                set(declaration.name.text, { file, name: declaration.name.text });
                            }
                        }
                    }
                    else if (statement.name && !ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement))
                    {
                        set(statement.name.text, { file, name: statement.name.text });
                    }
                }
            }
        }
        if (file.endsWith('.vue') && !result.has('default'))
        {
            result.set('default', { file, name: 'default', component: true });
        }
        exported.set(file, result);
        return result;
    };
    const publicIdentity = (specifier, name) =>
    {
        const entry = modulePath(specifier, path.join(src, 'main.ts'));
        const key = specifier + '#' + name;
        if (!publicNames.has(key))
        {
            const origin = exportsOf(entry).get(name);
            if (!origin || origin.ambiguous || origin.unresolved)
            {
                fail(`unresolved public export ${key}`);
            }
            const owningRoot = mode === 'local' ? path.join(fsusUIRoot, 'vue') : publicRoot;
            if (!origin.file || !origin.file.startsWith(owningRoot + path.sep))
            {
                fail(`public export ${key} resolves outside FsusUI ownership`);
            }
            publicNames.set(key, { kind: 'fsusui-public', package: packageId, entry: specifier,
                publicName: name, definition: origin.file, exportName: origin.name });
        }
        return publicNames.get(key);
    };
    const resolveExport = (file, name, seen = new Set()) =>
    {
        const key = file + '#' + name;
        if (seen.has(key))
        {
            fail(`cyclic component source ${key}`);
        }
        const next = new Set([...seen, key]);
        const record = parse(file);
        const exportedSource = exportsOf(file).get(name);
        if (exportedSource?.ambiguous || exportedSource?.unresolved)
        {
            fail(`ambiguous/unresolved component export ${key}`);
        }
        for (const { ast } of record.scripts)
        {
            for (const statement of ast.statements)
            {
                if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.moduleSpecifier)
                {
                    const entries = statement.exportClause && ts.isNamedExports(statement.exportClause)
                        ? statement.exportClause.elements.filter((entry) => !entry.isTypeOnly && entry.name.text === name) : [];
                    for (const entry of entries)
                    {
                        return resolveImport(file, { specifier: statement.moduleSpecifier.text,
                            name: (entry.propertyName ?? entry.name).text }, next);
                    }
                    if (!statement.exportClause)
                    {
                        const target = modulePath(statement.moduleSpecifier.text, file);
                        if (typeof target === 'string' && exportsOf(target).has(name))
                        {
                            return resolveExport(target, name, next);
                        }
                    }
                }
            }
        }
        if (record.imports.has(name))
        {
            return resolveImport(file, record.imports.get(name), next);
        }
        const value = record.variables.get(name);
        if (value && ts.isIdentifier(value))
        {
            const sources = resolveExpression(file, value, next);
            if (sources.length === 1)
            {
                return sources[0];
            }
        }
        return { kind: 'local', file, name };
    };
    const resolveImport = (file, imported, seen = new Set()) =>
    {
        if (imported.specifier === packageId || imported.specifier.startsWith(packageId + '/'))
        {
            return publicIdentity(imported.specifier, imported.name);
        }
        const target = modulePath(imported.specifier, file, mode === 'local' && file.startsWith(path.join(fsusUIRoot, 'vue') + path.sep));
        if (imported.specifier === 'vue' && ['Transition', 'TransitionGroup', 'Teleport', 'KeepAlive', 'Suspense', 'Fragment'].includes(imported.name)
            && Object.hasOwn(vueRuntime, imported.name))
        {
            return { kind: 'framework-structure', package: 'vue', publicName: imported.name };
        }
        return typeof target === 'string' ? resolveExport(target, imported.name, seen)
            : { kind: 'external', package: target.package, publicName: imported.name };
    };
    // A declared prop is an input edge, never a component identity by itself.
    const unwrap = (node) =>
    {
        while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)))
        {
            node = node.expression;
        }
        return node;
    };
    // A factory result is proved from its lexical construction, not its name.
    // This bounded case describes a slot-only render source; it grants no
    // public identity or exemption to a local wrapper or lifecycle behavior.
    const resolveFactoryComponent = (file, name, seen = new Set()) =>
    {
        const identity = `${file}#${name}`;
        if (seen.has(identity))
        {
            fail(`cyclic factory binding ${identity}`);
        }
        const next = new Set([...seen, identity]);
        const record = parse(file);
        function readonlyBinding(owner, symbol)
        {
            let written = false;
            function rootName(node)
            {
                node = unwrap(node);
                while (node && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)))
                {
                    node = unwrap(node.expression);
                }
                return node && ts.isIdentifier(node) ? node.text : null;
            }
            function visit(node)
            {
                if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
                    && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && rootName(node.left) === symbol)
                {
                    written = true;
                }
                if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
                    && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) && rootName(node.operand) === symbol)
                {
                    written = true;
                }
                if (ts.isDeleteExpression(node) && rootName(node.expression) === symbol)
                {
                    written = true;
                }
                ts.forEachChild(node, visit);
            }
            parse(owner).scripts.forEach(({ ast }) => visit(ast));
            if (written)
            {
                fail(`mutated factory binding ${owner}#${symbol}`);
            }
        }
        const origin = exportsOf(file).get(name);
        if (origin?.ambiguous || origin?.unresolved)
        {
            fail(`ambiguous factory binding ${identity}`);
        }
        if (origin && (origin.file !== file || origin.name !== name))
        {
            return resolveFactoryComponent(origin.file, origin.name, next);
        }
        const declarations = record.scripts.flatMap(({ ast }) => ast.statements.filter(ts.isVariableStatement)
            .flatMap((statement) => [...statement.declarationList.declarations]));
        const bindings = declarations.filter((declaration) => ts.isObjectBindingPattern(declaration.name)
            && declaration.name.elements.some((entry) => ts.isIdentifier(entry.name) && entry.name.text === name));
        if (!bindings.length)
        {
            return null;
        }
        if (bindings.length !== 1)
        {
            fail(`ambiguous factory construction ${identity}`);
        }
        const binding = bindings[0];
        if (!(binding.parent.flags & ts.NodeFlags.Const) || binding.name.elements.some((entry) => entry.dotDotDotToken
            || entry.initializer || !ts.isIdentifier(entry.name) || (entry.propertyName && !ts.isIdentifier(entry.propertyName))))
        {
            fail(`dynamic factory destructuring ${identity}`);
        }
        const selected = binding.name.elements.find((entry) => entry.name.text === name);
        readonlyBinding(file, name);
        const property = (selected.propertyName ?? selected.name).text;
        const call = unwrap(binding.initializer);
        if (!call || !ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.arguments.some(ts.isSpreadElement))
        {
            fail(`unknown factory call ${identity}`);
        }
        function functionSource(owner, symbol, visited = new Set())
        {
            const key = `${owner}#${symbol}`;
            if (visited.has(key))
            {
                fail(`cyclic factory function ${key}`);
            }
            visited.add(key);
            const current = parse(owner);
            readonlyBinding(owner, symbol);
            const exported = exportsOf(owner).get(symbol);
            if (exported?.ambiguous || exported?.unresolved)
            {
                fail(`unknown factory function ${key}`);
            }
            if (exported && (exported.file !== owner || exported.name !== symbol))
            {
                return functionSource(exported.file, exported.name, visited);
            }
            const imported = current.imports.get(symbol);
            if (imported)
            {
                const target = modulePath(imported.specifier, owner, mode === 'local' && owner.startsWith(path.join(fsusUIRoot, 'vue') + path.sep));
                if (typeof target !== 'string')
                {
                    fail(`unknown external factory ${key}`);
                }
                return functionSource(target, imported.name, visited);
            }
            const matches = current.scripts.flatMap(({ ast }) => ast.statements.flatMap((statement) =>
                ts.isFunctionDeclaration(statement) && statement.name?.text === symbol ? [statement]
                    : ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const)
                        ? statement.declarationList.declarations.filter((entry) => ts.isIdentifier(entry.name) && entry.name.text === symbol).map((entry) => unwrap(entry.initializer)) : []));
            if (matches.length !== 1 || !matches[0] || !(ts.isArrowFunction(matches[0]) || ts.isFunctionExpression(matches[0]) || ts.isFunctionDeclaration(matches[0])))
            {
                fail(`unknown factory definition ${key}`);
            }
            return { file: owner, record: current, fn: matches[0] };
        }
        const factory = functionSource(file, call.expression.text);
        const fn = factory.fn;
        const values = new Map();
        const unknown = Symbol('unknown-factory-value');
        function literal(node, bindings)
        {
            node = unwrap(node);
            if (!node)
            {
                return unknown;
            }
            if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
            {
                return node.text;
            }
            if (ts.isNumericLiteral(node))
            {
                return Number(node.text);
            }
            if ([ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind))
            {
                return node.kind === ts.SyntaxKind.NullKeyword ? null : node.kind === ts.SyntaxKind.TrueKeyword;
            }
            if (ts.isIdentifier(node))
            {
                return bindings.has(node.text) ? bindings.get(node.text) : unknown;
            }
            if (ts.isTemplateExpression(node))
            {
                let result = node.head.text;
                for (const span of node.templateSpans)
                {
                    const value = literal(span.expression, bindings);
                    if (value === unknown)
                    {
                        return unknown;
                    }
                    result += String(value) + span.literal.text;
                }
                return result;
            }
            return unknown;
        }
        const args = call.arguments.map((argument) => literal(argument, new Map()));
        if (args.some((value) => value === unknown) || fn.parameters.length !== args.length
            || fn.parameters.some((parameter) => !ts.isIdentifier(parameter.name) || parameter.initializer || parameter.dotDotDotToken)
            || !fn.body || !ts.isBlock(fn.body) || fn.asteriskToken
            || fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword))
        {
            fail(`dynamic factory arguments or flow ${identity}`);
        }
        fn.parameters.forEach((parameter, index) => values.set(parameter.name.text, args[index]));
        const locals = new Map();
        const statements = [...fn.body.statements];
        const returned = statements.pop();
        if (!returned || !ts.isReturnStatement(returned) || !returned.expression
            || statements.some((statement) => !ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)))
        {
            fail(`unknown factory return flow ${identity}`);
        }
        function vueCall(node, api)
        {
            const actual = ts.isCallExpression(node) && ts.isIdentifier(node.expression)
                && factory.record.imports.get(node.expression.text)?.specifier === 'vue'
                && factory.record.imports.get(node.expression.text)?.name === api && !factory.record.variables.has(node.expression.text)
                && !locals.has(node.expression.text) && !values.has(node.expression.text);
            if (actual)
            {
                readonlyBinding(factory.file, node.expression.text);
            }
            return actual;
        }
        for (const statement of statements)
        {
            for (const declaration of statement.declarationList.declarations)
            {
                if (!ts.isIdentifier(declaration.name) || !declaration.initializer || locals.has(declaration.name.text) || values.has(declaration.name.text))
                {
                    fail(`unknown factory local ${identity}`);
                }
                const node = unwrap(declaration.initializer);
                const value = literal(node, values);
                const symbol = ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Symbol'
                    && !factory.record.imports.has('Symbol') && !factory.record.variables.has('Symbol') && !values.has('Symbol')
                    && node.arguments.length === 1 && literal(node.arguments[0], values) !== unknown;
                if (value === unknown && !symbol && !vueCall(node, 'defineComponent'))
                {
                    fail(`unknown factory initializer ${identity}`);
                }
                locals.set(declaration.name.text, node);
                if (value !== unknown)
                {
                    values.set(declaration.name.text, value);
                }
            }
        }
        const result = unwrap(returned.expression);
        if (!ts.isObjectLiteralExpression(result) || result.properties.some((entry) => !(ts.isPropertyAssignment(entry) || ts.isShorthandPropertyAssignment(entry))
            || !ts.isIdentifier(entry.name) || !ts.isIdentifier(ts.isShorthandPropertyAssignment(entry) ? entry.name : unwrap(entry.initializer))
            || !locals.has((ts.isShorthandPropertyAssignment(entry) ? entry.name : unwrap(entry.initializer)).text)))
        {
            fail(`unknown factory result ${identity}`);
        }
        const fields = result.properties.filter((entry) => entry.name.text === property);
        if (new Set(result.properties.map((entry) => entry.name.text)).size !== result.properties.length || fields.length !== 1)
        {
            fail(`ambiguous factory result field ${identity}`);
        }
        const value = ts.isShorthandPropertyAssignment(fields[0]) ? fields[0].name : unwrap(fields[0].initializer);
        const component = ts.isIdentifier(value) ? locals.get(value.text) : null;
        const options = component && vueCall(component, 'defineComponent') && component.arguments.length === 1 ? unwrap(component.arguments[0]) : null;
        if (!options || !ts.isObjectLiteralExpression(options) || options.properties.some((entry) => !(ts.isPropertyAssignment(entry) || ts.isShorthandPropertyAssignment(entry) || ts.isMethodDeclaration(entry))
            || !ts.isIdentifier(entry.name) || !['name', 'inheritAttrs', 'setup'].includes(entry.name.text))
            || new Set(options.properties.map((entry) => entry.name.text)).size !== options.properties.length)
        {
            fail(`unknown factory component ${identity}`);
        }
        const setup = options.properties.find((entry) => entry.name.text === 'setup');
        const inheritAttrs = options.properties.find((entry) => entry.name.text === 'inheritAttrs');
        const componentName = options.properties.find((entry) => entry.name.text === 'name');
        const nameValue = componentName && (ts.isShorthandPropertyAssignment(componentName) ? componentName.name : componentName.initializer);
        if (!setup || !ts.isMethodDeclaration(setup) || !setup.body || setup.parameters.length !== 2
            || !ts.isIdentifier(setup.parameters[0].name) || !ts.isObjectBindingPattern(setup.parameters[1].name)
            || setup.asteriskToken || setup.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
            || setup.parameters.some((parameter) => parameter.initializer || parameter.dotDotDotToken)
            || inheritAttrs?.initializer?.kind !== ts.SyntaxKind.FalseKeyword
            || !componentName || literal(nameValue, values) === unknown)
        {
            fail(`unknown factory setup ${identity}`);
        }
        const slots = setup.parameters[1].name.elements.filter((entry) => (entry.propertyName ?? entry.name).getText() === 'slots'
            && ts.isIdentifier(entry.name) && !entry.initializer && !entry.dotDotDotToken);
        const setupStatements = [...setup.body.statements];
        const renderReturn = setupStatements.pop();
        const render = renderReturn && ts.isReturnStatement(renderReturn) ? unwrap(renderReturn.expression) : null;
        const output = render && ts.isArrowFunction(render) && !render.parameters.length
            && !render.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ? unwrap(render.body) : null;
        const target = output && ts.isCallExpression(output) && !output.arguments.length ? unwrap(output.expression) : null;
        const slotName = slots[0]?.name.text;
        let slotReferences = 0;
        function inspect(node)
        {
            if (ts.isIdentifier(node) && node.text === slotName)
            {
                slotReferences++;
            }
            ts.forEachChild(node, inspect);
        }
        inspect(setup.body);
        if (slots.length !== 1 || !target || !ts.isPropertyAccessExpression(target) || target.name.text !== 'default'
            || !ts.isIdentifier(target.expression) || target.expression.text !== slotName || slotReferences !== 1 || setup.parameters[0].name.text === slotName
            || setupStatements.some((statement) => !ts.isVariableStatement(statement) && !ts.isExpressionStatement(statement)))
        {
            fail(`unknown factory render source ${identity}`);
        }
        return { kind: 'factory-slot-source', callFile: file, callOffset: call.getStart(), callDigest: controlDigest(call.getText()),
            bindingOffset: binding.getStart(), bindingDigest: controlDigest(binding.getText()), callFileDigest: controlDigest(record.content),
            factoryFile: factory.file, factoryOffset: fn.getStart(), factoryDigest: controlDigest(fn.getText()), arguments: args, property,
            factoryFileDigest: controlDigest(factory.record.content),
            componentOffset: component.getStart(), componentDigest: controlDigest(component.getText()),
            componentName: literal(nameValue, values), renderOffset: output.getStart(), renderDigest: controlDigest(output.getText()), slot: 'default' };
    };
    const objectProperty = (node, name) =>
    {
        node = unwrap(node);
        if (!node || !ts.isObjectLiteralExpression(node))
        {
            return null;
        }
        for (const property of [...node.properties].reverse())
        {
            if (!property.name || ts.isComputedPropertyName(property.name))
            {
                return null;
            }
            if (property.name.getText().replaceAll("'", '').replaceAll('"', '') === name)
            {
                return ts.isPropertyAssignment(property) ? property.initializer : property;
            }
        }
        return null;
    };
    const componentProps = (file) =>
    {
        const record = parse(file);
        if (!record.imports.has('defineProps') && !record.variables.has('defineProps'))
        {
            const declarations = [...record.variables].filter(([, value]) => ts.isCallExpression(value)
                && ts.isIdentifier(value.expression) && value.expression.text === 'defineProps');
            if (declarations.length === 1 && declarations[0][1].arguments.length === 1)
            {
                return { node: declarations[0][1].arguments[0], file, propsName: declarations[0][0], attrsName: '$attrs' };
            }
        }
        for (const { ast } of record.scripts)
        {
            for (const statement of ast.statements.filter(ts.isExportAssignment))
            {
                const value = unwrap(statement.expression);
                const imported = value && ts.isCallExpression(value) && ts.isIdentifier(value.expression)
                    ? record.imports.get(value.expression.text) : null;
                if (imported?.specifier !== 'vue' || imported.name !== 'defineComponent' || value.arguments.length !== 1)
                {
                    continue;
                }
                const node = objectProperty(value.arguments[0], 'props');
                const setup = objectProperty(value.arguments[0], 'setup');
                const propsName = setup?.parameters?.[0]?.name;
                const context = setup?.parameters?.[1]?.name;
                const attrs = context && ts.isObjectBindingPattern(context) ? context.elements.find((entry) =>
                    (entry.propertyName ?? entry.name).getText() === 'attrs' && ts.isIdentifier(entry.name)) : null;
                if (node)
                {
                    return { node, file, propsName: propsName && ts.isIdentifier(propsName) ? propsName.text : null,
                        attrsName: attrs?.name.text ?? null };
                }
            }
        }
        return null;
    };
    const componentPropDeclaration = (file, name) =>
    {
        const props = componentProps(file);
        const find = (node, owner, seen = new Set()) =>
        {
            node = unwrap(node);
            if (!node)
            {
                return null;
            }
            if (ts.isIdentifier(node))
            {
                const key = `${owner}#${node.text}`;
                if (seen.has(key))
                {
                    return null;
                }
                const next = new Set([...seen, key]);
                const record = parse(owner);
                const imported = record.imports.get(node.text);
                if (imported)
                {
                    const target = modulePath(imported.specifier, owner, mode === 'local' && owner.startsWith(path.join(fsusUIRoot, 'vue') + path.sep));
                    const origin = typeof target === 'string' ? exportsOf(target).get(imported.name) : null;
                    return origin?.file ? find(parse(origin.file).variables.get(origin.name), origin.file, next) : null;
                }
                return find(record.variables.get(node.text), owner, next);
            }
            if (ts.isCallExpression(node) && ts.isIdentifier(node.expression))
            {
                const imported = parse(owner).imports.get(node.expression.text);
                return imported?.specifier === '@element-plus/utils' && imported.name === 'buildProps'
                    ? find(node.arguments[0], owner, seen) : null;
            }
            const config = objectProperty(node, name);
            return config ? { file: owner, property: name, node: config,
                defaultNode: objectProperty(config, 'default'), declarationDigest: controlDigest(config.getText()) } : null;
        };
        return props ? find(props.node, file) : null;
    };
    const resolveComponentInput = (file, expression, { templateRefs = false } = {}) =>
    {
        const value = unwrap(expression);
        const record = parse(file);
        if (value && ts.isIdentifier(value) && !record.imports.has(value.text) && !record.variables.has(value.text))
        {
            const declaration = componentPropDeclaration(file, value.text);
            if (declaration)
            {
                return [{ kind: 'component-prop', file, property: value.text, declarationFile: declaration.file,
                    declarationDigest: declaration.declarationDigest }];
            }
        }
        return resolveExpression(file, expression, new Set(), templateRefs);
    };
    const finiteComponentBinding = (file, name) =>
    {
        const record = parse(file);
        const bindings = [];
        let written = false;
        function root(node)
        {
            node = unwrap(node);
            while (node && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)))
            {
                node = unwrap(node.expression);
            }
            return node && ts.isIdentifier(node) ? node.text : null;
        }
        function visit(node)
        {
            if (ts.isIdentifier(node) && node.text === name && [ts.SyntaxKind.VariableDeclaration,
                ts.SyntaxKind.Parameter, ts.SyntaxKind.BindingElement, ts.SyntaxKind.ImportSpecifier, ts.SyntaxKind.ImportClause,
                ts.SyntaxKind.FunctionDeclaration].includes(node.parent.kind)
                && node.parent.name === node)
            {
                bindings.push(node.parent);
            }
            if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
                && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && root(node.left) === name)
            {
                written = true;
            }
            if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
                && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) && root(node.operand) === name)
            {
                written = true;
            }
            if (ts.isDeleteExpression(node) && root(node.expression) === name)
            {
                written = true;
            }
            ts.forEachChild(node, visit);
        }
        record.scripts.forEach(({ ast }) => visit(ast));
        const binding = bindings[0];
        if (written || bindings.length !== 1 || (ts.isVariableDeclaration(binding) && !(binding.parent.flags & ts.NodeFlags.Const))
            || ts.isParameter(binding) || ts.isBindingElement(binding))
        {
            fail(`${file}: unbound finite component binding ${name}`);
        }
    };
    const finiteComputedReturns = (file, fn, seen) =>
    {
        if (fn.parameters.length || fn.modifiers?.length)
        {
            fail(`${file}: unknown computed component function`);
        }
        const targets = [];
        function returned(node)
        {
            if (!node)
            {
                fail(`${file}: empty computed component return`);
            }
            function protect(value, visiting = new Set())
            {
                value = unwrap(value);
                if (ts.isIdentifier(value))
                {
                    if (visiting.has(value.text))
                    {
                        fail(`${file}: cyclic finite component binding ${value.text}`);
                    }
                    finiteComponentBinding(file, value.text);
                    const initializer = parse(file).variables.get(value.text);
                    if (initializer)
                    {
                        protect(initializer, new Set([...visiting, value.text]));
                    }
                }
                else if (ts.isConditionalExpression(value))
                {
                    protect(value.whenTrue, new Set(visiting));
                    protect(value.whenFalse, new Set(visiting));
                }
            }
            protect(node);
            targets.push(...resolveExpression(file, node, new Set(seen)));
        }
        function flow(node)
        {
            if (ts.isReturnStatement(node))
            {
                returned(node.expression);
                return true;
            }
            if (ts.isBlock(node))
            {
                let terminal = false;
                for (const child of node.statements)
                {
                    terminal = flow(child) || terminal;
                }
                return terminal;
            }
            if (ts.isIfStatement(node))
            {
                const yes = flow(node.thenStatement);
                const no = node.elseStatement ? flow(node.elseStatement) : false;
                return yes && no;
            }
            fail(`${file}: unknown computed component flow ${node.getText()}`);
        }
        if (ts.isBlock(fn.body))
        {
            if (!flow(fn.body))
            {
                fail(`${file}: computed component may fall through`);
            }
        }
        else
        {
            returned(fn.body);
        }
        if (!targets.length)
        {
            fail(`${file}: computed component has no finite returns`);
        }
        return [...new Map(targets.map((target) => [controlDigest(target), target])).values()];
    };
    const componentFunction = (file, callee, seen = new Set()) =>
    {
        if (!ts.isIdentifier(callee))
        {
            fail(`${file}: unknown component source function`);
        }
        const name = callee.text;
        const identity = `${file}#${name}`;
        if (seen.has(identity))
        {
            fail(`cyclic component source function ${identity}`);
        }
        const next = new Set([...seen, identity]);
        finiteComponentBinding(file, name);
        const record = parse(file);
        const imported = record.imports.get(name);
        if (imported)
        {
            const target = modulePath(imported.specifier, file, mode === 'local' && file.startsWith(path.join(fsusUIRoot, 'vue') + path.sep));
            const exported = typeof target === 'string' ? exportsOf(target).get(imported.name) : null;
            if (!exported?.file || exported.ambiguous || exported.unresolved)
            {
                fail(`unknown component source function import ${identity}`);
            }
            const originRecord = parse(exported.file);
            const identifier = ts.factory.createIdentifier(exported.name);
            // Use the actual export identity; no function name establishes behavior.
            return componentFunction(originRecord.file, identifier, next);
        }
        const functions = record.scripts.flatMap(({ ast }) => ast.statements.filter((statement) =>
            ts.isFunctionDeclaration(statement) && statement.name?.text === name));
        const fn = functions.length === 1 ? functions[0] : unwrap(record.variables.get(name));
        if (!fn || !(ts.isFunctionDeclaration(fn) || ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))
            || fn.asteriskToken || fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword))
        {
            fail(`unknown component source function body ${identity}`);
        }
        return { file, fn, name };
    };
    const componentSourceStep = (file, node) =>
    {
        const script = parse(file).scripts.find(({ ast }) => ast === node.getSourceFile());
        return { file, offset: script ? script.offset + node.getStart() : null,
            kind: script ? 'script-source' : 'selector-expression', digest: controlDigest(node.getText()) };
    };
    const componentMember = (file, object, property, seen = new Set(), templateRefs = false) =>
    {
        object = unwrap(object);
        const identity = `${file}:${object?.getText() ?? 'missing'}#${property}`;
        if (!object || seen.has(identity))
        {
            fail(`cyclic/unknown component member ${identity}`);
        }
        const next = new Set([...seen, identity]);
        const record = parse(file);
        const step = componentSourceStep(file, object);
        if (ts.isIdentifier(object))
        {
            finiteComponentBinding(file, object.text);
            function escaped(node)
            {
                const argumentsToCheck = ts.isCallExpression(node) || ts.isNewExpression(node) ? node.arguments ?? []
                    : ts.isVariableDeclaration(node) && node.initializer ? [node.initializer] : [];
                if (argumentsToCheck.some((argument) =>
                {
                    argument = unwrap(argument);
                    return (ts.isIdentifier(argument) && argument.text === object.text)
                        || (ts.isPropertyAccessExpression(argument) && ts.isIdentifier(argument.expression)
                            && argument.expression.text === object.text && argument.name.text === 'value');
                }))
                {
                    fail(`escaped component member object ${identity}`);
                }
                ts.forEachChild(node, escaped);
            }
            record.scripts.forEach(({ ast }) => escaped(ast));
            const imported = record.imports.get(object.text);
            if (imported)
            {
                const target = modulePath(imported.specifier, file, mode === 'local' && file.startsWith(path.join(fsusUIRoot, 'vue') + path.sep));
                const exported = typeof target === 'string' ? exportsOf(target).get(imported.name) : null;
                if (!exported?.file || exported.ambiguous || exported.unresolved)
                {
                    fail(`unknown component member import ${identity}`);
                }
                const found = componentMember(exported.file, parse(exported.file).variables.get(exported.name), property, next, templateRefs);
                return { ...found, steps: [step, ...found.steps] };
            }
            const found = componentMember(file, record.variables.get(object.text), property, next, templateRefs);
            return { ...found, steps: [step, ...found.steps] };
        }
        if (ts.isCallExpression(object) && ts.isIdentifier(object.expression))
        {
            const imported = record.imports.get(object.expression.text);
            if (imported?.specifier === 'vue' && imported.name === 'computed')
            {
                if (!templateRefs)
                {
                    fail(`computed member requires actual template ref unwrapping ${identity}`);
                }
                finiteComponentBinding(file, object.expression.text);
                const fn = object.arguments.length === 1 ? object.arguments[0] : null;
                if (!fn || !ts.isArrowFunction(fn) || fn.parameters.length || fn.modifiers?.length || ts.isBlock(fn.body))
                {
                    fail(`unknown computed component member ${identity}`);
                }
                const found = componentMember(file, fn.body, property, next, false);
                return { ...found, steps: [step, ...found.steps] };
            }
            const { file: owner, fn } = componentFunction(file, object.expression);
            if (object.arguments.length || fn.parameters.length || !ts.isBlock(fn.body) || fn.body.statements.length !== 1
                || !ts.isReturnStatement(fn.body.statements[0]) || !fn.body.statements[0].expression)
            {
                fail(`unknown component object return ${identity}`);
            }
            const found = componentMember(owner, fn.body.statements[0].expression, property, next, false);
            return { ...found, steps: [step, componentSourceStep(owner, fn), ...found.steps] };
        }
        if (ts.isObjectLiteralExpression(object) && object.properties.every((field) => ts.isPropertyAssignment(field)
            && !ts.isComputedPropertyName(field.name) && field.name.text !== '__proto__')
            && new Set(object.properties.map((field) => field.name.text)).size === object.properties.length)
        {
            const selected = object.properties.find((field) => field.name.text === property);
            if (selected)
            {
                return { file, node: selected.initializer, property, steps: [step, componentSourceStep(file, selected)] };
            }
        }
        fail(`unknown component member source ${identity}`);
    };
    const componentIdentityReturn = (file, call, seen) =>
    {
        const { file: owner, fn } = componentFunction(file, call.expression);
        const parameter = fn.parameters[0];
        if (!parameter || !ts.isIdentifier(parameter.name) || parameter.initializer || parameter.dotDotDotToken
            || call.arguments.length !== fn.parameters.length || call.arguments.some(ts.isSpreadElement) || !ts.isBlock(fn.body))
        {
            fail(`${file}: unknown component identity arguments`);
        }
        if (call.arguments.slice(1).some((argument) =>
        {
            argument = unwrap(argument);
            return !ts.isStringLiteral(argument) && !ts.isNumericLiteral(argument)
                && ![ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(argument.kind);
        }))
        {
            fail(`${file}: dynamic component identity argument`);
        }
        function argumentSource(node, visiting = new Set())
        {
            node = unwrap(node);
            if (!node || !ts.isIdentifier(node) || visiting.has(node.text))
            {
                fail(`${file}: unknown component identity input`);
            }
            finiteComponentBinding(file, node.text);
            const record = parse(file);
            if (record.imports.has(node.text))
            {
                return;
            }
            argumentSource(record.variables.get(node.text), new Set([...visiting, node.text]));
        }
        argumentSource(call.arguments[0]);
        let returns = 0;
        function flow(node)
        {
            if (ts.isReturnStatement(node))
            {
                const returned = unwrap(node.expression);
                if (!returned || !ts.isIdentifier(returned) || returned.text !== parameter.name.text)
                {
                    fail(`${owner}: component identity return changed its argument`);
                }
                returns++;
                return true;
            }
            if (ts.isThrowStatement(node))
            {
                return true;
            }
            if (ts.isIfStatement(node))
            {
                const yes = flow(node.thenStatement);
                const no = node.elseStatement ? flow(node.elseStatement) : false;
                return yes && no;
            }
            if (ts.isBlock(node))
            {
                let terminal = false;
                for (const child of node.statements)
                {
                    terminal = flow(child) || terminal;
                }
                return terminal;
            }
            fail(`${owner}: unknown component identity function flow`);
        }
        function unchanged(node)
        {
            function root(value)
            {
                value = unwrap(value);
                while (value && (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)))
                {
                    value = unwrap(value.expression);
                }
                return value && ts.isIdentifier(value) ? value.text : null;
            }
            if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
                && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && root(node.left) === parameter.name.text)
            {
                fail(`${owner}: mutated component identity argument`);
            }
            if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
                && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) && root(node.operand) === parameter.name.text)
            {
                fail(`${owner}: mutated component identity argument`);
            }
            if (ts.isDeleteExpression(node) && root(node.expression) === parameter.name.text)
            {
                fail(`${owner}: mutated component identity argument`);
            }
            if (ts.isFunctionLike(node))
            {
                fail(`${owner}: nested component identity argument flow`);
            }
            if ((ts.isCallExpression(node) || ts.isNewExpression(node))
                && node.arguments?.some((argument) => root(argument) === parameter.name.text))
            {
                fail(`${owner}: escaped component identity argument`);
            }
            ts.forEachChild(node, unchanged);
        }
        unchanged(fn.body);
        if (!flow(fn.body) || !returns)
        {
            fail(`${owner}: component identity function may fall through`);
        }
        const targets = resolveExpression(file, call.arguments[0], seen);
        if (targets.some((target) => !['local', 'fsusui-public', 'upstream-internal'].includes(target.kind)))
        {
            fail(`${file}: component identity input has no actual component source`);
        }
        return targets.map((target) => ({ ...target, identityFunction: { ...componentSourceStep(owner, fn),
            parameter: parameter.name.text, call: componentSourceStep(file, call) } }));
    };
    const resolveExpression = (file, expression, seen = new Set(), templateRefs = false) =>
    {
        const record = parse(file);
        if (!expression)
        {
            fail(`${file}: missing component expression`);
        }
        if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression))
        {
            return resolveExpression(file, expression.expression, seen, templateRefs);
        }
        if (ts.isIdentifier(expression))
        {
            const name = expression.text;
            if (record.imports.has(name))
            {
                return [resolveImport(file, record.imports.get(name), seen)];
            }
            if (record.variables.has(name) && !seen.has(name))
            {
                const value = record.variables.get(name);
                if (ts.isCallExpression(value) && ts.isIdentifier(value.expression)
                    && record.imports.get(value.expression.text)?.specifier === 'vue'
                    && record.imports.get(value.expression.text)?.name === 'computed')
                {
                    finiteComponentBinding(file, name);
                }
                if (ts.isCallExpression(value) && ts.isIdentifier(value.expression)
                    && record.imports.get(value.expression.text)?.specifier === 'vue'
                    && record.imports.get(value.expression.text)?.name === 'defineComponent')
                {
                    return [{ kind: 'local', file, name }];
                }
                return resolveExpression(file, record.variables.get(name), new Set([...seen, name]), templateRefs);
            }
        }
        if (ts.isStringLiteral(expression))
        {
            return [resolveTag(file, expression.text)];
        }
        if (ts.isConditionalExpression(expression))
        {
            return [...resolveExpression(file, expression.whenTrue, seen, templateRefs), ...resolveExpression(file, expression.whenFalse, seen, templateRefs)];
        }
        if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression))
        {
            const imported = record.imports.get(expression.expression.text);
            if (imported?.name === '*')
            {
                return [resolveImport(file, { ...imported, name: expression.name.text }, seen)];
            }
            const selected = componentMember(file, expression.expression, expression.name.text, new Set(), templateRefs);
            function protectMember(node, visiting = new Set())
            {
                node = unwrap(node);
                if (ts.isIdentifier(node))
                {
                    if (visiting.has(node.text))
                    {
                        fail(`${selected.file}: cyclic component member value`);
                    }
                    finiteComponentBinding(selected.file, node.text);
                    const value = parse(selected.file).variables.get(node.text);
                    if (value)
                    {
                        protectMember(value, new Set([...visiting, node.text]));
                    }
                }
                else if (ts.isConditionalExpression(node))
                {
                    protectMember(node.whenTrue, new Set(visiting));
                    protectMember(node.whenFalse, new Set(visiting));
                }
                else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
                    && parse(selected.file).imports.get(node.expression.text)?.specifier === 'vue'
                    && parse(selected.file).imports.get(node.expression.text)?.name === 'computed')
                {
                    fail(`${selected.file}: nested computed member is not a component value`);
                }
            }
            protectMember(selected.node);
            return resolveExpression(selected.file, selected.node, seen).map((target) => ({ ...target,
                memberSource: { property: selected.property, steps: selected.steps } }));
        }
        if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)
            && record.imports.get(expression.expression.text)?.specifier === 'vue'
            && record.imports.get(expression.expression.text)?.name === 'defineAsyncComponent')
        {
            const functionNode = expression.arguments[0];
            const body = functionNode?.body;
            if (body && ts.isCallExpression(body) && body.expression.kind === ts.SyntaxKind.ImportKeyword
                && ts.isStringLiteral(body.arguments[0]))
            {
                return [resolveImport(file, { specifier: body.arguments[0].text, name: 'default' }, seen)];
            }
        }
        if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)
            && record.imports.get(expression.expression.text)?.specifier === 'vue')
        {
            const imported = record.imports.get(expression.expression.text).name;
            if (imported === 'computed' && expression.arguments.length === 1 && ts.isArrowFunction(expression.arguments[0]))
            {
                finiteComponentBinding(file, expression.expression.text);
                return finiteComputedReturns(file, expression.arguments[0], seen);
            }
            if (imported === 'resolveComponent' && expression.arguments[0] && ts.isStringLiteral(expression.arguments[0]))
            {
                return [resolveTag(file, expression.arguments[0].text)];
            }
            if (imported === 'defineComponent')
            {
                return [{ kind: 'local', file, name: 'inline@' + expression.pos }];
            }
        }
        if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression))
        {
            return componentIdentityReturn(file, expression, seen);
        }
        fail(`${file}: unresolved component expression ${expression.getText()}`);
    };
    const globalRegistrations = new Map();
    const vitePath = path.join(repositoryRoot, 'src/frontend/vite.config.ts');
    const autoResolvers = [];
    if (fs.existsSync(vitePath))
    {
        const record = parse(vitePath);
        for (const { ast } of record.scripts)
        {
            const visit = (node) =>
            {
                if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
                    && record.imports.get(node.expression.text)?.specifier === 'unplugin-vue-components/vite')
                {
                    const options = node.arguments[0];
                    const property = options && ts.isObjectLiteralExpression(options)
                        ? options.properties.find((property) => property.name?.getText(ast) === 'resolvers') : null;
                    if (!property || !ts.isPropertyAssignment(property) || !ts.isArrayLiteralExpression(property.initializer))
                    {
                        fail('unresolvable Vite component resolver registration');
                    }
                    for (const callback of property.initializer.elements)
                    {
                        if (!ts.isArrowFunction(callback) || callback.parameters.length !== 1
                            || !ts.isIdentifier(callback.parameters[0].name) || !ts.isBlock(callback.body))
                        {
                            fail('unsupported Vite component resolver callback');
                        }
                        const parameter = callback.parameters[0].name.text;
                        const matches = (candidate) =>
                        {
                            const evaluate = (expression) =>
                            {
                                if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)
                                    && ts.isIdentifier(expression.expression.expression) && expression.expression.expression.text === parameter
                                    && expression.expression.name.text === 'match' && expression.arguments.length === 1
                                    && expression.arguments[0].kind === ts.SyntaxKind.RegularExpressionLiteral)
                                {
                                    const literal = expression.arguments[0].getText(ast);
                                    const end = literal.lastIndexOf('/');
                                    return new RegExp(literal.slice(1, end), literal.slice(end + 1)).test(candidate);
                                }
                                fail('unknown Vite resolver conditional state');
                            };
                            const execute = (statement) =>
                            {
                                if (ts.isBlock(statement))
                                {
                                    for (const child of statement.statements)
                                    {
                                        const result = execute(child);
                                        if (result !== undefined)
                                        {
                                            return result;
                                        }
                                    }
                                    return undefined;
                                }
                                if (ts.isIfStatement(statement))
                                {
                                    return evaluate(statement.expression) ? execute(statement.thenStatement)
                                        : statement.elseStatement ? execute(statement.elseStatement) : undefined;
                                }
                                if (ts.isReturnStatement(statement) && statement.expression && ts.isObjectLiteralExpression(statement.expression))
                                {
                                    const from = statement.expression.properties.find((property) => property.name?.getText(ast) === 'from');
                                    const name = statement.expression.properties.find((property) => property.name?.getText(ast) === parameter);
                                    if (from && ts.isPropertyAssignment(from) && ts.isStringLiteral(from.initializer)
                                        && from.initializer.text === packageId && name && ts.isShorthandPropertyAssignment(name))
                                    {
                                        return true;
                                    }
                                }
                                fail('unknown Vite resolver import identity');
                            };
                            return execute(callback.body) === true;
                        };
                        // Resolve every candidate through the real callback's AST;
                        // its return statement alone is not registration proof.
                        autoResolvers.push(matches);
                    }
                }
                ts.forEachChild(node, visit);
            };
            visit(ast);
        }
    }
    const resolveTag = (file, tag) =>
    {
        const record = parse(file);
        if (dom.parserOptions.isNativeTag(tag))
        {
            return { kind: 'native', name: tag };
        }
        const candidates = [tag, pascal(tag)];
        for (const name of candidates)
        {
            if (record.imports.has(name))
            {
                return resolveImport(file, record.imports.get(name));
            }
            if (record.variables.has(name))
            {
                const identities = resolveExpression(file, record.variables.get(name));
                if (identities.length === 1)
                {
                    return identities[0];
                }
                fail(`${file}: ambiguous component ${name}`);
            }
            if (globalRegistrations.has(name))
            {
                return globalRegistrations.get(name);
            }
        }
        if (file.endsWith('.vue') && candidates.includes(path.basename(file, '.vue')))
        {
            return { kind: 'local', file, name: 'default', registration: 'vue:sfc-self-reference' };
        }
        const builtIn = dom.parserOptions.isBuiltInComponent(tag);
        if (builtIn || ['Teleport', 'KeepAlive', 'Suspense'].includes(pascal(tag)))
        {
            const name = pascal(tag);
            if (Object.hasOwn(vueRuntime, name))
            {
                return { kind: 'framework-structure', package: 'vue', publicName: name, registration: 'vue:compiler-built-in' };
            }
        }
        const name = pascal(tag);
        if (autoResolvers.some((matches) => matches(name)))
        {
            return { ...publicIdentity(packageId, name), registration: 'vite:unplugin-vue-components' };
        }
        if (['RouterLink', 'RouterView'].includes(name))
        {
            const router = path.join(src, 'router/index.ts');
            if (fs.existsSync(router) && [...parse(router).imports.values()].some((entry) => entry.specifier === 'vue-router' && entry.name === 'createRouter'))
            {
                return { kind: 'external', package: 'vue-router', publicName: name, registration: 'vue-router:createRouter' };
            }
        }
        fail(`${file}: unresolved component tag ${tag}`);
    };
    const addRegistrations = (file) =>
    {
        for (const [name, expression] of parse(file).registrations)
        {
            const values = resolveExpression(file, expression);
            if (values.length !== 1 || globalRegistrations.has(name))
            {
                fail(`${file}: ambiguous/duplicate registration ${name}`);
            }
            globalRegistrations.set(name, values[0]);
        }
    };
    const isInteractive = (source, seen = new Set()) =>
    {
        if (source.kind === 'native')
        {
            return nativeControls.has(source.name);
        }
        if (source.kind !== 'fsusui-public' || !source.definition)
        {
            return false;
        }
        const inspect = (file, name) =>
        {
            const key = file + '#' + name;
            if (seen.has(key))
            {
                return false;
            }
            seen.add(key);
            const record = parse(file);
            if (record.template)
            {
                const visit = (node) => node.type === 1 && (nativeControls.has(node.tag)
                    || node.props.some((prop) => prop.type === 6 && prop.name === 'role' && interactiveRoles.has(prop.value?.content))
                    || (node.tag === 'component' && node.props.some((prop) => prop.type === 7 && prop.name === 'on' && prop.arg?.content === 'click')))
                    || (node.children ?? []).some(visit);
                return visit(record.template.ast);
            }
            const value = record.variables.get(name);
            const follow = (expression) =>
            {
                if (ts.isIdentifier(expression))
                {
                    const imported = record.imports.get(expression.text);
                    if (imported)
                    {
                        const target = modulePath(imported.specifier, file, true);
                        return typeof target === 'string' && inspect(target, imported.name);
                    }
                    return inspect(file, expression.text);
                }
                if (ts.isCallExpression(expression) && expression.arguments[0])
                {
                    return follow(expression.arguments[0]);
                }
                if (ts.isPropertyAccessExpression(expression))
                {
                    return follow(expression.expression);
                }
                return false;
            };
            return Boolean(value && follow(value));
        };
        return inspect(source.definition, source.exportName);
    };
    return { ts, dom, parse, resolveTag, resolveImport, resolveExpression, publicIdentity, addRegistrations,
        modulePath, exportsOf, componentProps, componentPropDeclaration, resolveComponentInput, resolveFactoryComponent,
        isInteractive,
        identity: { mode, package: packageId, publicRoot, packageDigest: controlDigest(metadata),
            upstream: initialUpstreamIdentity, resolutionInputs, parsers: { typescript: ts.version, vueSfc: require('@vue/compiler-sfc/package.json').version,
                vueDom: require('@vue/compiler-dom/package.json').version } },
        sourceBindings: () =>
        {
            const files = [...resolutionInputs, ...[...parsed.values()].map((record) => ({ path: record.file, digest: controlDigest(record.content) }))];
            const errors = files.filter((file) => !fs.existsSync(file.path) || file.digest !== controlDigest(fs.readFileSync(file.path, 'utf8')))
                .map((file) => ({ path: file.path, reason: 'parsed-source-changed-during-scan' }));
            if (controlDigest(initialUpstreamIdentity) !== controlDigest(upstreamIdentity()))
            {
                errors.push({ reason: 'FsusUI-identity-changed-during-scan' });
            }
            return { files, errors };
        },
        sourceRoot: src };
}

/** Registry validity is independent of acceptance; missing executions stay errors. */
export function validateControlRegistry({ registry, controls, testCatalog, testExecutions = new Map(), now = new Date(), upstreamIssues = new Map() })
{
    const errors = [];
    if (registry?.schema !== controlLegalityVersion || Object.keys(registry).sort().join(',') !== 'entries,schema'
        || !Array.isArray(registry.entries))
    {
        return [{ reason: 'invalid-registry-schema' }];
    }
    const ids = new Set();
    const targets = new Set();
    for (const entry of registry.entries)
    {
        const error = (reason) => errors.push({ path: entry.path, registryRef: entry.id, reason });
        if (Object.keys(entry).sort().join(',') !== [...entryFields].sort().join(',')
            || entry.schema !== controlLegalityVersion || !categories.has(entry.classification))
        {
            error('invalid-registration-fields');
            continue;
        }
        if (typeof entry.path !== 'string' || entry.path.includes('*') || entry.path.includes('?')
            || path.isAbsolute(entry.path) || entry.path.split('/').includes('..') || !entry.id)
        {
            error('broad-or-unowned-registration');
            continue;
        }
        const target = entry.path + '#' + entry.identity;
        if (ids.has(entry.id) || targets.has(target))
        {
            error('duplicate-registration-owner');
        }
        ids.add(entry.id);
        targets.add(target);
        const unsigned = { ...entry };
        delete unsigned.contentDigest;
        if (entry.contentDigest !== controlDigest(unsigned))
        {
            error('registration-content-drift');
        }
        const matches = controls.filter((control) => control.path === entry.path && control.identity === entry.identity);
        if (matches.length !== 1 || controlDigest(matches[0]?.sourceLocation) !== controlDigest(entry.sourceLocation))
        {
            error('missing-moved-or-duplicate-occurrence');
        }
        if (entry.classification === 'framework-bridge' && (matches[0]?.controlKind !== 'framework-definition'
            || matches[0]?.resolvedSource?.package !== 'vue-router' || matches[0]?.resolvedSource?.publicName !== 'RouterLink'))
        {
            error('framework-bridge-requires-exact-public-identity');
        }
        if (entry.classification === 'composition' && matches[0]?.controlKind !== 'composition')
        {
            error('composition-requires-component-definition');
        }
        for (const field of ['reason', 'owner', 'removalCondition'])
        {
            if (typeof entry[field] !== 'string' || !entry[field].trim())
            {
                error(`missing-${field}`);
            }
        }
        for (const field of ['allowedResponsibilities', 'forbiddenGenericResponsibilities', 'requiredTestIds'])
        {
            if (!Array.isArray(entry[field]) || !entry[field].length || entry[field].some((value) => typeof value !== 'string' || !value))
            {
                error(`missing-${field}`);
            }
        }
        if (!Array.isArray(entry.fsusUiPrimitives) || !Array.isArray(entry.productSemantics)
            || (entry.classification === 'composition' && (!entry.productSemantics.length || !entry.fsusUiPrimitives.length)))
        {
            error('missing-product-semantics-or-delegation');
        }
        for (const testId of entry.requiredTestIds ?? [])
        {
            const test = testCatalog.get(testId);
            if (!test || !test.executable || !['fast', 'ci', 'release'].every((lane) => test.lanes.includes(lane)))
            {
                error(`missing-executable-test:${testId}`);
            }
            else if (!testExecutions.get(testId)?.verified || testExecutions.get(testId)?.status !== 'passed')
            {
                error(`unexecuted-test:${testId}`);
            }
            if (['semantic-native', 'browser-native-bridge', 'framework-bridge', 'capability-gap'].includes(entry.classification)
                && test?.kind !== 'browser')
            {
                error(`missing-browser-test:${testId}`);
            }
        }
        if (entry.classification === 'capability-gap')
        {
            const issue = upstreamIssues.get(entry.upstreamIssue);
            if (!issue || issue.state !== 'open' || issue.repository !== 'Ozwasyd/FsusUI' || !issue.missingCapability)
            {
                error('missing-open-upstream-capability');
            }
            if (!entry.reviewAfter || !Number.isFinite(Date.parse(entry.reviewAfter)) || Date.parse(entry.reviewAfter) <= now.getTime())
            {
                error('expired-capability-gap');
            }
            if (issue?.capabilityAvailable)
            {
                error('upstream-capability-already-available');
            }
        }
        else if (entry.upstreamIssue !== null || entry.reviewAfter !== null)
        {
            error('unexpected-capability-gap-fields');
        }
    }
    return errors;
}

function walk(directory)
{
    return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) =>
    {
        const file = path.join(directory, entry.name);
        return entry.isDirectory() ? walk(file) : sourceExtensions.includes(path.extname(file)) ? [file] : [];
    });
}

export function scanControlLegality({ repositoryRoot, resolver, registry, testCatalog = new Map(), testExecutions = new Map(), upstreamIssues = new Map() })
{
    const controls = [];
    const errors = [];
    const sources = walk(resolver.sourceRoot);
    const relative = (file) => path.relative(repositoryRoot, file).replaceAll(path.sep, '/');
    const error = (file, location, kind, reason, resolvedSource = null) => errors.push({ path: relative(file),
        ...location, controlKind: kind, resolvedSource, reason });
    const records = new Map();
    for (const file of sources)
    {
        try
        {
            records.set(file, resolver.parse(file));
            resolver.addRegistrations(file);
        }
        catch (failure)
        {
            error(file, { line: 1, column: 1 }, 'source', failure.message);
        }
    }
    const add = (file, offset, kind, resolvedSource, nodeSource, parentInteractive) =>
    {
        const record = records.get(file);
        const sourceLocation = { ...locate(record.content, offset), nodeDigest: controlDigest(nodeSource) };
        const identity = `${kind}@${sourceLocation.offset}:${sourceLocation.nodeDigest}`;
        const control = { path: relative(file), sourceLocation, identity, controlKind: kind, resolvedSource,
            classification: resolvedSource?.kind === 'fsusui-public' ? 'fsusui-public' : 'unregistered',
            registryRef: null, requiredTestIds: [], executionStatus: 'not-qualified' };
        controls.push(control);
        if (parentInteractive && (resolvedSource?.kind !== 'fsusui-public' || resolver.isInteractive(resolvedSource)))
        {
            error(file, sourceLocation, kind, 'nested-interactive', resolvedSource);
        }
        return control;
    };
    for (const [file, record] of records)
    {
        const { ts } = resolver;
        for (const { ast, offset } of record.scripts)
        {
            for (const comment of [...ts.getLeadingCommentRanges(ast.text, 0) ?? []])
            {
                const text = ast.text.slice(comment.pos, comment.end);
                if (text.includes('fsusui') && (text.includes('suppress') || text.includes('skip') || text.includes('ignore')))
                {
                    error(file, locate(record.content, offset + comment.pos), 'suppression', 'production-suppression-forbidden');
                }
            }
            const visit = (node, parentInteractive = false) =>
            {
                let interactive = false;
                let tag;
                let properties = [];
                if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
                {
                    tag = node.tagName.getText(ast);
                    properties = node.attributes.properties.map((attribute) => attribute.name?.getText(ast));
                }
                else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
                    && ['createElement', 'createElementNS'].includes(node.expression.name.text)
                    && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'document')
                {
                    const target = node.arguments[node.expression.name.text === 'createElementNS' ? 1 : 0];
                    if (!target || !ts.isStringLiteral(target))
                    {
                        error(file, locate(record.content, offset + node.getStart(ast)), 'dom-factory', 'unresolved-native-factory-target');
                    }
                    else
                    {
                        tag = target.text;
                    }
                }
                else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
                    && record.imports.get(node.expression.text)?.specifier === 'vue'
                    && ['h', 'createVNode', 'createElementVNode'].includes(record.imports.get(node.expression.text)?.name))
                {
                    const target = node.arguments[0];
                    tag = target && ts.isStringLiteral(target) ? target.text : null;
                    if (!tag)
                    {
                        try
                        {
                            for (const source of resolver.resolveExpression(file, target))
                            {
                                if (source.kind !== 'framework-structure')
                                {
                                    add(file, offset + node.getStart(ast), 'render-component', source, node.getText(ast), parentInteractive);
                                }
                            }
                        }
                        catch (failure)
                        {
                            error(file, locate(record.content, offset + node.getStart(ast)), 'render-component', failure.message);
                        }
                    }
                    const props = node.arguments[1];
                    properties = props && ts.isObjectLiteralExpression(props) ? props.properties.map((p) => p.name?.getText(ast).replaceAll("'", '').replaceAll('"', '')) : [];
                }
                if (tag)
                {
                    interactive = nativeControls.has(tag) || properties.some((p) => ['onClick', 'onKeydown', 'tabindex', 'tabIndex', 'role', 'contenteditable'].includes(p));
                    if (interactive || /^[A-Z]/u.test(tag))
                    {
                        let source = { kind: 'native', name: tag };
                        try
                        {
                            if (/^[A-Z]/u.test(tag))
                            {
                                source = resolver.resolveTag(file, tag);
                            }
                            add(file, offset + node.getStart(ast), interactive ? tag : 'render-component', source, node.getText(ast), parentInteractive);
                        }
                        catch (failure)
                        {
                            error(file, locate(record.content, offset + node.getStart(ast)), tag, failure.message);
                        }
                    }
                }
                ts.forEachChild(node, (child) => visit(child, parentInteractive || interactive));
            };
            visit(ast);
        }
        if (!record.template)
        {
            continue;
        }
        const visit = (node, parentInteractive = false) =>
        {
            if (node.type !== 1)
            {
                for (const child of node.children ?? [])
                {
                    visit(child, parentInteractive);
                }
                return;
            }
            const attrs = new Map(node.props.filter((prop) => prop.type === 6).map((prop) => [prop.name, prop.value?.content ?? '']));
            const directives = node.props.filter((prop) => prop.type === 7);
            const handlers = directives.filter((prop) => prop.name === 'on').map((prop) => prop.arg?.content);
            const boundNames = directives.filter((prop) => prop.name === 'bind').map((prop) => prop.arg?.content);
            const offset = record.template.offset + node.loc.start.offset;
            const role = attrs.get('role');
            const nativeInteractive = nativeControls.has(node.tag)
                && !(node.tag === 'input' && attrs.get('type') === 'hidden')
                && !(node.tag === 'a' && !attrs.has('href') && !boundNames.includes('href'))
                && !(['audio', 'video'].includes(node.tag) && !attrs.has('controls') && !boundNames.includes('controls'));
            const interactive = nativeInteractive || interactiveRoles.has(role)
                || attrs.has('contenteditable') || attrs.has('tabindex') || boundNames.includes('contenteditable')
                || handlers.some((event) => ['click', 'keydown', 'keyup', 'keypress'].includes(event));
            let source;
            let sourcesForDynamic;
            if (node.tag === 'component')
            {
                const bound = directives.find((prop) => prop.name === 'bind' && prop.arg?.content === 'is');
                try
                {
                    if (bound?.exp)
                    {
                        const ast = ts.createSourceFile(file + '.dynamic.ts', '(' + bound.exp.content + ')', ts.ScriptTarget.Latest, true);
                        if (ast.parseDiagnostics.length)
                        {
                            fail('dynamic component parser failure');
                        }
                        sourcesForDynamic = resolver.resolveExpression(file, ast.statements[0].expression.expression, new Set(), true);
                    }
                    else if (attrs.has('is'))
                    {
                        sourcesForDynamic = [resolver.resolveTag(file, attrs.get('is'))];
                    }
                    else
                    {
                        fail('unresolved dynamic component target');
                    }
                }
                catch (failure)
                {
                    error(file, locate(record.content, offset), 'dynamic-component', failure.message);
                }
            }
            else if (node.tagType === 1)
            {
                try
                {
                    source = resolver.resolveTag(file, node.tag);
                }
                catch (failure)
                {
                    error(file, locate(record.content, offset), 'component', failure.message);
                }
            }
            else if (interactive)
            {
                source = { kind: 'native', name: node.tag };
            }
            if (source || sourcesForDynamic)
            {
                for (const resolved of sourcesForDynamic ?? [source])
                {
                    if (resolved.kind !== 'framework-structure' || interactive)
                    {
                        add(file, offset, node.tag === 'component' ? 'dynamic-component' : node.tag, resolved, node.loc.source, parentInteractive);
                    }
                }
            }
            if (node.tagType === 0 && boundNames.includes('role'))
            {
                error(file, locate(record.content, offset), node.tag, 'unknown-dynamic-native-role');
            }
            if (node.tagType === 0 && directives.some((prop) => prop.name === 'bind' && !prop.arg))
            {
                error(file, locate(record.content, offset), node.tag, 'unknown-native-spread-authority');
            }
            for (const child of node.children ?? [])
            {
                visit(child, parentInteractive || interactive || Boolean(source && resolver.isInteractive(source)));
            }
        };
        visit(record.template.ast);
        const apiNames = new Set();
        const genericHandlers = new Set();
        for (const { ast } of record.scripts)
        {
            const collect = (node) =>
            {
                if (ts.isPropertySignature(node) || ts.isPropertyAssignment(node))
                {
                    const name = node.name?.getText(ast).replaceAll("'", '').replaceAll('"', '');
                    if (genericApi.has(name))
                    {
                        apiNames.add(name);
                    }
                }
                if (ts.isStringLiteral(node) && ['ArrowDown', 'ArrowUp', 'Escape', 'update:modelValue', 'open-change'].includes(node.text))
                {
                    genericHandlers.add(node.text);
                }
                ts.forEachChild(node, collect);
            };
            collect(ast);
        }
        if (apiNames.size >= 3 || genericHandlers.size >= 2)
        {
            error(file, { line: 1, column: 1 }, 'local-wrapper', 'unproved-generic-control-responsibility',
                { kind: 'local', apiNames: [...apiNames], handlers: [...genericHandlers] });
        }
    }
    const definitions = new Map();
    const frameworkDefinitions = new Map();
    for (const control of [...controls])
    {
        if (control.resolvedSource?.kind === 'local')
        {
            const { file, name } = control.resolvedSource;
            const key = `${relative(file)}#${name}`;
            if (!definitions.has(key) && records.has(file))
            {
                const record = records.get(file);
                const definition = { path: relative(file), identity: `component:${key}`,
                    sourceLocation: { offset: 0, line: 1, column: 1, nodeDigest: controlDigest(record.content) },
                    controlKind: 'composition', resolvedSource: control.resolvedSource, classification: 'unregistered',
                    registryRef: null, requiredTestIds: [], executionStatus: 'not-qualified' };
                definitions.set(key, definition);
                controls.push(definition);
            }
        }
        else if (control.resolvedSource?.kind === 'external' && control.resolvedSource.package === 'vue-router'
            && control.resolvedSource.publicName === 'RouterLink')
        {
            const key = 'framework:vue-router#RouterLink';
            const metadataPath = path.join(repositoryRoot, 'src/frontend/package.json');
            if (!frameworkDefinitions.has(key) && fs.existsSync(metadataPath))
            {
                const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
                if (!metadata.dependencies?.['vue-router'])
                {
                    errors.push({ path: control.path, ...control.sourceLocation, controlKind: 'framework-source',
                        reason: 'vue-router-public-dependency-not-declared' });
                    continue;
                }
                const definition = { path: relative(metadataPath), identity: key,
                    sourceLocation: { offset: 0, line: 1, column: 1, nodeDigest: controlDigest(fs.readFileSync(metadataPath, 'utf8')) },
                    controlKind: 'framework-definition', resolvedSource: control.resolvedSource, classification: 'unregistered',
                    registryRef: null, requiredTestIds: [], executionStatus: 'not-qualified' };
                frameworkDefinitions.set(key, definition);
                controls.push(definition);
            }
        }
    }
    const registryErrors = validateControlRegistry({ registry, controls, testCatalog, testExecutions, upstreamIssues });
    errors.push(...registryErrors);
    const invalidRefs = new Set(registryErrors.map((item) => item.registryRef));
    for (const control of controls)
    {
        const target = control.resolvedSource?.kind === 'local' && control.controlKind !== 'composition'
            ? definitions.get(`${relative(control.resolvedSource.file)}#${control.resolvedSource.name}`) ?? control
            : control.resolvedSource?.kind === 'external' && control.controlKind !== 'framework-definition'
                ? frameworkDefinitions.get(`framework:${control.resolvedSource.package}#${control.resolvedSource.publicName}`) ?? control : control;
        const entry = registry?.entries?.find((entry) => entry.path === target.path && entry.identity === target.identity);
        if (entry && !invalidRefs.has(entry.id))
        {
            control.classification = entry.classification;
            control.registryRef = entry.id;
            control.requiredTestIds = entry.requiredTestIds;
            control.executionStatus = 'verified';
        }
        else if (control.classification !== 'fsusui-public')
        {
            errors.push({ path: control.path, ...control.sourceLocation, resolvedSource: control.resolvedSource,
                controlKind: control.controlKind, reason: 'unregistered-control' });
        }
    }
    const bindings = resolver.sourceBindings();
    errors.push(...bindings.errors);
    return { schema: 'fsusblog.control-inventory.v1', analyzerVersion: controlLegalityVersion,
        sourceIdentity: resolver.identity, sources: sources.map((file) => ({ path: relative(file), digest: controlDigest(fs.readFileSync(file, 'utf8')) })),
        parsedSourceBindings: bindings.files, registryDigest: controlDigest(registry), controls, errors, warnings: [],
        counts: {
            discovered: controls.length,
            unresolvedSource: errors.filter((item) => !item.resolvedSource
                && ['source', 'component', 'dynamic-component', 'render-component', 'dom-factory'].includes(item.controlKind)).length,
            unregistered: controls.filter((control) => control.classification === 'unregistered').length,
            invalidRegistrations: new Set(registryErrors.map((item) => item.registryRef ?? '<schema>')).size,
            expiredCapabilityGaps: registryErrors.filter((item) => item.reason === 'expired-capability-gap').length,
            missingOrUnexecutedTests: registryErrors.filter((item) => item.reason.startsWith('missing-executable-test:')
                || item.reason.startsWith('unexecuted-test:') || item.reason.startsWith('missing-browser-test:')).length,
            unknownThirdPartyControls: controls.filter((control) => control.resolvedSource?.kind === 'external'
                && control.classification === 'unregistered').length,
            warnings: 0
        }, qualified: errors.length === 0 };
}

export function verifyPublicControlParity(local, published)
{
    const identity = (control) => control.resolvedSource?.kind === 'fsusui-public'
        ? [control.path, control.identity, control.resolvedSource.package, control.resolvedSource.entry,
            control.resolvedSource.publicName, control.resolvedSource.exportName] : null;
    const left = local.controls.map(identity).filter(Boolean);
    const right = published.controls.map(identity).filter(Boolean);
    if (controlDigest(left) !== controlDigest(right))
    {
        fail('local/published public component identity mismatch');
    }
    return true;
}
