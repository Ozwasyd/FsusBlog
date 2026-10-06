import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateClosedOwnedCliAst } from '../../tools/style/command-wrapper-input-ast.mjs';
import { observeCommandWrapperCompileBinding, readCommandWrapperOwnedSource } from '../../tools/style/command-wrapper-compile-binding.mjs';
import { inspectCommandWrapperCompileDatabase, isMandatoryCommandWrapperInput, validateCommandWrapperInputSelection } from '../../tools/style/command-wrapper-input-model.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const nativeFile = 'tools/test/native/execution-envelope-landlock.c';
const originalSource = fs.readFileSync(path.join(root, nativeFile), 'utf8');

// Explicit source AST adapters exercise admission predicates without executing a
// compiler. They are not compiler ASTs, native diagnostics or qualification.
function sourceAst(source)
{
    const sourceFile = path.join(root, nativeFile);
    const type = qualType => ({ qualType });
    const declarations = new Map();
    const ref = declaration => ({ kind: 'DeclRefExpr', id: `ref-${declaration.id}`, type: declaration.type,
        referencedDecl: { id: declaration.id, kind: declaration.kind, name: declaration.name } });
    const integer = value => ({ kind: 'IntegerLiteral', value: String(value), type: type('int') });
    const variable = (name, qualType, inner = []) => ({ kind: 'VarDecl', id: `local-${name}`, name, type: type(qualType), inner });
    const parameter = (name, qualType) => ({ kind: 'ParmVarDecl', id: `parameter-${name}`, name, type: type(qualType) });
    const address = node => ({ kind: 'UnaryOperator', opcode: '&', inner: [node] });
    const range = (text, from = 0) =>
    {
        const offset = source.indexOf(text, from);
        assert.ok(offset >= 0, `explicit source adapter missing ${text}`);
        return { begin: { offset }, end: { offset: offset + text.length - 1, tokLen: 1 } };
    };
    const call = (name, ...args) => ({ kind: 'CallExpr', inner: [ref(declarations.get(name)), ...args] });
    for (const name of ['open', 'fstat', 'strtoull', 'execv', '_Exit', '__errno_location', 'close', 'fprintf', 'fputs', 'fputc'])
    {
        declarations.set(name, { kind: 'FunctionDecl', id: `external-${name}`, name,
            loc: { includedFrom: { file: sourceFile } }, inner: [] });
    }
    const shapes = [
        ['CreateRuleset', 'int (const LandlockRulesetAttr *, size_t, uint32_t)'],
        ['AddRule', 'int (int, const LandlockPathBeneathAttr *)'], ['RestrictSelf', 'int (int)'],
        ['ErrorTextForPointer', 'const char *(char *, const char *)'], ['ErrorTextForStatus', 'const char *(int, const char *)'],
        ['Fail', 'void (const char *)'], ['HandledAccessForAbi', 'uint64_t (int)'],
        ['AllowPath', 'void (int, const char *, uint64_t)'], ['ParseIdentity', 'unsigned long long (const char *)'],
        ['AllowOwnedTemporaryAlias', 'void (int, const char *, const char *, const char *, const char *, uint64_t)'],
        ['main', 'int (int, char **)']
    ];
    const owned = shapes.map(([name, qualType]) => ({ kind: 'FunctionDecl', id: `owned-${name}`, name,
        type: type(qualType), loc: { file: sourceFile }, inner: [{ kind: 'CompoundStmt', inner: [] }] }));
    owned.forEach(node => declarations.set(node.name, node));
    const body = name => owned.find(node => node.name === name).inner.at(-1);
    const addParameters = (name, parameters) => owned.find(node => node.name === name).inner.unshift(...parameters);
    const declaration = node => ({ kind: 'DeclStmt', inner: [node], range: node.range });
    const literal = value => ({ kind: 'StringLiteral', value, type: type('char[]') });
    const errno = (value, text) => ({ kind: 'BinaryOperator', opcode: '=', range: range(text), inner: [
        { kind: 'UnaryOperator', opcode: '*', inner: [call('__errno_location')] }, integer(value)
    ] });
    const condition = (owner, text, children = []) =>
    {
        const ownerOffset = source.indexOf(` ${owner}(`);
        const offset = source.indexOf(text, ownerOffset);
        assert.ok(offset >= 0, 'explicit source adapter missing condition');
        const after = source.slice(offset + text.length + 1).trimStart();
        const branchSource = after.startsWith('{') ? after.slice(1, after.indexOf('}')) : after.slice(0, after.indexOf(';'));
        const branch = [];
        const errnoAssignment = branchSource.match(/errno = (EINVAL|EACCES)/u);
        if (errnoAssignment) branch.push(errno(errnoAssignment[1] === 'EINVAL' ? 22 : 13, errnoAssignment[0]));
        const failure = branchSource.match(/Fail\("([^"\n]*)"\)/u);
        if (failure) branch.push({ ...call('Fail', literal(failure[1])), range: range(failure[0]) });
        if (branch.length === 0) branch.push({ kind: 'NullStmt' });
        if (/\bif\s*\(/u.test(branchSource)) branch.splice(0, branch.length, { kind: 'IfStmt', inner: [integer(1),
            { kind: 'CompoundStmt', inner: branch.slice() }] });
        const statement = { kind: 'IfStmt', range: range(text, ownerOffset), inner: [
            { kind: 'BinaryOperator', opcode: '||', range: range(text, ownerOffset), inner: children },
            { kind: 'CompoundStmt', inner: branch }
        ] };
        body(owner).inner.push(statement);
        return statement;
    };
    const stderr = { kind: 'VarDecl', id: 'global-stderr', name: 'stderr', storageClass: 'extern', type: type('FILE *') };
    declarations.set('stderr', stderr);
    const failMessage = parameter('message', 'const char *');
    addParameters('Fail', [failMessage]);
    const error = variable('Error', 'const int');
    const errorBuffer = variable('errorBuffer', 'char[1024]');
    const errorMessage = variable('errorMessage', 'const char *', [{ kind: 'CallExpr', inner: [
        { kind: 'GenericSelectionExpr', inner: ['ErrorTextForPointer', 'ErrorTextForStatus'].map(name =>
            ({ associationKind: 'case', inner: [ref(declarations.get(name))] })) }
    ] }]);
    body('Fail').inner.push(declaration(error), declaration(errorBuffer), declaration(errorMessage),
        call('fputs', literal('execution-envelope-landlock: '), ref(stderr)), call('fputs', ref(failMessage), ref(stderr)),
        call('fputs', literal(': '), ref(stderr)), call('fputs', ref(errorMessage), ref(stderr)), call('fputc', integer(10), ref(stderr)));
    const failSource = source.slice(source.indexOf('static void Fail('), source.indexOf('static uint64_t HandledAccessForAbi'));
    if (/\breturn\s*;/u.test(failSource)) body('Fail').inner.push({ kind: 'ReturnStmt', inner: [] });
    const exit = failSource.match(/_Exit\((\d+)\)/u);
    if (exit) body('Fail').inner.push({ ...call('_Exit', integer(Number(exit[1]))), range: range(exit[0]) });

    const value = parameter('value', 'const char *');
    const end = { ...variable('end', 'char *', [{ kind: 'ImplicitCastExpr', castKind: 'NullToPointer', inner: [integer(0)] }]),
        range: range('char* end = NULL') };
    const parsed = { ...variable('parsed', 'unsigned long long', [call('strtoull', ref(value), address(ref(end)), integer(10))]),
        range: range('unsigned long long parsed = strtoull(value, &end, 10)') };
    addParameters('ParseIdentity', [value]);
    body('ParseIdentity').inner.push(declaration(end), errno(0, 'errno = 0'), declaration(parsed));
    const parserCondition = source.match(/if \((errno \|\|[^\n]+)\)/u)?.[1];
    condition('ParseIdentity', parserCondition);
    body('ParseIdentity').inner.push({ kind: 'ReturnStmt', range: range('return parsed'), inner: [ref(parsed)] });

    const sourceInput = parameter('source', 'const char *');
    const access = parameter('access', 'uint64_t');
    const ruleset = parameter('rulesetFd', 'int');
    const device = parameter('device', 'const char *');
    const inode = parameter('inode', 'const char *');
    const uid = parameter('uid', 'const char *');
    addParameters('AllowOwnedTemporaryAlias', [ruleset, sourceInput, device, inode, uid, access]);
    const flagText = source.match(/open\(source, ([^)]+)\)/u)?.[1];
    const flag = () => ({ ...integer(2097152 | 65536 | 131072 | 524288), range: range(flagText) });
    const sourceFd = { ...variable('sourceFd', 'int', [call('open', { ...ref(sourceInput), range: range('source') }, flag())]),
        range: range(`int sourceFd = open(source, ${flagText})`) };
    const aliasFd = { ...variable('aliasFd', 'int', [call('open', { ...literal('/tmp'), range: range('"/tmp"') }, flag())]),
        range: range(`int aliasFd = open("/tmp", ${flagText})`) };
    const sourceStat = { ...variable('sourceStat', 'struct stat'), range: range('struct stat sourceStat') };
    const aliasStat = { ...variable('aliasStat', 'struct stat'), range: range('struct stat aliasStat') };
    body('AllowOwnedTemporaryAlias').inner.push(declaration(sourceFd), declaration(aliasFd), declaration(sourceStat), declaration(aliasStat));
    condition('AllowOwnedTemporaryAlias', 'sourceFd < 0');
    condition('AllowOwnedTemporaryAlias', 'aliasFd < 0');
    condition('AllowOwnedTemporaryAlias', 'fstat(sourceFd, &sourceStat) < 0 || fstat(aliasFd, &aliasStat) < 0', [
        call('fstat', ref(sourceFd), address(ref(sourceStat))), call('fstat', ref(aliasFd), address(ref(aliasStat)))
    ]);
    const identityCondition = source.match(/if \((\(unsigned long long\)sourceStat[\s\S]+?)\)\n    \{/u)?.[1];
    condition('AllowOwnedTemporaryAlias', identityCondition);
    const ruleText = source.match(/LandlockPathBeneathAttr rule = \{ \.allowed_access = access, \.parent_fd = [^}]+\}/u)?.[0];
    const rule = { ...variable('rule', 'LandlockPathBeneathAttr'), range: range(ruleText) };
    body('AllowOwnedTemporaryAlias').inner.push(declaration(rule));
    condition('AllowOwnedTemporaryAlias', 'AddRule(rulesetFd, &rule) < 0', [call('AddRule', ref(ruleset), address(ref(rule)))]);
    condition('AllowOwnedTemporaryAlias', 'close(aliasFd) < 0 || close(sourceFd) < 0', [call('close', ref(aliasFd)), call('close', ref(sourceFd))]);
    const diagnostic = 'fprintf(stderr, "execution-envelope-landlock: owned-private-tmp-verified';
    const diagnosticOffset = source.indexOf(diagnostic);
    assert.ok(diagnosticOffset >= 0, 'explicit source adapter missing diagnostic');
    body('AllowOwnedTemporaryAlias').inner.push({ ...call('fprintf', ref(stderr), literal('execution-envelope-landlock'), ref(device), ref(inode), ref(uid)),
        range: { begin: { offset: diagnosticOffset }, end: { offset: diagnosticOffset, tokLen: diagnostic.length } } });
    for (const owner of ['ParseIdentity', 'AllowOwnedTemporaryAlias'])
        body(owner).inner.sort((left, right) => left.range.begin.offset - right.range.begin.offset);
    const argc = parameter('argc', 'int');
    const argv = parameter('argv', 'char **');
    const separator = variable('separator', 'int');
    addParameters('main', [argc, argv]);
    body('main').inner.push(separator);
    const slice = () => ({ kind: 'ArraySubscriptExpr', inner: [ref(argv),
        { kind: 'BinaryOperator', opcode: '+', inner: [ref(separator), integer(1)] }] });
    body('main').inner.push(call('execv', slice(), address(slice())));
    return { kind: 'TranslationUnitDecl', inner: [...declarations.values()].filter(node => !node.id.startsWith('owned-')).concat(owned) };
}

