import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Unpromoted v2 semantic probe; the historical v1 checker and registry never select this module.
const functions = new Set(['ParseIdentity', 'AllowOwnedTemporaryAlias', 'CreateRuleset', 'AddRule', 'RestrictSelf', 'ErrorTextForPointer',
    'ErrorTextForStatus', 'Fail', 'HandledAccessForAbi', 'AllowPath', 'main']);
const externalCalls = new Map([
    ['strcmp', new Set(['main'])], ['puts', new Set(['main'])],
    ['syscall', new Set(['CreateRuleset', 'AddRule', 'RestrictSelf'])],
    ['__errno_location', new Set(['Fail', 'AllowPath', 'ParseIdentity', 'AllowOwnedTemporaryAlias'])], ['strerror_r', new Set(['Fail'])],
    ['fputs', new Set(['Fail', 'main', 'AllowOwnedTemporaryAlias'])], ['fputc', new Set(['Fail', 'AllowOwnedTemporaryAlias'])], ['_Exit', new Set(['Fail'])],
    ['open', new Set(['AllowPath', 'AllowOwnedTemporaryAlias'])], ['close', new Set(['AllowPath', 'main', 'AllowOwnedTemporaryAlias'])],
    ['strtoull', new Set(['ParseIdentity'])], ['fstat', new Set(['AllowOwnedTemporaryAlias'])],
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
    ['AllowPath', new Set(['main'])], ['AllowOwnedTemporaryAlias', new Set(['main'])],
    ['ParseIdentity', new Set(['AllowOwnedTemporaryAlias'])],
    ['Fail', new Set(['AllowPath', 'main', 'ParseIdentity', 'AllowOwnedTemporaryAlias'])]
]);

const metadataNames = new Set(['tempSource', 'tempDevice', 'tempInode', 'tempUid']);
const metadataAssignments = new Set([
    'tempSource=argv[index+1]', 'tempDevice=argv[index+3]',
    'tempInode=argv[index+5]', 'tempUid=argv[index+7]'
]);

function tokens(text, names = new Map())
{
    return (text.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|\/\*[\s\S]*?\*\/|[A-Za-z_][A-Za-z0-9_]*|[^\s]/gu) ?? [])
        .filter(token => !token.startsWith('//') && !token.startsWith('/*'))
        .map(token => names.get(token) ?? token).join('');
}

function sourceTokens(node, bytes, names)
{
    const begin = point(node?.range?.begin);
    const end = point(node?.range?.end);
    assert.ok(Number.isInteger(begin?.offset) && Number.isInteger(end?.offset), 'missing metadata AST byte range');
    return tokens(bytes.subarray(begin.offset, end.offset + end.tokLen).toString(), names);
}

// Each statement is a finite effect/guard production, not a digest exemption or an analyzer filter.
// The old v1 authority does not import this grammar or acquire controlled-environment options.
const metadataProductions = new Map([
    ['AllowPath', [
        'if (path == NULL) { errno = EINVAL; Fail("cannot open declared filesystem path"); }',
        'int pathFd = open(path, O_PATH | O_CLOEXEC);',
        'if (pathFd < 0) { Fail("cannot open declared filesystem path"); }',
        'LandlockPathBeneathAttr rule = {.allowed_access = access, .parent_fd = pathFd,};',
        'if (AddRule(rulesetFd, &rule) < 0) { Fail("cannot add filesystem rule"); }',
        'if (close(pathFd) < 0) { Fail("cannot close filesystem rule path"); }'
    ]],
    ['ParseIdentity', [
        'char* end = NULL;',
        'errno = 0',
        'unsigned long long parsed = strtoull(value, &end, 10);',
        `if (errno || !value[0] || value[0] == '-' || value[0] == '+' || *end)
        { errno = EINVAL; Fail("invalid owned temporary directory identity"); }`,
        'return parsed'
    ]],
    ['AllowOwnedTemporaryAlias', [
        'int sourceFd = open(source, O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);',
        'if (sourceFd < 0) { Fail("cannot open owned temporary directory"); }',
        'int aliasFd = open("/tmp", O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);',
        'if (aliasFd < 0) { Fail("cannot open private temporary alias"); }',
        'FileStatus sourceStat;',
        'FileStatus aliasStat;',
        'if (fstat(sourceFd, &sourceStat) < 0 || fstat(aliasFd, &aliasStat) < 0) { Fail("cannot inspect owned temporary alias descriptors"); }',
        `if ((unsigned long long)sourceStat.st_dev != ParseIdentity(device)
            || (unsigned long long)sourceStat.st_ino != ParseIdentity(inode)
            || (unsigned long long)sourceStat.st_uid != ParseIdentity(uid)
            || sourceStat.st_dev != aliasStat.st_dev || sourceStat.st_ino != aliasStat.st_ino
            || sourceStat.st_uid != aliasStat.st_uid || (sourceStat.st_mode & 0777) != 0700
            || (aliasStat.st_mode & 0777) != 0700)
        { errno = EACCES; Fail("owned temporary alias object identity mismatch"); }`,
        'LandlockPathBeneathAttr rule = {.allowed_access = access, .parent_fd = aliasFd};',
        'if (AddRule(rulesetFd, &rule) < 0) { Fail("cannot add verified owned temporary alias rule"); }',
        'if (close(aliasFd) < 0 || close(sourceFd) < 0) { Fail("cannot close owned temporary alias descriptors"); }',
        'fputs("execution-envelope-landlock: owned-private-tmp-verified device=", stderr)',
        'fputs(device, stderr)',
        'fputs(" inode=", stderr)',
        'fputs(inode, stderr)',
        'fputs(" uid=", stderr)',
        'fputs(uid, stderr)',
        "fputc('\\n', stderr)"
    ]]
]);

