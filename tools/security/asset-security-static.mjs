import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadAssetSecurityContract } from './asset-security-contract.mjs';
import { generatePublicAssetPolicy, renderPublicAssetGateway } from './public-asset-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function parseGatewayDirectives(source)
{
    const tokens = [];
    let index = 0;
    while (index < source.length)
    {
        if (/\s/.test(source[index])) { index++; continue; }
        if (source[index] === '#')
        {
            while (index < source.length && source[index] !== '\n') index++;
            continue;
        }
        if ('{};'.includes(source[index])) { tokens.push(source[index++]); continue; }
        let value = '';
        const quote = source[index] === '"' || source[index] === "'" ? source[index++] : null;
        let closed = !quote;
        while (index < source.length)
        {
            const character = source[index];
            if (quote && character === quote) { index++; closed = true; break; }
            if (!quote && (/\s/.test(character) || '{};'.includes(character))) break;
            if (character === '\\')
            {
                if (index + 1 >= source.length) throw new Error('asset.gateway.syntax: trailing escape');
                value += source[index++] + source[index++];
            }
            else value += source[index++];
        }
        if (!closed || (!quote && value.length === 0)) throw new Error('asset.gateway.syntax: malformed token');
        tokens.push(value);
    }
    let cursor = 0;
    function block(nested)
    {
        const nodes = [];
        while (cursor < tokens.length)
        {
            if (tokens[cursor] === '}')
            {
                if (!nested) throw new Error('asset.gateway.syntax: unexpected close');
                cursor++;
                return nodes;
            }
            const values = [];
            while (cursor < tokens.length && !['{', '}', ';'].includes(tokens[cursor])) values.push(tokens[cursor++]);
            const terminal = tokens[cursor++];
            if (!values.length || !['{', ';'].includes(terminal)) throw new Error('asset.gateway.syntax: incomplete directive');
            nodes.push({ name: values[0], args: values.slice(1), children: terminal === '{' ? block(true) : null });
        }
        if (nested) throw new Error('asset.gateway.syntax: unclosed block');
        return nodes;
    }
    return block(false);
}

export function inspectGateway(contract, source)
{
    const errors = [];
    const nodes = parseGatewayDirectives(source);
    const locations = [];
    const mappings = [];
    function walk(items, location = null)
    {
        for (const node of items)
        {
            const current = node.name === 'location' ? node : location;
            if (node.name === 'location') locations.push(node);
            if (node.name === 'alias' || node.name === 'root') mappings.push({ api: node.name, value: node.args.join(' '), location: current?.args.join(' ') ?? null });
            if (node.children) walk(node.children, current);
        }
    }
    walk(nodes);
    const ownLocations = location => locations.filter(node => node.args.at(-1) === location);
    const privateLocations = ownLocations(contract.gateway.privateInternalLocation);
    const publicLocations = ownLocations(contract.gateway.publicLocation);
    const externalLocations = ownLocations(contract.gateway.privateExternalLocation);
    if (privateLocations.length !== 1 || !privateLocations[0].children.some(node => node.name === 'internal' && node.args.length === 0)) errors.push('asset.private.internal: private sending location must be exact-one internal');
    if (externalLocations.length !== 1) errors.push('asset.private.internal: external redemption location must be exact-one');
    if (publicLocations.length !== 1 || publicLocations[0].args[0] !== '^~'
        || !publicLocations[0].children.some(node => node.name === 'proxy_pass' && node.args[0] === 'http://fsusblog_kestrel')) errors.push('asset.public.pipeline: public location must be exact-one dedicated Kestrel proxy');
    for (const mapping of mappings)
    {
        if (mapping.api !== 'alias' || mapping.value !== contract.gateway.privateInternalAlias
            || mapping.location !== `^~ ${contract.gateway.privateInternalLocation}`) errors.push(`asset.static.exact-one: unregistered gateway mapping ${mapping.api} ${mapping.location}`);
    }
    if (mappings.length !== 1) errors.push('asset.static.exact-one: expected one controlled internal private alias');
    return { errors, locations: locations.map(node => ({ arguments: node.args, directives: node.children.map(item => item.name) })), mappings };
}