function validate(source, ast = sourceAst(source))
{
    return validateClosedOwnedCliAst(ast, { sourceBytes: Buffer.from(source), sourceFile: path.join(root, nativeFile) });
}

test('native wrapper source adapters admit current descriptor grammar without native qualification', () =>
{
    const result = validate(originalSource);
    assert.deepEqual(result.ownedInputClasses, ['main.argc', 'main.argv']);
    assert.equal(result.qualificationEligible, false);
    assert.equal(result.noSourceDigestWaiver, true);
});

for (const [name, mutate] of [
    ['missing no-follow metadata flag', source => source.replaceAll('O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC', 'O_PATH | O_DIRECTORY | O_CLOEXEC')],
    ['foreign descriptor grant', source => source.replace('.parent_fd = aliasFd', '.parent_fd = sourceFd')],
    ['missing native inode comparison', source => source.replace('sourceStat.st_ino != aliasStat.st_ino', 'sourceStat.st_ino == aliasStat.st_ino')],
    ['missing complete identity parse', source => source.replace("|| *end)", ")")],
    ['relaxed private directory mode', source => source.replace('(aliasStat.st_mode & 0777) != 0700', '(aliasStat.st_mode & 0777) != 0755')]
])
{
    test(`native wrapper source adapters refuse ${name}`, () => assert.throws(() => validate(mutate(originalSource))));
}

