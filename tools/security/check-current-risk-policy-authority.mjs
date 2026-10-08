import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoots = ['src/backend', 'src/frontend/src'];

export function validateCurrentRiskPolicySources(sources)
{
    const errors = [];
    for (const [name, source] of Object.entries(sources))
    {
        if (/SecurityRiskPolicySnapshot(?:V2)?\b|SecurityRiskPolicySnapshotV2Adapter|CurrentRiskPolicyV2\b/u.test(source))
        {
            errors.push(`${name}: only canonical SecurityRiskPolicy is admitted`);
        }
        if (name.endsWith('SecurityRiskPolicyFactory.cs') && /AntiCrawlerPolicySnapshot|PowPolicySnapshot|FromLegacy|ToLegacy/u.test(source))
        {
            errors.push(`${name}: factory must consume current typed inputs`);
        }
        if (/CrawlerRiskService\.cs|SecurityRiskEventPersistence\.cs/u.test(name) && /(?:Current\.Options|antiCrawlerOptions)\.(?:RequireChallengeScore|BlockScore|MaxRiskScore|Mode)/u.test(source))
        {
            errors.push(`${name}: decision consumers must read canonical policy`);
        }
        if (name.endsWith('SecurityAdminPolicyService.cs') && /_previous(?:AntiCrawler|Pow|RiskPolicy|PerceptionV2)|_riskPolicyExplicitlyManaged|ApplyRiskControlConfigurationFallbacks/u.test(source))
        {
            errors.push(`${name}: a command must own one complete canonical checkpoint`);
        }
        if (name.endsWith('challenge-kind-wire.ts') && /case SecurityChallengeKind|return ['"](?:sha256Pow|perception)/u.test(source))
        {
            errors.push(`${name}: challenge wire names must consume the generated catalog`);
        }
    }
    return errors;
}

export function readCurrentRiskPolicySources(directory = root)
{
    const sources = {};
    function visit(relative)
    {
        for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true }))
        {
            const name = `${relative}/${entry.name}`;
            if (entry.isDirectory() && !['bin', 'obj', 'node_modules', 'vendor'].includes(entry.name))
            {
                visit(name);
            }
            else if (entry.isFile() && /\.(?:cs|ts|vue)$/u.test(name))
            {
                sources[name] = fs.readFileSync(path.join(directory, name), 'utf8');
            }
        }
    }
    sourceRoots.forEach(visit);
    return sources;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    const errors = validateCurrentRiskPolicySources(readCurrentRiskPolicySources());
    errors.forEach((error) => console.error(error));
    process.exitCode = errors.length ? 1 : 0;
}
