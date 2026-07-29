import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(root, 'tools/security/check-supply-chain-audit.sh');
const sbomScript = path.join(root, 'tools/security/generate-sbom.sh');
const source = fs.readFileSync(script, 'utf8');
const sbomSource = fs.readFileSync(sbomScript, 'utf8');

test('security artifact producers prefer their dedicated directory over the Fresh security root', () =>
{
    assert.match(
        source,
        /OUT_DIR="\$\{FSUSBLOG_SUPPLY_CHAIN_AUDIT_DIR:-\$\{FSUSBLOG_SECURITY_OUTPUT_ROOT:-\$ROOT_DIR\/\.tmp\/security\}\/supply-chain\}"/u
    );
    assert.match(
        sbomSource,
        /OUT_DIR="\$\{FSUSBLOG_SBOM_DIR:-\$\{FSUSBLOG_SECURITY_OUTPUT_ROOT:-\$ROOT_DIR\/\.tmp\/security\}\/sbom\}"/u
    );
});

test('supply-chain audit batches every NuGet project into one solution evaluation', () =>
{
    assert.match(source, /local auditSolution="\$OUT_DIR\/\.nuget-audit\.slnx"/u);
    assert.match(source, /dotnet list "\$auditSolution" package --vulnerable --include-transitive/u);
    assert.doesNotMatch(source, /dotnet list "\$project" package --vulnerable/u);
    assert.match(source, /project missing from batched NuGet audit output/u);
    assert.match(source, /unexpected project in batched NuGet audit output/u);
    assert.match(source, /fs\.writeFileSync\(path\.join\(dir, `\$\{safeName\}\.json`\)/u);
});

test('supply-chain audit remains valid bash', () =>
{
    const result = spawnSync('bash', ['-n', script], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);

    const sbomResult = spawnSync('bash', ['-n', sbomScript], { cwd: root, encoding: 'utf8' });
    assert.equal(sbomResult.status, 0, sbomResult.stderr);
});