test('native wrapper source adapters refuse new ambient input, member and unknown AST classes', () =>
{
    for (const injected of [
        { kind: 'FutureExternalInputExpr' },
        { kind: 'MemberExpr', name: '_IO_read_ptr', isArrow: true, inner: [] },
        { kind: 'CallExpr', inner: [{ kind: 'DeclRefExpr', referencedDecl: { id: 'getenv', kind: 'FunctionDecl', name: 'getenv' } }] }
    ])
    {
        const ast = sourceAst(originalSource);
        ast.inner.find(node => node.name === 'main').inner.at(-1).inner.push(injected);
        assert.throws(() => validate(originalSource, ast), /undeclared|unresolved/u);
    }
});

test('native wrapper source adapters refuse foreign fstat descriptor and parser output', () =>
{
    for (const owner of ['AllowOwnedTemporaryAlias', 'ParseIdentity'])
    {
        const ast = sourceAst(originalSource);
        const body = ast.inner.find(node => node.name === owner).inner.at(-1);
        const findCall = node => node.kind === 'CallExpr'
            && node.inner[0].referencedDecl?.name === (owner === 'ParseIdentity' ? 'strtoull' : 'fstat') ? node
            : (node.inner ?? []).map(findCall).find(Boolean);
        const call = findCall(body);
        call.inner[owner === 'ParseIdentity' ? 2 : 1] = { kind: 'IntegerLiteral', value: '0' };
        assert.throws(() => validate(originalSource, ast), /descriptor|parser input/u);
    }
});

