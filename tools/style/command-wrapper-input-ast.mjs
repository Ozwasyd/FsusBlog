import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const functions = new Set(['CreateRuleset', 'AddRule', 'RestrictSelf', 'ErrorTextForPointer',
    'ErrorTextForStatus', 'Fail', 'HandledAccessForAbi', 'AllowPath', 'ParseIdentity', 'AllowOwnedTemporaryAlias', 'main']);
const externalCalls = new Map([
    ['strcmp', new Set(['main'])], ['puts', new Set(['main'])],
    ['syscall', new Set(['CreateRuleset', 'AddRule', 'RestrictSelf'])],
    ['__errno_location', new Set(['Fail', 'ParseIdentity', 'AllowOwnedTemporaryAlias'])], ['strerror_r', new Set(['Fail'])],
    ['fputs', new Set(['Fail', 'main'])], ['fputc', new Set(['Fail'])], ['_Exit', new Set(['Fail'])],
    ['open', new Set(['AllowPath', 'AllowOwnedTemporaryAlias'])], ['close', new Set(['AllowPath', 'AllowOwnedTemporaryAlias', 'main'])],
    ['fstat', new Set(['AllowOwnedTemporaryAlias'])], ['strtoull', new Set(['ParseIdentity'])],
    ['fprintf', new Set(['AllowOwnedTemporaryAlias'])],
    ['prctl', new Set(['main'])], ['execv', new Set(['main'])]
]);
const syscallNames = { CreateRuleset: '__NR_landlock_create_ruleset', AddRule: '__NR_landlock_add_rule',
    RestrictSelf: '__NR_landlock_restrict_self' };
const syscallNumbers = { CreateRuleset: 444n, AddRule: 445n, RestrictSelf: 446n };
const allowedGlobalOutputs = new Set(['stderr']);
const functionTypes = new Map([
    ['CreateRuleset', 'int (const LandlockRulesetAttr *, size_t, uint32_t)'],
    ['AddRule', 'int (int, const LandlockPathBeneathAttr *)'], ['RestrictSelf', 'int (int)'],
    ['ErrorTextForPointer', 'const char *(char *, const char *)'],
    ['ErrorTextForStatus', 'const char *(int, const char *)'], ['Fail', 'void (const char *)'],
    ['HandledAccessForAbi', 'uint64_t (int)'], ['AllowPath', 'void (int, const char *, uint64_t)'],
    ['ParseIdentity', 'unsigned long long (const char *)'],
    ['AllowOwnedTemporaryAlias', 'void (int, const char *, const char *, const char *, const char *, uint64_t)'],
    ['main', 'int (int, char **)']
]);
const privateCalls = new Map([
    ['CreateRuleset', new Set(['main'])], ['AddRule', new Set(['AllowPath', 'AllowOwnedTemporaryAlias'])],
    ['RestrictSelf', new Set(['main'])], ['ErrorTextForPointer', new Set(['Fail'])],
    ['ErrorTextForStatus', new Set(['Fail'])], ['HandledAccessForAbi', new Set(['main'])],
    ['AllowPath', new Set(['main'])], ['ParseIdentity', new Set(['AllowOwnedTemporaryAlias'])],
    ['AllowOwnedTemporaryAlias', new Set(['main'])], ['Fail', new Set(['AllowPath', 'ParseIdentity', 'AllowOwnedTemporaryAlias', 'main'])]
]);

const temporarySelectors = new Map([['tempSource', 1n], ['tempDevice', 3n], ['tempInode', 5n], ['tempUid', 7n]]);
const statFields = new Set(['st_dev', 'st_ino', 'st_uid', 'st_mode']);
const finiteBodyKinds = new Set(['CompoundStmt', 'ReturnStmt', 'CStyleCastExpr', 'CallExpr', 'ImplicitCastExpr',
    'DeclRefExpr', 'IntegerLiteral', 'DeclStmt', 'VarDecl', 'NullStmt', 'StringLiteral', 'ConditionalOperator',
    'BinaryOperator', 'UnaryOperator', 'IfStmt', 'ForStmt', 'BreakStmt', 'ContinueStmt', 'InitListExpr',
    'MemberExpr', 'ArraySubscriptExpr', 'ParenExpr', 'GenericSelectionExpr', 'UnaryExprOrTypeTraitExpr',
    'ConstantExpr', 'CharacterLiteral', 'CompoundAssignOperator', 'BuiltinType', 'PointerType']);