const metadataMainGuards = [
    `if (strcmp(argv[index], "--owned-tmp-source") == 0 && index + 7 < argc
        && strcmp(argv[index + 2], "--owned-tmp-device") == 0
        && strcmp(argv[index + 4], "--owned-tmp-inode") == 0
        && strcmp(argv[index + 6], "--owned-tmp-uid") == 0 && !tempSource)
    { tempSource = argv[index + 1]; tempDevice = argv[index + 3];
        tempInode = argv[index + 5]; tempUid = argv[index + 7]; index += 7; continue; }`,
    `if (tempSource)
    { AllowOwnedTemporaryAlias(rulesetFd, tempSource, tempDevice, tempInode, tempUid, handledAccess); }`,
    'if (tempSource && strcmp(argv[index + 1], tempSource) == 0) { continue; }'
].map(text => tokens(text));

function validateMetadataGrammar(owned, bytes, parameters, metadataIds)
{
    const roleMaps = new Map();
    const roles = new Map([
        ['AllowPath', { parameters: ['rulesetFd', 'path', 'access'], locals: ['pathFd', 'rule'] }],
        ['ParseIdentity', { parameters: ['value'], locals: ['end', 'parsed'] }],
        ['AllowOwnedTemporaryAlias', { parameters: ['rulesetFd', 'source', 'device', 'inode', 'uid', 'access'],
            locals: ['sourceFd', 'aliasFd', 'sourceStat', 'aliasStat', 'rule'] }]
    ]);
    const expectedCalls = new Map([
        ['AllowPath', ['__errno_location', 'open', 'AddRule', 'close', 'Fail', 'Fail', 'Fail', 'Fail']],
        ['ParseIdentity', ['__errno_location', '__errno_location', '__errno_location', 'strtoull', 'Fail']],
        ['AllowOwnedTemporaryAlias', ['open', 'open', 'fstat', 'fstat', 'ParseIdentity', 'ParseIdentity',
            'ParseIdentity', '__errno_location', 'AddRule', 'close', 'close', 'Fail', 'Fail', 'Fail', 'Fail',
            'Fail', 'Fail', 'fputs', 'fputs', 'fputs', 'fputs', 'fputs', 'fputs', 'fputc']]
    ]);
    for (const [name, productions] of metadataProductions)
    {
        const definition = owned.find(node => node.name === name);
        const body = definition?.inner?.find(node => node.kind === 'CompoundStmt');
        assert.ok(body, 'missing finite metadata owner');
        const declarations = definition.inner.filter(node => node.kind === 'ParmVarDecl');
        const locals = [];
        walk(body, node =>
        {
            if (node.kind === 'VarDecl')
            {
                locals.push(node);
            }
        });
        assert.equal(declarations.length, roles.get(name).parameters.length, 'metadata parameter role closure drift');
        assert.equal(locals.length, roles.get(name).locals.length, 'metadata local role closure drift');
        const names = new Map([
            ...declarations.map((node, index) => [node.name, roles.get(name).parameters[index]]),
            ...locals.map((node, index) => [node.name, roles.get(name).locals[index]])
        ]);
        assert.equal(names.size, declarations.length + locals.length, 'metadata shadowed role alias');
        roleMaps.set(name, names);
        const role = node => names.get(node?.referencedDecl?.name);
        assert.deepEqual(body.inner.map(node => sourceTokens(node, bytes, names)), productions.map(text => tokens(text)),
            `metadata guard/effect production drift: ${name}`);
        const calls = [];
        const closedDescriptors = [];
        walk(body, node =>
        {
            if (node.kind === 'BinaryOperator' && node.opcode === '=')
            {
                const spelling = sourceTokens(node, bytes, names);
                const errors = new Map([['errno=0', 0n], ['errno=EINVAL', 22n], ['errno=EACCES', 13n]]);
                assert.ok(errors.has(spelling), 'metadata scalar error assignment drift');
                assert.equal(constantValue(node.inner[1]), errors.get(spelling), 'metadata errno macro semantic drift');
            }
            if (node.kind === 'MemberExpr')
            {
                assert.equal(sourceTokens(node, bytes, names), `${role(unwrap(node.inner[0]))}.${node.name}`,
                    'metadata field macro semantic drift');
            }
            if (node.kind !== 'CallExpr')
            {
                return;
            }
            const [callee] = calleeNames(node.inner[0]);
            calls.push(callee);
            const argumentsValue = node.inner.slice(1).map(argument => unwrap(argument));
            if (callee === 'strtoull')
            {
                assert.equal(role(argumentsValue[0]), 'value', 'decimal input owner drift');
                assert.equal(argumentsValue[1]?.opcode, '&', 'decimal end cursor ownership drift');
                assert.equal(role(unwrap(argumentsValue[1]?.inner?.[0])), 'end', 'foreign decimal end cursor');
                assert.equal(constantValue(argumentsValue[2]), 10n, 'decimal base macro semantic drift');
            }
            if (callee === 'open' && name === 'AllowPath')
            {
                assert.equal(role(argumentsValue[0]), 'path', 'declared path open operand drift');
            }
            if (callee === 'fstat')
            {
                const descriptor = role(argumentsValue[0]);
                const status = role(unwrap(argumentsValue[1]?.inner?.[0]));
                assert.equal(argumentsValue[1]?.opcode, '&', 'status observation address drift');
                assert.ok((descriptor === 'sourceFd' && status === 'sourceStat')
                    || (descriptor === 'aliasFd' && status === 'aliasStat'), 'status descriptor macro semantic drift');
            }
            if (callee === 'close')
            {
                assert.equal(argumentsValue.length, 1, 'metadata close interface drift');
                closedDescriptors.push(role(argumentsValue[0]));
            }
            if (callee === 'AddRule')
            {
                assert.equal(role(argumentsValue[0]), 'rulesetFd', 'metadata ruleset owner drift');
                assert.equal(argumentsValue[1]?.opcode, '&', 'metadata rule address drift');
                assert.equal(role(unwrap(argumentsValue[1]?.inner?.[0])), 'rule', 'verified descriptor rule substitution');
            }
        });
        assert.deepEqual(calls.sort(), [...expectedCalls.get(name)].sort(), 'metadata effect macro closure drift');
        const expectedDescriptors = new Map([['AllowPath', ['pathFd']], ['AllowOwnedTemporaryAlias', ['aliasFd', 'sourceFd']]]);
        assert.deepEqual(closedDescriptors, expectedDescriptors.get(name) ?? [], 'metadata close descriptor macro semantic drift');
    }
    const main = owned.find(node => node.name === 'main');
    const body = main.inner.find(node => node.kind === 'CompoundStmt');
    const names = new Map([[parameters[0].name, 'argc'], [parameters[1].name, 'argv']]);
    const declarations = [];
    walk(body, node =>
    {
        if (node.kind === 'VarDecl' && metadataNames.has(node.name))
        {
            assert.equal(node.type?.qualType, 'const char *', 'metadata alias type drift');
            assert.equal(sourceTokens(node.inner?.at(-1), bytes), 'NULL', 'metadata alias must start empty');
            metadataIds.add(node.id);
            declarations.push(node.name);
        }
    });
    assert.deepEqual(declarations.sort(), [...metadataNames].sort(), 'metadata CLI alias closure drift');
    const observedGuards = new Set();
    walk(body, (node, parents) =>
    {
        if (node.kind !== 'DeclRefExpr' || !metadataIds.has(node.referencedDecl?.id))
        {
            return;
        }
        const guard = parents.find(parent => parent.kind === 'IfStmt');
        assert.ok(guard, 'metadata alias escapes finite CLI ownership');
        const production = sourceTokens(guard, bytes, names);
        assert.ok(metadataMainGuards.includes(production), 'metadata alias enters undeclared guard, scalar or command flow');
        observedGuards.add(production);
    });
    assert.deepEqual([...observedGuards].sort(), [...metadataMainGuards].sort(), 'metadata guard closure drift');
    return roleMaps;
}