test('native wrapper original descriptor reader refuses aliases, shared links and in-read replacement', t =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-wrapper-input-source-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.writeFileSync(path.join(directory, 'source'), 'original bytes', { mode: 0o600 });
    assert.equal(readCommandWrapperOwnedSource(directory, 'source').toString(), 'original bytes');
    fs.symlinkSync('source', path.join(directory, 'alias'));
    assert.throws(() => readCommandWrapperOwnedSource(directory, 'alias'));
    fs.linkSync(path.join(directory, 'source'), path.join(directory, 'shared'));
    assert.throws(() => readCommandWrapperOwnedSource(directory, 'source'), /link/u);
    fs.unlinkSync(path.join(directory, 'shared'));
    const read = fs.readSync;
    let replaced = false;
    t.mock.method(fs, 'readSync', (...args) =>
    {
        const result = read(...args);
        if (!replaced)
        {
            replaced = true;
            fs.renameSync(path.join(directory, 'source'), path.join(directory, 'retained'));
            fs.writeFileSync(path.join(directory, 'source'), 'foreign! bytes', { mode: 0o600 });
        }
        return result;
    });
    assert.throws(() => readCommandWrapperOwnedSource(directory, 'source'), /epoch drift/u);
});

test('native wrapper mandatory selection cannot turn historical profile into current authority', () =>
{
    const args = { requireTools: true, operation: 'lint', domain: 'native', mode: 'full', files: [] };
    assert.equal(isMandatoryCommandWrapperInput(nativeFile, args), true);
    assert.throws(() => validateCommandWrapperInputSelection({ root, argumentsValue: args,
        selected: [], policyPath: path.join(root, 'config/development/native-tooling-style-policy.json') }), /component drift/u);
    const declaration = JSON.parse(fs.readFileSync(path.join(root, 'config/development/command-wrapper-input-registry.json')));
    assert.equal(declaration.models[0].compileBinding.canonicalHeaders.length, 115);
    assert.equal(declaration.models[0].compileBinding.semanticHeaders.length, 110);
    assert.equal(declaration.models[0].callerOwnerBinding.files.length, 42);
});