function nullPointer(node)
{
    return node?.kind === 'ImplicitCastExpr' && node.castKind === 'NullToPointer'
        && constantValue(node.inner?.[0]) === 0n
        || node?.kind === 'CStyleCastExpr' && node.castKind === 'NullToPointer'
        && constantValue(node.inner?.[0]) === 0n;
}

function directLocal(node, declarations, name)
{
    node = unwrap(node);
    return node?.kind === 'DeclRefExpr' && declarations.get(node.referencedDecl?.id)?.name === name;
}

function ownedTemporarySlice(node, argvId, offset)
{
    node = unwrap(node);
    if (node?.kind !== 'ArraySubscriptExpr' || !isArgv(node.inner?.[0], argvId)) return false;
    const index = unwrap(node.inner?.[1]);
    return index?.kind === 'BinaryOperator' && index.opcode === '+'
        && unwrap(index.inner?.[0])?.referencedDecl?.name === 'index'
        && constantValue(index.inner?.[1]) === offset;
}

function walk(node, visit, parents = [])
{
    visit(node, parents);
    for (const child of node.inner ?? [])
    {
        walk(child, visit, [node, ...parents]);
    }
}

function unwrap(node)
{
    while (node && ['ImplicitCastExpr', 'ParenExpr', 'ConstantExpr'].includes(node.kind))
    {
        assert.equal(node.inner?.length, 1, 'unsupported AST wrapper');
        node = node.inner[0];
    }
    return node;
}

function point(location)
{
    return location?.expansionLoc ?? location;
}

function ownLocation(location, sourceFile)
{
    const value = point(location);
    return value && !value.includedFrom && (!value.file || value.file === sourceFile);
}

function sourceText(node, bytes)
{
    const begin = point(node.range?.begin);
    const end = point(node.range?.end);
    assert.ok(Number.isInteger(begin?.offset) && Number.isInteger(end?.offset), 'missing AST byte range');
    return bytes.subarray(begin.offset, end.offset + end.tokLen).toString().replace(/\s/gu, '');
}

function calleeNames(node)
{
    node = unwrap(node);
    if (node?.kind === 'DeclRefExpr' && node.referencedDecl?.kind === 'FunctionDecl')
    {
        return [node.referencedDecl.name];
    }
    if (node?.kind === 'GenericSelectionExpr')
    {
        const names = [];
        for (const association of node.inner ?? [])
        {
            if (association.associationKind)
            {
                const expression = association.inner?.at(-1);
                names.push(...calleeNames(expression));
            }
        }
        assert.ok(names.length > 0, 'unresolved generic callee');
        assert.deepEqual([...new Set(names)].sort(), ['ErrorTextForPointer', 'ErrorTextForStatus']);
        return names;
    }
    throw new Error(`unregistered indirect callee ${node?.kind ?? '<missing>'}`);
}

function isArgv(node, id)
{
    node = unwrap(node);
    return node?.kind === 'DeclRefExpr' && node.referencedDecl?.id === id;
}

function constantValue(node)
{
    node = unwrap(node);
    if (node.kind === 'IntegerLiteral')
    {
        return BigInt(node.value);
    }
    if (node.kind === 'BinaryOperator' && node.opcode === '|')
    {
        return constantValue(node.inner[0]) | constantValue(node.inner[1]);
    }
    throw new Error(`undeclared constant expression ${node.kind}`);
}

function references(node, id)
{
    let found = false;
    walk(node, child =>
    {
        if (child.kind === 'DeclRefExpr' && child.referencedDecl?.id === id)
        {
            found = true;
        }
    });
    return found;
}

function declarationFamilies(declarations)
{
    const roots = new Map();
    const families = new Map();
    for (const declaration of declarations.values())
    {
        let current = declaration;
        const seen = new Set();
        while (current.previousDecl)
        {
            assert.ok(!seen.has(current.id), 'cyclic canonical declaration family');
            seen.add(current.id);
            current = declarations.get(current.previousDecl);
            assert.ok(current, 'unresolved canonical declaration family');
        }
        roots.set(declaration.id, current.id);
        if (!families.has(current.id))
        {
            families.set(current.id, []);
        }
        families.get(current.id).push(declaration);
    }
    return new Map([...roots].map(([id, root]) => [id, families.get(root)]));
}

