import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export const controlRegistryPath = 'config/frontend/control-legality.json';
export const controlLegalityVersion = 'fsusblog.control-legality.v1';
const packageId = '@ozwasyd/element-plus';
const sourceExtensions = ['.vue', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.d.ts', '.mts', '.d.mts'];
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
        const target = modulePath(imported.specifier, file);
        if (imported.specifier === 'vue' && ['Transition', 'TransitionGroup', 'Teleport', 'KeepAlive', 'Suspense', 'Fragment'].includes(imported.name)
            && Object.hasOwn(vueRuntime, imported.name))
        {
            return { kind: 'framework-structure', package: 'vue', publicName: imported.name };
        }
        return typeof target === 'string' ? resolveExport(target, imported.name, seen)
            : { kind: 'external', package: target.package, publicName: imported.name };
    };
    const resolveExpression = (file, expression, seen = new Set()) =>
    {
        const record = parse(file);
        if (!expression)
        {
            fail(`${file}: missing component expression`);
        }
        if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression))
        {
            return resolveExpression(file, expression.expression, seen);
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
                    && record.imports.get(value.expression.text)?.name === 'defineComponent')
                {
                    return [{ kind: 'local', file, name }];
                }
                return resolveExpression(file, record.variables.get(name), new Set([...seen, name]));
            }
        }
        if (ts.isStringLiteral(expression))
        {
            return [resolveTag(file, expression.text)];
        }
        if (ts.isConditionalExpression(expression))
        {
            return [...resolveExpression(file, expression.whenTrue, seen), ...resolveExpression(file, expression.whenFalse, seen)];
        }
        if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression))
        {
            const imported = record.imports.get(expression.expression.text);
            if (imported?.name === '*')
            {
                return [resolveImport(file, { ...imported, name: expression.name.text }, seen)];
            }
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
            if (imported === 'computed' && expression.arguments[0] && ts.isArrowFunction(expression.arguments[0])
                && !ts.isBlock(expression.arguments[0].body))
            {
                return resolveExpression(file, expression.arguments[0].body, seen);
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
        modulePath, exportsOf,
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
                        sourcesForDynamic = resolver.resolveExpression(file, ast.statements[0].expression.expression);
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