export function inspectComposeModel(model, source)
{
    const errors = [];
    const mounts = [];
    for (const [service, definition] of Object.entries(model.services ?? {}))
    {
        for (const mount of definition.volumes ?? [])
        {
            if (!mount || typeof mount !== 'object' || typeof mount.source !== 'string' || typeof mount.target !== 'string')
            {
                errors.push(`asset.compose.mounts: ${source}:${service}: incomplete native mount model`);
                continue;
            }
            const target = mount.target.replaceAll('\\', '/').toLowerCase();
            const record = { sourceFile: source, service, source: mount.source, target: mount.target, nativeType: mount.type, mode: mount.read_only ? 'ro' : 'rw', unresolvedTemplate: mount.source.includes('${') || mount.target.includes('${') };
            mounts.push(record);
            if (target === '/app/wwwroot' || target.startsWith('/app/wwwroot/')) errors.push(`asset.compose.mounts: ${source}:${service}: volume exposes WebRoot ${mount.target}`);
            if (/openresty|nginx|gateway/i.test(service)
                && /(?:^|[/\\])(?:assets[/\\]private|upload-sessions|upload-commit)(?:[/\\]|$)/i.test(mount.source + '/' + mount.target)) errors.push(`asset.compose.mounts: ${source}:${service}: nonpublic asset root mounted in gateway`);
        }
    }
    return { errors, mounts };
}

export function inspectPolicyGeneration(contract, read)
{
    const input = read(contract.policy.input);
    const generated = generatePublicAssetPolicy(input);
    const gateway = read(contract.gateway.source).toString();
    const expectedGateway = renderPublicAssetGateway(gateway, generated);
    const errors = [];
    if (gateway !== expectedGateway) errors.push('asset.policy.generated: gateway generated block drift');
    const documentation = contract.policy.outputs.find(file => file !== contract.gateway.source);
    if (!documentation || read(documentation).toString() !== generated.documentation) errors.push('asset.policy.generated: documentation drift');
    return { errors, inputSha256: digest(input), generatedOutputs: contract.policy.outputs.map(file => ({ path: file, sha256: digest(read(file)) })) };
}

export function inspectStaticInputs(repository = root)
{
    const errors = [];
    const warnings = [];
    const contractBytes = fs.readFileSync(path.join(repository, 'config/security/asset-security-contract.json'));
    const contract = loadAssetSecurityContract(contractBytes, repository);
    const read = source => fs.readFileSync(path.join(repository, source));
    const gateway = inspectGateway(contract, read(contract.gateway.source).toString());
    const policy = inspectPolicyGeneration(contract, read);
    errors.push(...gateway.errors, ...policy.errors);
    const compose = [];
    for (const source of contract.composeSources)
    {
        const parsed = spawnSync('docker', ['compose', '-f', path.join(repository, source), 'config', '--no-interpolate', '--no-env-resolution', '--format', 'json'], { cwd: repository, encoding: 'utf8', timeout: 30000 });
        if (parsed.error || parsed.status !== 0) { errors.push(`asset.compose.mounts: ${source}: native parser failed (${parsed.status ?? parsed.error?.code})`); continue; }
        if (parsed.stderr.trim()) warnings.push({ ruleId: 'asset.warnings.fail', source, diagnostic: parsed.stderr.trim() });
        const scan = inspectComposeModel(JSON.parse(parsed.stdout), source);
        errors.push(...scan.errors);
        compose.push({ source, sourceSha256: digest(read(source)), mounts: scan.mounts });
    }
    // The syntax guards currently run in the canonical ContentAssetContractTests
    // source. A passing input/config scan cannot replace that current-run owner,
    // semantic root-flow/path proofs or complete resurrection coverage.
    const unprovenRules = ['asset.roots.canonical', 'asset.static.exact-one', 'asset.identity.retired', 'asset.identity.single-ledger', 'asset.paths.portable', 'asset.scanner.off-request'];
    errors.push('asset.scanner.coverage-incomplete: current-run C# syntax/semantic and portable path owner evidence not bound');
    const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' });
    const worktree = spawnSync('git', ['status', '--porcelain=v1'], { cwd: repository, encoding: 'utf8' });
    if (git.status !== 0 || worktree.status !== 0) errors.push('asset.source.identity: git owner unavailable');
    return { kind: 'asset-security-static-sub-result', status: 'blocked', sourceRevision: git.stdout.trim(), sourceWorktreeDirty: Boolean(worktree.stdout.trim()), contractSha256: digest(contractBytes), contractSchemaSha256: digest(read('config/security/asset-security-contract.schema.json')), policy, gateway, compose, unprovenRules, errors, warnings };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
{
    const result = inspectStaticInputs();
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.errors.length || result.warnings.length ? 1 : 0;
}