function argvSlice(node, argvId, separatorId)
{
    node = unwrap(node);
    if (node?.kind !== 'ArraySubscriptExpr' || !isArgv(node.inner?.[0], argvId))
    {
        return false;
    }
    const index = unwrap(node.inner[1]);
    return index?.kind === 'BinaryOperator' && index.opcode === '+'
        && unwrap(index.inner?.[0])?.referencedDecl?.id === separatorId
        && unwrap(index.inner?.[1])?.kind === 'IntegerLiteral' && unwrap(index.inner[1]).value === '1';
}

function requireOwnedFailTermination(definition)
{
    const statements = definition.inner.find(node => node.kind === 'CompoundStmt').inner ?? [];
    assert.ok(statements.length > 0 && statements.every(node => ['DeclStmt', 'CallExpr'].includes(node.kind)),
        'owned Fail must terminate without a conditional or early-return escape');
    let exits = 0;
    walk(definition.inner.find(node => node.kind === 'CompoundStmt'), node =>
    {
        if (node.kind === 'CallExpr' && calleeNames(node.inner[0]).includes('_Exit')) exits++;
        assert.ok(!['ReturnStmt', 'IfStmt', 'ForStmt', 'WhileStmt', 'DoStmt', 'ConditionalOperator'].includes(node.kind),
            'owned Fail termination control escape');
    });
    assert.equal(exits, 1, 'owned Fail terminal exit must be unique');
    const terminal = unwrap(statements.at(-1));
    assert.ok(terminal.kind === 'CallExpr' && calleeNames(terminal.inner[0]).length === 1
        && calleeNames(terminal.inner[0])[0] === '_Exit' && terminal.inner.length === 2
        && constantValue(terminal.inner[1]) === 125n, 'owned Fail must end in original _Exit(125)');
}

function requireOwnedFailureBranch(statement, condition, message, errnoValue, sourceBytes, ownedFail)
{
    assert.ok(statement?.kind === 'IfStmt' && !statement.hasElse && statement.inner?.length === 2,
        'owned failure guard must be a direct if without an else or decorative branch');
    assert.equal(sourceText(statement.inner[0], sourceBytes), condition, 'owned failure condition drift');
    const then = statement.inner[1];
    const branch = then.kind === 'CompoundStmt' ? then.inner ?? [] : [then];
    assert.equal(branch.length, errnoValue ? 2 : 1, 'owned failure branch must directly terminate');
    if (errnoValue)
    {
        assert.ok(branch[0].kind === 'BinaryOperator' && branch[0].opcode === '=', 'owned failure errno assignment drift');
        assert.equal(sourceText(branch[0], sourceBytes), `errno=${errnoValue}`, 'owned failure errno owner drift');
    }
    const failure = unwrap(branch.at(-1));
    const callee = unwrap(failure?.inner?.[0]);
    assert.ok(failure?.kind === 'CallExpr' && failure.inner.length === 2
        && callee?.kind === 'DeclRefExpr' && callee.referencedDecl?.id === ownedFail.id
        && callee.referencedDecl.name === 'Fail', 'owned failure branch lacks bound terminating Fail');
    assert.equal(sourceText(failure, sourceBytes), `Fail(${JSON.stringify(message)})`.replace(/\s/gu, ''),
        'owned failure branch source differs from its terminating call');
}