test('native wrapper original compile input guard refuses ambient toolchain values before native calls', () =>
{
    const model = JSON.parse(fs.readFileSync(path.join(root, 'config/development/command-wrapper-input-registry.json'))).models[0];
    for (const name of ['CPATH', 'C_INCLUDE_PATH', 'COMPILER_PATH', 'LD_PRELOAD'])
    {
        assert.throws(() => observeCommandWrapperCompileBinding({ root, file: nativeFile,
            entry: {}, policy: model.compileBinding, environment: { ...model.compileBinding.environment, [name]: '/foreign' } }),
        new RegExp(`compile environment contamination: ${name}`, 'u'));
    }
});

test('native wrapper original compile database guard refuses ambiguity, duplicate JSON, cached and post-read drift', t =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-wrapper-database-source-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const compileDirectory = path.join(directory, '.tmp/cmake/native-basic');
    fs.mkdirSync(compileDirectory, { recursive: true });
    const entry = { directory, file: path.join(directory, nativeFile), arguments: ['original-compiler', '-c', nativeFile] };
    const file = path.join(compileDirectory, 'compile_commands.json');
    const bytes = `${JSON.stringify([entry], null, 4)}\n`;
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    const database = { directory: compileDirectory, entries: [entry] };
    const model = JSON.parse(fs.readFileSync(path.join(root, 'config/development/command-wrapper-input-registry.json'))).models[0];
    const options = { root: directory, file: nativeFile, databases: [database], compileDatabaseCandidates: model.compileDatabaseCandidates };
    const observed = inspectCommandWrapperCompileDatabase(options);
    observed.revalidateDatabase();
    assert.throws(() => inspectCommandWrapperCompileDatabase({ ...options, databases: [database, database] }), /exactly one/u);
    fs.writeFileSync(file, bytes.replace('"directory":', '"directory": "hidden", "directory":'));
    assert.throws(() => inspectCommandWrapperCompileDatabase(options), /duplicate JSON/u);
    fs.writeFileSync(file, `${JSON.stringify([{ ...entry, arguments: ['changed'] }], null, 4)}\n`);
    assert.throws(() => inspectCommandWrapperCompileDatabase(options), /changed after selection/u);
    assert.throws(() => observed.revalidateDatabase(), /changed during analyzer/u);
    fs.writeFileSync(file, bytes);
    const current = inspectCommandWrapperCompileDatabase(options);
    fs.renameSync(file, `${file}.retained`);
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    assert.throws(() => current.revalidateDatabase(), /identity changed during analyzer/u);
});

