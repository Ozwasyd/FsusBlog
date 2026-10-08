#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
const root = rootIndex >= 0
    ? path.resolve(args[rootIndex + 1])
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = 'src/shared/Contracts/AuthSystem/user-session-authentication-contract.json';
const contract = JSON.parse(fs.readFileSync(path.join(root, source), 'utf8'));
if (contract.schema !== 'fsusblog.current-auth-session-contract.v1' || contract.requiresCredentialRowId !== true)
{
    throw new Error('Unsupported current authentication contract');
}
for (const key of ['methods', 'strengths', 'durationPolicies', 'modes', 'claims', 'identityKinds', 'registrationStates'])
{
    const entries = Object.entries(contract[key]);
    if (entries.length === 0 || new Set(entries.map(([, value]) => value)).size !== entries.length
        || entries.some(([name, value]) => !/^[A-Z][A-Za-z0-9]*$/u.test(name) || !/^[a-z][a-z0-9_]*$/u.test(value)
            || ['other', 'legacy_verified', 'legacy_unverified'].includes(value)))
    {
        throw new Error(`Invalid authentication catalog ${key}`);
    }
}
if (!Array.isArray(contract.combinations) || contract.combinations.length === 0
    || new Set(contract.combinations.map(({ method, strength }) => `${method}:${strength}`)).size !== contract.combinations.length
    || contract.combinations.some(({ method, strength }) => !Object.hasOwn(contract.methods, method) || !Object.hasOwn(contract.strengths, strength)))
{
    throw new Error('Invalid authentication combinations');
}

if (Object.keys(contract.methods).some((name) => !contract.combinations.some(({ method }) => method === name))
    || Object.keys(contract.strengths).some((name) => !contract.combinations.some(({ strength }) => strength === name)))
{
    throw new Error('Authentication catalog value has no current producer combination');
}

const constants = (entries) => Object.entries(entries).map(([name, value]) => `    public const string ${name} = "${value}";`).join('\n');
function catalog(className, enumName, entries)
{
    const names = Object.keys(entries);
    const constantName = (name) => className === 'AnonymousIdentityRuntime' ? `${name}Kind` : name;
    const extras = className === 'AnonymousIdentityRuntime'
        ? '    public const string AccountSubjectHashClaim = CurrentAuthSessionClaims.AccountSubjectHash;\n\n'
        : className === 'AccountRegistrationStates'
            ? '    public static bool IsActive(string? value) => string.Equals(value, Active, StringComparison.Ordinal);\n\n'
            : '';
    return `public enum ${enumName}\n{\n${names.map((name, index) => `    ${name} = ${index + 1}`).join(',\n')}\n}\n\npublic static class ${className}\n{\n${constants(Object.fromEntries(Object.entries(entries).map(([name, value]) => [constantName(name), value])))}\n\n${extras}    public static bool IsValid(string? value) => TryParse(value, out _);\n\n    public static bool TryParse(string? value, out ${enumName} parsed)\n    {\n        parsed = value switch\n        {\n${names.map((name) => `            ${constantName(name)} => ${enumName}.${name},`).join('\n')}\n            _ => default\n        };\n        return parsed != default;\n    }\n\n    public static string ToWireValue(${enumName} value)\n        => value switch\n        {\n${names.map((name) => `            ${enumName}.${name} => ${constantName(name)},`).join('\n')}\n            _ => throw new ArgumentOutOfRangeException(nameof(value))\n        };\n}\n`;
}