function requireTemporaryDescriptorProof(definition, sourceBytes, ownedFail)
{
    if (!['ParseIdentity', 'AllowOwnedTemporaryAlias'].includes(definition.name)) return;
    const body = definition.inner.find(node => node.kind === 'CompoundStmt');
    const statements = body.inner ?? [];
    const conditions = [];
    const calls = [];
    walk(body, node =>
    {
        if (node.kind === 'IfStmt') conditions.push(node);
        if (node.kind === 'CallExpr') calls.push(...calleeNames(node.inner[0]));
    });
    const declaration = (statement, name) =>
    {
        assert.ok(statement?.kind === 'DeclStmt' && statement.inner?.length === 1
            && statement.inner[0].kind === 'VarDecl' && statement.inner[0].name === name,
        'owned descriptor declaration sequence drift');
        return statement.inner[0];
    };
    if (definition.name === 'ParseIdentity')
    {
        assert.equal(statements.length, 5, 'identity parser top-level control sequence drift');
        declaration(statements[0], 'end');
        assert.equal(sourceText(statements[1], sourceBytes), 'errno=0', 'identity parser errno reset drift');
        const parsed = declaration(statements[2], 'parsed');
        assert.equal(calls.filter(name => name === 'strtoull').length, 1, 'identity parser call closure drift');
        assert.ok(parsed.inner?.length === 1 && unwrap(parsed.inner[0]).kind === 'CallExpr'
            && calleeNames(unwrap(parsed.inner[0]).inner[0])[0] === 'strtoull', 'identity parser result owner drift');
        assert.equal(conditions.length, 1, 'identity parser decorative or nested guard');
        requireOwnedFailureBranch(statements[3], "errno||!value[0]||value[0]=='-'||value[0]=='+'||*end",
            'invalid owned temporary directory identity', 'EINVAL', sourceBytes, ownedFail);
        const returned = unwrap(statements[4]?.inner?.[0]);
        assert.ok(statements[4]?.kind === 'ReturnStmt' && statements[4].inner.length === 1
            && returned?.kind === 'DeclRefExpr' && returned.referencedDecl?.id === parsed.id,
        'identity parser return must follow its terminating failure guard');
        return;
    }
    assert.equal(statements.length, 12, 'temporary descriptor top-level control sequence drift');
    declaration(statements[0], 'sourceFd');
    requireOwnedFailureBranch(statements[1], 'sourceFd<0', 'cannot open owned temporary directory', null, sourceBytes, ownedFail);
    declaration(statements[2], 'aliasFd');
    requireOwnedFailureBranch(statements[3], 'aliasFd<0', 'cannot open private temporary alias', null, sourceBytes, ownedFail);
    declaration(statements[4], 'sourceStat');
    declaration(statements[5], 'aliasStat');
    assert.equal(conditions.length, 6, 'temporary descriptor decorative or nested guard');
    assert.equal(calls.filter(name => name === 'fstat').length, 2, 'temporary descriptor observation closure drift');
    assert.equal(calls.filter(name => name === 'open').length, 2, 'temporary descriptor acquisition closure drift');
    assert.equal(calls.filter(name => name === 'AddRule').length, 1, 'temporary descriptor grant closure drift');
    requireOwnedFailureBranch(statements[6], 'fstat(sourceFd,&sourceStat)<0||fstat(aliasFd,&aliasStat)<0',
        'cannot inspect owned temporary alias descriptors', null, sourceBytes, ownedFail);
    requireOwnedFailureBranch(statements[7], '(unsignedlonglong)sourceStat.st_dev!=ParseIdentity(device)'
        + '||(unsignedlonglong)sourceStat.st_ino!=ParseIdentity(inode)'
        + '||(unsignedlonglong)sourceStat.st_uid!=ParseIdentity(uid)'
        + '||sourceStat.st_dev!=aliasStat.st_dev||sourceStat.st_ino!=aliasStat.st_ino'
        + '||sourceStat.st_uid!=aliasStat.st_uid||(sourceStat.st_mode&0777)!=0700||(aliasStat.st_mode&0777)!=0700',
    'owned temporary alias object identity mismatch', 'EACCES', sourceBytes, ownedFail);
    declaration(statements[8], 'rule');
    requireOwnedFailureBranch(statements[9], 'AddRule(rulesetFd,&rule)<0',
        'cannot add verified owned temporary alias rule', null, sourceBytes, ownedFail);
    requireOwnedFailureBranch(statements[10], 'close(aliasFd)<0||close(sourceFd)<0',
        'cannot close owned temporary alias descriptors', null, sourceBytes, ownedFail);
    assert.ok(statements[11]?.kind === 'CallExpr' && calleeNames(statements[11].inner[0])[0] === 'fprintf',
        'temporary descriptor terminal diagnostic sequence drift');
    walk(definition.inner.find(node => node.kind === 'CompoundStmt'), (node, parents) =>
    {
        if (node.kind !== 'CallExpr' || !calleeNames(node.inner[0]).includes('open')) return;
        const variable = parents.find(parent => parent.kind === 'VarDecl');
        assert.ok(variable && (variable.name === 'sourceFd' && sourceText(node.inner[1], sourceBytes) === 'source'
            || variable.name === 'aliasFd' && sourceText(node.inner[1], sourceBytes) === '"/tmp"'),
        'temporary descriptor path or acquisition owner drift');
    });
    const grants = [];
    walk(definition.inner.find(node => node.kind === 'CompoundStmt'), node =>
    {
        if (node.kind === 'VarDecl' && node.name === 'rule') grants.push(sourceText(node, sourceBytes));
    });
    assert.deepEqual(grants, ['LandlockPathBeneathAttrrule={.allowed_access=access,.parent_fd=aliasFd}'],
        'temporary grant must consume its exact verified descriptor');
}