// These are source/AST adapters only: no compiler or native execution authority.
for (const message of [
    'invalid owned temporary directory identity',
    'cannot open owned temporary directory',
    'cannot open private temporary alias',
    'cannot inspect owned temporary alias descriptors',
    'owned temporary alias object identity mismatch',
    'cannot add verified owned temporary alias rule',
    'cannot close owned temporary alias descriptors'
])
{
    test(`native wrapper source control rejects deleted terminating failure: ${message}`, () =>
    {
        const source = originalSource.replace(`Fail("${message}");`, ';');
        assert.notEqual(source, originalSource);
        const ast = sourceAst(source);
        assert.throws(() => validate(source, ast), /owned failure/u);
    });
}

for (const [name, mutate] of [
    ['NullStmt then', guard => { guard.inner[1] = { kind: 'NullStmt' }; }],
    ['Fail only in else', guard => { guard.hasElse = true; guard.inner.push(guard.inner[1]); guard.inner[1] = { kind: 'NullStmt' }; }],
    ['nested decorative Fail', guard => { guard.inner[1] = { kind: 'CompoundStmt', inner: [
        { kind: 'IfStmt', inner: [{ kind: 'IntegerLiteral', value: '0' }, guard.inner[1]] }
    ] }; }],
    ['foreign Fail identity', guard => { guard.inner[1].inner.at(-1).inner[0].referencedDecl.id = 'foreign-fail'; }]
])
{
    test(`native wrapper source control rejects ${name} failure branch`, () =>
    {
        const ast = sourceAst(originalSource);
        const guard = ast.inner.find(node => node.name === 'ParseIdentity').inner.at(-1).inner[3];
        mutate(guard);
        assert.throws(() => validate(originalSource, ast), /owned failure|decorative or nested guard/u);
    });
}

test('native wrapper source control rejects parser return and descriptor grant preceding verification', () =>
{
    const parserSource = originalSource.replace('    return parsed;', '')
        .replace("    if (errno ||", "    return parsed;\n    if (errno ||");
    const parserAst = sourceAst(parserSource);
    assert.throws(() => validate(parserSource, parserAst), /owned failure|parser return/u);
    const grant = '    LandlockPathBeneathAttr rule = { .allowed_access = access, .parent_fd = aliasFd };\n'
        + '    if (AddRule(rulesetFd, &rule) < 0)\n        Fail("cannot add verified owned temporary alias rule");\n';
    assert.ok(originalSource.includes(grant));
    const grantSource = originalSource.replace(grant, '')
        .replace('    if ((unsigned long long)sourceStat', grant + '    if ((unsigned long long)sourceStat');
    const grantAst = sourceAst(grantSource);
    assert.throws(() => validate(grantSource, grantAst), /owned failure/u);
});

for (const [name, mutate] of [
    ['missing _Exit', source => source.replace('    _Exit(125);', '')],
    ['successful _Exit', source => source.replace('_Exit(125)', '_Exit(0)')],
    ['early return', source => source.replace('    _Exit(125);', '    return;\n    _Exit(125);')]
])
{
    test(`native wrapper source control rejects Fail ${name}`, () =>
    {
        const source = mutate(originalSource);
        const ast = sourceAst(source);
        assert.throws(() => validate(source, ast), /owned Fail/u);
    });
}

test('native wrapper source control rejects conditional or extra Fail termination and extra guard', () =>
{
    for (const mutate of [
        ast =>
        {
            const statements = ast.inner.find(node => node.name === 'Fail').inner.at(-1).inner;
            const terminal = statements.pop();
            statements.push({ kind: 'IfStmt', inner: [{ kind: 'IntegerLiteral', value: '0' }, terminal] });
        },
        ast =>
        {
            const statements = ast.inner.find(node => node.name === 'Fail').inner.at(-1).inner;
            statements.splice(3, 0, structuredClone(statements.at(-1)));
        },
        ast =>
        {
            const statements = ast.inner.find(node => node.name === 'AllowOwnedTemporaryAlias').inner.at(-1).inner;
            statements.splice(6, 0, structuredClone(statements[6]));
        }
    ])
    {
        const ast = sourceAst(originalSource);
        mutate(ast);
        assert.throws(() => validate(originalSource, ast), /owned Fail|control sequence/u);
    }
});