const duration = `public static class UserSessionDurationPolicies\n{\n${constants(contract.durationPolicies)}\n\n    public static string FromRememberMe(bool rememberMe)\n        => rememberMe ? Persistent30Days : BrowserSession;\n\n    public static bool IsPersistent(string? value)\n        => string.Equals(value, Persistent30Days, StringComparison.Ordinal);\n\n    public static bool IsValid(string? value)\n        => value is ${Object.keys(contract.durationPolicies).join(' or ')};\n}\n`;
const modes = `public enum UserSessionMode\n{\n${Object.keys(contract.modes).map((name, index) => `    ${name} = ${index}`).join(',\n')}\n}\n\npublic static class UserSessionModes\n{\n    public const string ClaimType = CurrentAuthSessionClaims.SessionMode;\n${Object.entries(contract.modes).map(([name, value]) => `    public const string ${name}WireValue = "${value}";`).join("\n")}\n\n    public static string ToClaimValue(UserSessionMode mode)\n        => mode switch\n        {\n${Object.entries(contract.modes).map(([name, value]) => `            UserSessionMode.${name} => "${value}",`).join('\n')}\n            _ => throw new ArgumentOutOfRangeException(nameof(mode))\n        };\n\n    public static bool TryParseClaim(string? value, out UserSessionMode mode)\n    {\n        mode = value switch\n        {\n${Object.entries(contract.modes).map(([name, value]) => `            "${value}" => UserSessionMode.${name},`).join('\n')}\n            _ => (UserSessionMode)(-1)\n        };\n        return Enum.IsDefined(mode);\n    }\n}\n`;
const cs = `// <auto-generated />\n// Source: ${source}\nnamespace FsusBlog.Shared.Contracts.AuthSystem;\n\n${catalog('AnonymousIdentityRuntime', 'CurrentIdentityKind', contract.identityKinds)}\n${catalog('AccountRegistrationStates', 'AccountRegistrationState', contract.registrationStates)}\n${catalog('UserSessionAuthenticationMethods', 'UserSessionAuthenticationMethod', contract.methods)}\n${catalog('UserSessionAuthenticationStrengths', 'UserSessionAuthenticationStrength', contract.strengths)}\n${duration}\n${modes}\npublic static class CurrentAuthSessionClaims\n{\n${constants(contract.claims)}\n}\n\npublic static class UserSessionAuthenticationContract\n{\n    public static bool IsValid(string? method, string? strength, int? credentialRowId)\n        => credentialRowId is > 0 && IsSupportedCombination(method, strength);\n\n    public static bool IsSupportedCombination(string? method, string? strength)\n        => UserSessionAuthenticationMethods.TryParse(method, out UserSessionAuthenticationMethod parsedMethod)\n            && UserSessionAuthenticationStrengths.TryParse(strength, out UserSessionAuthenticationStrength parsedStrength)\n            && ((parsedMethod, parsedStrength) switch\n            {\n${contract.combinations.map(({ method, strength }) => `                (UserSessionAuthenticationMethod.${method}, UserSessionAuthenticationStrength.${strength}) => true,`).join('\n')}\n                _ => false\n            });\n\n    public static bool IsCoarseMfa(string? method, string? strength, int? credentialRowId)\n        => IsValid(method, strength, credentialRowId);\n}\n`;

const tsType = (name, values) => `export type ${name} = ${Object.values(values).map((value) => `'${value}'`).join(' | ')};`;
const ts = `// Generated by tools/contracts/generate-auth-session-contract.mjs.\n// Source: ${source}\n${tsType('UserSessionAuthenticationMethod', contract.methods)}\n${tsType('UserSessionAuthenticationStrength', contract.strengths)}\n${tsType('UserSessionDurationPolicy', contract.durationPolicies)}\n${tsType('UserSessionMode', contract.modes)}\n${tsType('CurrentIdentityKind', contract.identityKinds)}\n\nexport function isCurrentIdentityKind(value: unknown): value is CurrentIdentityKind\n{\n    return ${Object.values(contract.identityKinds).map((value) => `value === '${value}'`).join(' || ')};\n}\n\nexport function sessionModeFromWire(value: number): UserSessionMode | undefined\n{\n    switch (value)\n    {\n${Object.values(contract.modes).map((mode, index) => `        case ${index}: return '${mode}';`).join('\n')}\n        default: return undefined;\n    }\n}\n\nexport function isCurrentSessionAuthentication(value: unknown): value is {\n    authenticationMethod: UserSessionAuthenticationMethod;\n    authenticationStrength: UserSessionAuthenticationStrength;\n    durationPolicy: UserSessionDurationPolicy;\n    sessionMode: UserSessionMode;\n}\n{\n    if (value === null || typeof value !== 'object')\n    {\n        return false;\n    }\n    const row = value as Record<string, unknown>;\n    return (${Object.values(contract.modes).map((value) => `row.sessionMode === '${value}'`).join(' || ')})\n        && (${Object.values(contract.durationPolicies).map((value) => `row.durationPolicy === '${value}'`).join(' || ')})\n        && (${contract.combinations.map(({ method, strength }) => `(row.authenticationMethod === '${contract.methods[method]}' && row.authenticationStrength === '${contract.strengths[strength]}')`).join('\n            || ')});\n}\n`;

const outputs = new Map([
    ['src/shared/Contracts/AuthSystem/UserSessionAuthenticationContract.generated.cs', cs],
    ['src/frontend/src/generated/authSessionContract.ts', ts]
]);
const check = process.argv.slice(2).includes('--check');
for (const [relative, text] of outputs)
{
    const target = path.join(root, relative);
    if (check)
    {
        if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== text)
        {
            throw new Error(`Current authentication projection drift: ${relative}`);
        }
    }
    else
    {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, text);
    }
}
console.log(`[auth-session-contract] ${check ? 'checked' : 'generated'} ${outputs.size} current projections`);