export function validateClosedOwnedCliAst(ast, { sourceBytes, sourceFile })
{
    assert.equal(ast.kind, 'TranslationUnitDecl', 'not a complete translation unit');
    walk(ast, node =>
    {
        assert.ok(!['FileScopeAsmDecl', 'ConstructorAttr', 'DestructorAttr', 'IFuncAttr', 'CleanupAttr'].includes(node.kind),
            'undeclared translation-unit execution hook');
    });
    const owned = (ast.inner ?? []).filter(node => node.kind === 'FunctionDecl'
        && node.inner?.some(child => child.kind === 'CompoundStmt') && ownLocation(node.loc, sourceFile));
    for (const node of ast.inner ?? [])
    {
        assert.ok(node.kind !== 'VarDecl' || !ownLocation(node.loc, sourceFile), 'undeclared source global input or output alias');
        if (node.kind === 'FunctionDecl' && ownLocation(node.loc, sourceFile))
        {
            assert.ok(functions.has(node.name), 'undeclared source function redeclaration');
            assert.ok(!node.inner?.some(child => child.kind?.endsWith('Attr')), 'undeclared function execution attribute');
            assert.equal(node.type?.qualType, functionTypes.get(node.name), 'private ABI/input parameter drift');
        }
    }
    assert.deepEqual(owned.map(node => node.name).sort(), [...functions].sort(), 'registered private function closure drift');
    const ownedFail = owned.find(node => node.name === 'Fail');
    requireOwnedFailTermination(ownedFail);
    const main = owned.find(node => node.name === 'main');
    const parameters = main.inner.filter(node => node.kind === 'ParmVarDecl');
    assert.equal(parameters.length, 2, 'undeclared main environment input');
    assert.equal(parameters[0].type.qualType, 'int', 'argc input type drift');
    assert.equal(parameters[1].type.qualType, 'char **', 'argv input type drift');
    const argvId = parameters[1].id;
    const globalIds = new Map();
    walk(ast, node =>
    {
        if (node.kind === 'VarDecl')
        {
            globalIds.set(node.id, node);
        }
    });
    const functionDeclarations = new Map();
    walk(ast, node =>
    {
        if (node.kind === 'FunctionDecl')
        {
            functionDeclarations.set(node.id, node);
        }
    });
    const globalFamilies = declarationFamilies(globalIds);
    const functionFamilies = declarationFamilies(functionDeclarations);
    let execCalls = 0;
    const admittedCalls = [];
    for (const definition of owned)
    {
        const body = definition.inner.find(node => node.kind === 'CompoundStmt');
        requireTemporaryDescriptorProof(definition, sourceBytes, ownedFail);
        const localDeclarations = new Map(definition.inner.filter(node => node.kind === 'ParmVarDecl').map(node => [node.id, node]));
        const localIds = new Set(localDeclarations.keys());
        let separatorId;
        walk(body, node =>
        {
            if (node.kind === 'VarDecl')
            {
                assert.notEqual(node.storageClass, 'extern', 'undeclared block extern input');
                const localType = node.type?.desugaredQualType ?? node.type?.qualType ?? '';
                if (localType.includes('*'))
                {
                    const diagnostic = definition.name === 'Fail' && node.name === 'errorMessage'
                        && localType === 'const char *' && node.inner?.at(-1)?.kind === 'CallExpr';
                    const temporary = definition.name === 'main' && temporarySelectors.has(node.name)
                        && localType === 'const char *' && node.inner?.length === 1 && nullPointer(node.inner[0]);
                    const parseEnd = definition.name === 'ParseIdentity' && node.name === 'end'
                        && localType === 'char *' && node.inner?.length === 1 && nullPointer(node.inner[0]);
                    assert.ok(diagnostic || temporary || parseEnd,
                    'undeclared local pointer input or alias');
                    if (diagnostic)
                    {
                        assert.deepEqual(calleeNames(node.inner.at(-1).inner[0]).sort(), ['ErrorTextForPointer', 'ErrorTextForStatus'],
                            'diagnostic pointer input owner drift');
                    }
                }
                if (localType.includes('['))
                {
                    assert.ok(definition.name === 'Fail' && node.name === 'errorBuffer'
                        && localType === 'char[1024]' && !node.inner?.length, 'undeclared local memory input');
                }
                localIds.add(node.id);
                localDeclarations.set(node.id, node);
                if (definition.name === 'main' && node.name === 'separator')
                {
                    separatorId = node.id;
                }
            }
        });
        walk(body, (node, parents) =>
        {
            assert.ok(finiteBodyKinds.has(node.kind) || ['case', 'default'].includes(node.associationKind), `undeclared AST body shape ${node.kind}`);
            assert.ok(!['GCCAsmStmt', 'MSAsmStmt', 'BlockExpr'].includes(node.kind), 'undeclared opaque execution surface');
            assert.ok(!node.kind?.endsWith('Attr'), 'undeclared declaration execution attribute');
            if (node.kind === 'MemberExpr')
            {
                const base = unwrap(node.inner?.[0]);
                assert.ok(definition.name === 'AllowOwnedTemporaryAlias' && !node.isArrow
                    && statFields.has(node.name) && ['sourceStat', 'aliasStat'].some(name => directLocal(base, localDeclarations, name))
                    && base.type?.qualType === 'struct stat', 'undeclared member memory input');
            }
            if (node.kind === 'UnaryOperator' && node.opcode === '*')
            {
                const target = unwrap(node.inner[0]);
                const errno = ['Fail', 'ParseIdentity', 'AllowOwnedTemporaryAlias'].includes(definition.name)
                    && target?.kind === 'CallExpr'
                    && calleeNames(target.inner[0]).every(callee => callee === '__errno_location');
                assert.ok(errno || definition.name === 'ParseIdentity' && directLocal(target, localDeclarations, 'end'), 'undeclared indirect memory input');
            }
            assert.ok(node.kind !== 'CStyleCastExpr' || !node.type?.qualType?.includes('*')
                || (node.castKind === 'NullToPointer' && constantValue(node.inner[0]) === 0n), 'undeclared pointer reinterpretation');
            if (definition.name === 'main' && node.kind === 'VarDecl')
            {
                assert.ok(!references(node, argvId), 'owned argv alias escape');
            }
            if (['BinaryOperator', 'CompoundAssignOperator'].includes(node.kind)
                && ['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '^=', '|='].includes(node.opcode))
            {
                const target = unwrap(node.inner[0]);
                const temporary = definition.name === 'main' && node.opcode === '='
                    && target?.kind === 'DeclRefExpr' && temporarySelectors.has(target.referencedDecl?.name)
                    && localIds.has(target.referencedDecl.id) && target.type?.qualType === 'const char *'
                    && ownedTemporarySlice(node.inner[1], argvId, temporarySelectors.get(target.referencedDecl.name));
                const errno = ['ParseIdentity', 'AllowOwnedTemporaryAlias'].includes(definition.name)
                    && node.opcode === '=' && target?.kind === 'UnaryOperator' && target.opcode === '*'
                    && unwrap(target.inner[0])?.kind === 'CallExpr'
                    && calleeNames(unwrap(target.inner[0]).inner[0]).every(callee => callee === '__errno_location');
                assert.ok(temporary || errno || target?.kind === 'DeclRefExpr' && localIds.has(target.referencedDecl?.id)
                    && !target.type?.qualType?.includes('*'), 'indirect or pointer write outside local scalar ownership');
                assert.ok(!references(node.inner[0], argvId), 'owned argv mutation');
            }
            if (node.kind === 'UnaryOperator' && ['++', '--'].includes(node.opcode))
            {
                const target = unwrap(node.inner[0]);
                assert.ok(target?.kind === 'DeclRefExpr' && localIds.has(target.referencedDecl?.id)
                    && !target.type?.qualType?.includes('*'), 'indirect or pointer mutation outside local scalar ownership');
                assert.ok(!references(node.inner[0], argvId), 'owned argv mutation');
            }
            if (node.kind === 'DeclRefExpr' && node.referencedDecl?.kind === 'VarDecl'
                && !localIds.has(node.referencedDecl.id))
            {
                const declaration = globalIds.get(node.referencedDecl.id);
                const name = declaration?.name ?? node.referencedDecl.name;
                assert.ok(allowedGlobalOutputs.has(name), `undeclared ambient input ${name}`);
                assert.ok(declaration?.storageClass === 'extern' && declaration.type?.qualType === 'FILE *',
                    'global diagnostic output declaration drift');
                for (const member of globalFamilies.get(declaration.id) ?? [])
                {
                    assert.ok(member.storageClass === 'extern' && member.type?.qualType === 'FILE *' && !member.init
                        && !member.inner?.some(child => ['AsmLabelAttr', 'AliasAttr', 'IFuncAttr'].includes(child.kind)),
                    'global diagnostic output canonical family drift');
                }
                let globalDeclaration = declaration;
                const seenDeclarations = new Set();
                while (globalDeclaration)
                {
                    assert.ok(!seenDeclarations.has(globalDeclaration.id), 'cyclic output declaration chain');
                    seenDeclarations.add(globalDeclaration.id);
                    assert.ok(!globalDeclaration.init && !globalDeclaration.inner?.some(child => ['AsmLabelAttr', 'AliasAttr', 'IFuncAttr'].includes(child.kind)),
                        'global diagnostic output redirected by declaration');
                    if (!globalDeclaration.previousDecl)
                    {
                        break;
                    }
                    globalDeclaration = globalIds.get(globalDeclaration.previousDecl);
                    assert.ok(globalDeclaration, 'unresolved output declaration chain');
                }
                const call = parents.find(parent => parent.kind === 'CallExpr');
                assert.ok(call && calleeNames(call.inner[0]).every(callee => ['fputs', 'fputc', 'fprintf'].includes(callee)),
                    'global stream reference outside diagnostic output');
                assert.ok(call.inner.slice(1).some(argument => unwrap(argument)?.kind === 'DeclRefExpr'
                    && unwrap(argument).id === node.id), 'global stream data dereference');
            }
            if (node.kind !== 'CallExpr')
            {
                return;
            }
            const callees = calleeNames(node.inner[0]);
            for (const callee of callees)
            {
                if (!functions.has(callee))
                {
                    assert.ok(externalCalls.get(callee)?.has(definition.name), `undeclared input/call ${definition.name}:${callee}`);
                    walk(node.inner[0], reference =>
                    {
                        if (reference.kind === 'DeclRefExpr' && reference.referencedDecl?.kind === 'FunctionDecl')
                        {
                            const declaration = functionDeclarations.get(reference.referencedDecl.id);
                            assert.ok(declaration, 'unresolved external call declaration');
                            for (const member of functionFamilies.get(declaration.id) ?? [])
                            {
                                assert.ok(!member.inner?.some(child => child.kind === 'CompoundStmt'
                                    || ['AsmLabelAttr', 'AliasAttr', 'IFuncAttr'].includes(child.kind)),
                                'external call canonical family redirected');
                            }
                            let externalDeclaration = declaration;
                            const seenDeclarations = new Set();
                            while (externalDeclaration)
                            {
                                assert.ok(!seenDeclarations.has(externalDeclaration.id), 'cyclic external declaration chain');
                                seenDeclarations.add(externalDeclaration.id);
                                assert.ok(!externalDeclaration.inner?.some(child => child.kind === 'CompoundStmt'),
                                    'external call redirected to an unreviewed definition');
                                assert.ok(!externalDeclaration.inner?.some(child => ['AsmLabelAttr', 'AliasAttr', 'IFuncAttr'].includes(child.kind)),
                                    'external call redirected by declaration alias');
                                if (!externalDeclaration.previousDecl)
                                {
                                    break;
                                }
                                externalDeclaration = functionDeclarations.get(externalDeclaration.previousDecl);
                                assert.ok(externalDeclaration, 'unresolved external declaration chain');
                            }
                        }
                    });
                }
                else
                {
                    assert.ok(privateCalls.get(callee)?.has(definition.name), 'private input/call ownership drift');
                }
                if (callee === 'syscall')
                {
                    assert.equal(sourceText(node.inner[1], sourceBytes), syscallNames[definition.name], 'undeclared syscall input');
                    assert.equal(constantValue(node.inner[1]), syscallNumbers[definition.name], 'syscall macro semantic drift');
                }
                if (callee === 'open')
                {
                    const flags = definition.name === 'AllowOwnedTemporaryAlias' ? 'O_PATH|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC' : 'O_PATH|O_CLOEXEC';
                    const bits = definition.name === 'AllowOwnedTemporaryAlias' ? 2097152n | 65536n | 131072n | 524288n : 2097152n | 524288n;
                    assert.equal(sourceText(node.inner[2], sourceBytes), flags, 'data-reading open is not metadata admission');
                    assert.equal(constantValue(node.inner[2]), bits, 'open macro semantic drift');
                }
                if (callee === 'fstat')
                {
                    const address = unwrap(node.inner[2]);
                    assert.equal(node.inner.length, 3, 'metadata descriptor interface drift');
                    assert.ok(address?.kind === 'UnaryOperator' && address.opcode === '&'
                        && [['sourceFd', 'sourceStat'], ['aliasFd', 'aliasStat']].some(([fd, stat]) =>
                            directLocal(node.inner[1], localDeclarations, fd) && directLocal(address.inner[0], localDeclarations, stat)),
                    'metadata descriptor or output ownership drift');
                }
                if (callee === 'strtoull')
                {
                    const end = unwrap(node.inner[2]);
                    assert.equal(node.inner.length, 4, 'identity parser interface drift');
                    assert.ok(directLocal(node.inner[1], localDeclarations, 'value') && end?.kind === 'UnaryOperator'
                        && end.opcode === '&' && directLocal(end.inner[0], localDeclarations, 'end')
                        && constantValue(node.inner[3]) === 10n, 'identity parser input/output drift');
                }
                if (callee === 'prctl')
                {
                    assert.equal(node.inner.length, 6, 'no-new-privileges interface drift');
                    assert.deepEqual(node.inner.slice(1).map(constantValue), [38n, 1n, 0n, 0n, 0n], 'undeclared process input or output operation');
                }
                if (callee === 'execv')
                {
                    execCalls++;
                    assert.equal(node.inner.length, 3, 'exec interface drift');
                    assert.ok(argvSlice(node.inner[1], argvId, separatorId), 'executable is not original owned CLI slice');
                    const argumentsAddress = unwrap(node.inner[2]);
                    assert.ok(argumentsAddress?.kind === 'UnaryOperator' && argumentsAddress.opcode === '&'
                        && argvSlice(argumentsAddress.inner?.[0], argvId, separatorId), 'arguments are not original owned CLI slice');
                }
                admittedCalls.push({ owner: definition.name, callee });
            }
        });
    }
    assert.equal(execCalls, 1, 'exec sink closure drift');
    return { ownedInputClasses: ['main.argc', 'main.argv'], admittedCalls,
        unknownInputsRejected: true, noSourceDigestWaiver: true, qualificationEligible: false };
}

// This diagnostic entry point never selects an authority or approves a native lint result.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        assert.equal(process.argv.length, 4, 'expected --source <absolute-path> and AST JSON on stdin');
        assert.equal(process.argv[2], '--source', 'unknown AST diagnostic option');
        const sourceFile = process.argv[3];
        assert.ok(path.isAbsolute(sourceFile), 'source path must be absolute');
        assert.ok(fs.lstatSync(sourceFile).isFile(), 'source must be a regular file');
        assert.ok(fs.statSync(sourceFile).size <= 1024 * 1024, 'source exceeds diagnostic limit');
        const sourceBytes = fs.readFileSync(sourceFile);
        const astBytes = fs.readFileSync(0);
        assert.ok(astBytes.length <= 16 * 1024 * 1024, 'AST exceeds diagnostic limit');
        const result = validateClosedOwnedCliAst(JSON.parse(astBytes.toString('utf8')), { sourceBytes, sourceFile });
        process.stdout.write(`${JSON.stringify(result)}\n`);
    }
    catch (error)
    {
        process.stderr.write(`AST diagnostic refused: ${error.message}\n`);
        process.exitCode = 1;
    }
}
