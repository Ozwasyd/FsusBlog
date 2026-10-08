import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceFiles = [
    'src/backend/Services/Security/ZkCommentPolicyOptions.cs',
    'src/backend/Services/Security/ZkAnonymousProofService.cs',
    'src/backend/Services/Security/ZkVerifierOptions.cs',
    'src/backend/Services/Security/NativeGroth16ZkProofBackend.cs',
    'src/backend/Services/Security/SecurityAdminPolicyService.cs',
    'src/backend/Infrastructure/Bootstrap/RuntimeSecurityAndLifecycleServiceCollectionExtensions.cs'
];

export function readCurrentZkPolicySources(directory = root)
{
    return Object.fromEntries(sourceFiles.map((name) => [name, fs.readFileSync(path.join(directory, name), 'utf8')]));
}

export function validateCurrentZkPolicySources(sources)
{
    const errors = [];
    for (const [name, source] of Object.entries(sources))
    {
        if (/ZkProdOptions|ZkProdPolicySnapshot|CurrentZkProdPolicy|FallbackToLegacyAnonymous|legacy_fallback_disallowed|dev_verifier_disallowed/u.test(source))
        {
            errors.push(`${name}: retired product models and fallback switches are forbidden`);
        }
        if (name.endsWith('ZkCommentPolicyOptions.cs') && /public\s+(?:string\??|bool)\s+(?:VerifierBackend|VerifyingKeyHash|TrustedSetupManifestPath|VerifyingKeyManifestPath|TrustedSetupVerified|CredentialReady|AllowDevVerifier)/u.test(source))
        {
            errors.push(`${name}: product options cannot own verifier configuration or readiness flags`);
        }
        if (name.endsWith('ZkAnonymousProofService.cs') && /File\.|JsonDocument|ZkVerifierOptions.*\?(?:\?|\.)|IOptionsMonitor|_configuration|_verifierOptions/u.test(source))
        {
            errors.push(`${name}: product reads consume immutable verifier readiness without file or options access`);
        }
        if (name.endsWith('NativeGroth16ZkProofBackend.cs') && /configuration\[[^\n]+(?:VerifyingKeyHash|VerifyingKeySha256)/u.test(source))
        {
            errors.push(`${name}: the native backend must consume the sole verifier-owned hash`);
        }
        if (name.endsWith('SecurityAdminPolicyService.cs') && /ZkVerifierOptions|VerifyingKeyHash|VerifierBackend/u.test(source))
        {
            errors.push(`${name}: administrative policy commands cannot update verifier identity`);
        }
    }
    return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    const errors = validateCurrentZkPolicySources(readCurrentZkPolicySources());
    errors.forEach((error) => console.error(error));
    process.exitCode = errors.length ? 1 : 0;
}