function redirectedDeclaration(member, attribute)
{
    if (!['AsmLabelAttr', 'AliasAttr', 'IFuncAttr'].includes(attribute.kind))
    {
        return false;
    }
    // glibc's C23 decimal conversion alias is a separate, unqualified header observation.
    // Its actual header/compiler bytes still require the canonical compile owner profile.
    const location = point(attribute.range?.begin);
    return !(attribute.kind === 'AsmLabelAttr' && member.name === 'strtoull'
        && member.mangledName === '__isoc23_strtoull' && member.storageClass === 'extern'
        && member.type?.qualType === 'unsigned long long (const char *, char **, int)'
        && location?.file === '/usr/include/stdlib.h' && location.includedFrom);
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

export function validateUnpromotedMetadataCliAst(ast, { sourceBytes, sourceFile })
{
    assert.equal(ast.kind, 'TranslationUnitDecl', 'not a complete translation unit');
    walk(ast, node =>
    {
        assert.ok(!['FileScopeAsmDecl', 'ConstructorAttr', 'DestructorAttr', 'IFuncAttr', 'CleanupAttr'].includes(node.kind),
            'undeclared translation-unit execution hook');
    });
    const owned = (ast.inner ?? []).filter(node => node.kind === 'FunctionDecl'
        && node.inner?.some(child => child.kind === 'CompoundStmt') && ownLocation(node.loc, sourceFile));
    const aliases = new Map([
        ['LandlockPathBeneathAttr', 'struct landlock_path_beneath_attr'],
        ['LandlockRulesetAttr', 'struct landlock_ruleset_attr'], ['FileStatus', 'struct stat']
    ]);
    const observedAliases = [];
    for (const node of ast.inner ?? [])
    {
        assert.ok(node.kind !== 'VarDecl' || !ownLocation(node.loc, sourceFile), 'undeclared source global input or output alias');
        if (ownLocation(node.loc, sourceFile) && Number.isInteger(point(node.loc)?.offset) && node.kind === 'RecordDecl')
        {
            throw new Error('undeclared source memory layout');
        }
        if (ownLocation(node.loc, sourceFile) && Number.isInteger(point(node.loc)?.offset) && node.kind === 'TypedefDecl')
        {
            assert.equal(node.type?.qualType, aliases.get(node.name), 'undeclared source type or status layout');
            observedAliases.push(node.name);
        }
        if (node.kind === 'FunctionDecl' && ownLocation(node.loc, sourceFile))
        {
            assert.ok(functions.has(node.name), 'undeclared source function redeclaration');
            assert.ok(!node.inner?.some(child => child.kind?.endsWith('Attr')), 'undeclared function execution attribute');
            assert.equal(node.type?.qualType, functionTypes.get(node.name), 'private ABI/input parameter drift');
        }
    }
    assert.deepEqual(observedAliases.sort(), [...aliases.keys()].sort(), 'metadata type alias closure drift');
    assert.deepEqual(owned.map(node => node.name).sort(), [...functions].sort(), 'registered private function closure drift');
    const main = owned.find(node => node.name === 'main');
    const parameters = main.inner.filter(node => node.kind === 'ParmVarDecl');
    assert.equal(parameters.length, 2, 'undeclared main environment input');
    assert.equal(parameters[0].type.qualType, 'int', 'argc input type drift');
    assert.equal(parameters[1].type.qualType, 'char **', 'argv input type drift');
    const argvId = parameters[1].id;
    const metadataIds = new Set();
    const metadataRoles = validateMetadataGrammar(owned, sourceBytes, parameters, metadataIds);
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
        const localIds = new Set(definition.inner.filter(node => node.kind === 'ParmVarDecl').map(node => node.id));
        let separatorId;
        walk(body, node =>
        {
            if (node.kind === 'VarDecl')
            {
                assert.notEqual(node.storageClass, 'extern', 'undeclared block extern input');
                const localType = node.type?.desugaredQualType ?? node.type?.qualType ?? '';
                if (localType.includes('*'))
                {
                    assert.ok((definition.name === 'ParseIdentity' && metadataRoles.get(definition.name).get(node.name) === 'end' && localType === 'char *'
                        && sourceTokens(node.inner?.at(-1), sourceBytes) === 'NULL')
                        || (definition.name === 'main' && metadataNames.has(node.name) && localType === 'const char *'
                            && sourceTokens(node.inner?.at(-1), sourceBytes) === 'NULL')
                        || (definition.name === 'Fail' && node.name === 'errorMessage'
                        && localType === 'const char *' && node.inner?.at(-1)?.kind === 'CallExpr'),
                    'undeclared local pointer input or alias');
                    if (definition.name === 'Fail')
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
                if (definition.name === 'main' && node.name === 'separator')
                {
                    separatorId = node.id;
                }
            }
        });
        walk(body, (node, parents) =>
        {
            assert.ok(!['GCCAsmStmt', 'MSAsmStmt', 'BlockExpr'].includes(node.kind), 'undeclared opaque execution surface');
            assert.ok(!node.kind?.endsWith('Attr'), 'undeclared declaration execution attribute');
            if (node.kind === 'MemberExpr')
            {
                assert.ok(definition.name === 'AllowOwnedTemporaryAlias'
                    && ['st_dev', 'st_ino', 'st_uid', 'st_mode'].includes(node.name)
                    && ['sourceStat', 'aliasStat'].includes(metadataRoles.get(definition.name)?.get(unwrap(node.inner?.[0])?.referencedDecl?.name)),
                'undeclared member memory input');
            }
            if (node.kind === 'UnaryOperator' && node.opcode === '*')
            {
                const target = unwrap(node.inner[0]);
                assert.ok((['Fail', 'AllowPath', 'ParseIdentity', 'AllowOwnedTemporaryAlias'].includes(definition.name)
                    && target?.kind === 'CallExpr' && calleeNames(target.inner[0]).every(callee => callee === '__errno_location'))
                    || (definition.name === 'ParseIdentity' && target?.kind === 'DeclRefExpr'
                        && metadataRoles.get(definition.name).get(target.referencedDecl?.name) === 'end'), 'undeclared indirect memory input');
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
                assert.ok(target?.kind === 'DeclRefExpr' && localIds.has(target.referencedDecl?.id)
                    && (!target.type?.qualType?.includes('*') || (definition.name === 'main' && metadataIds.has(target.referencedDecl.id)
                        && metadataAssignments.has(sourceTokens(node, sourceBytes).replaceAll(parameters[1].name, 'argv'))))
                    || (['AllowPath', 'ParseIdentity', 'AllowOwnedTemporaryAlias'].includes(definition.name)
                        && target?.kind === 'UnaryOperator' && target.opcode === '*'
                        && calleeNames(unwrap(target.inner[0]).inner?.[0]).every(callee => callee === '__errno_location')),
                'indirect or pointer write outside local scalar ownership');
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
                assert.ok(call && calleeNames(call.inner[0]).every(callee => ['fputs', 'fputc'].includes(callee)),
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
                                    || redirectedDeclaration(member, child)),
                                `external call canonical family redirected: ${callee}`);
                            }
                            let externalDeclaration = declaration;
                            const seenDeclarations = new Set();
                            while (externalDeclaration)
                            {
                                assert.ok(!seenDeclarations.has(externalDeclaration.id), 'cyclic external declaration chain');
                                seenDeclarations.add(externalDeclaration.id);
                                assert.ok(!externalDeclaration.inner?.some(child => child.kind === 'CompoundStmt'),
                                    'external call redirected to an unreviewed definition');
                                assert.ok(!externalDeclaration.inner?.some(child => redirectedDeclaration(externalDeclaration, child)),
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
                    const metadata = definition.name === 'AllowOwnedTemporaryAlias';
                    assert.equal(sourceText(node.inner[2], sourceBytes), metadata ? 'O_PATH|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC' : 'O_PATH|O_CLOEXEC',
                        'data-reading open is not metadata admission');
                    assert.equal(constantValue(node.inner[2]), metadata ? 2097152n | 65536n | 131072n | 524288n : 2097152n | 524288n,
                        'open macro semantic drift');
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
        unknownInputsRejected: true, noSourceDigestWaiver: true, qualificationEligible: false, policyPromotion: false,
        modelVersion: 'fsusblog.command-wrapper-metadata-input.v2',
        untrustedObservationClasses: ['descriptor.identity', 'decimal.end-cursor', 'errno'], analyzerOptions: [] };
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
        const result = validateUnpromotedMetadataCliAst(JSON.parse(astBytes.toString('utf8')), { sourceBytes, sourceFile });
        process.stdout.write(`${JSON.stringify(result)}\n`);
    }
    catch (error)
    {
        process.stderr.write(`AST diagnostic refused: ${error.message}\n`);
        process.exitCode = 1;
    }
}
