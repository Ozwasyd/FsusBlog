import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const { verifyStrykerCallerContract } = await import(new URL('../../tools/mutation/stryker-caller-governance-contract.mjs', import.meta.url));
const source = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
const laneSource = source('tools/test/lanes/_suite-support.sh');
const policy = JSON.parse(source('config/testing/mutation/stryker-tool.v1.json'));
const manifest = JSON.parse(source('.config/dotnet-tools.json'));
const patch = Buffer.from(source(policy.patchPath));
const expressionTreePatch = Buffer.from(source(policy.expressionTreePatchPath));
const callerStart = laneSource.indexOf('RunBackendMutationWithConfig() {');
const callerEnd = laneSource.indexOf('\n}\n', callerStart) + 3;
const caller = laneSource.slice(callerStart, callerEnd);
const producerBlock = caller.match(/ {4}Run node "\$ROOT_DIR\/tools\/mutation\/stryker-tool\.mjs" run \\\n(?:.*\\\n)*.*\n/u)[0];
const boundReportBlock = caller.match(/ {8}Run node "\$ROOT_DIR\/tools\/test\/check-stryker-report\.mjs" \\\n(?:.*\\\n)*.*\n/u)[0];

// Source/policy controls only: no bootstrap, package operation, custody artifact
// or mutation execution. The canonical runner is imported only for its validator.
function verify(overrides = {})
{
    return verifyStrykerCallerContract({ laneSource, policy, manifest, patch, expressionTreePatch, ...overrides });
}

test('ordinary mutation caller accepts the current canonical interface and upstream manifest pin', () =>
{
    assert.deepEqual(verify(), []);
    assert.equal(manifest.tools['dotnet-stryker'].version, '4.14.2');
    assert.equal(policy.packageVersion, '4.14.2-fsusblog.3');
});

test('ordinary mutation caller accepts ordinary comments and unrelated literal examples', () =>
{
    for (const prefix of [`# ${caller.split('\n').join('\n# ')}\n`, `cat <<'SOURCE_EXAMPLE'\n${caller}\nSOURCE_EXAMPLE\n`,
        `: '\n${caller}\n'\n`, 'read -r value <<< "ordinary metadata"\n'])
    {
        assert.deepEqual(verify({ laneSource: `${prefix}${caller}` }), []);
    }
});

test('ordinary mutation caller rejects name-only commented heredoc and quoted declarations', () =>
{
    for (const invalid of ['', 'tools/mutation/stryker-tool.mjs', `# ${caller.split('\n').join('\n# ')}`,
        `cat <<'SOURCE_EXAMPLE'\n${caller}\nSOURCE_EXAMPLE\n`, `: '\n${caller}\n'\n`,
        'RunBackendMutationWithConfig() {\n    printf "tools/mutation/stryker-tool.mjs"\n}\n'])
    {
        assert.notDeepEqual(verify({ laneSource: invalid }), []);
    }
});

test('ordinary mutation caller rejects missing duplicate and redirected producer arguments', () =>
{
    const mutations = [
        ['Run node "$ROOT_DIR/tools/mutation/stryker-tool.mjs" run', 'Run node "$ROOT_DIR/tools/mutation/other-tool.mjs" run'],
        ['--working-directory "$workingDir"', '--working-directory "$ROOT_DIR"'],
        ['--attestation-output "$outputDir/tool-binding.json"', '--attestation-output "$outputDir/other-binding.json"'],
        ['--attestation-output "$outputDir/tool-binding.json"', ''],
        ['--attestation-output "$outputDir/tool-binding.json"', '--attestation-output "$outputDir/tool-binding.json" --attestation-output "$outputDir/tool-binding.json"'],
        ['-- --config-file "$configPath"', '-- --config-file "$ROOT_DIR/unreviewed.json"'],
        ['-- --config-file "$configPath"', '--config-file "$configPath"'],
        ['--output "$outputDir" "${strykerTraceArgs[@]}"', '--output "$otherDir" "${strykerTraceArgs[@]}"']
    ];
    for (const [before, after] of mutations)
    {
        assert.match(verify({ laneSource: caller.replace(before, after) }).join('\n'), /exact canonical producer invocation/u);
    }
});

test('ordinary mutation caller rejects missing crossed and decoy report tool bindings', () =>
{
    for (const replacement of ['', '--tool-binding "$otherDir/tool-binding.json"', '# --tool-binding "$outputDir/tool-binding.json"'])
    {
        assert.match(verify({ laneSource: caller.replace('--tool-binding "$outputDir/tool-binding.json"', replacement) }).join('\n'), /same canonical tool-binding/u);
    }
    assert.match(verify({ laneSource: caller.replace('tools/test/check-stryker-report.mjs', 'tools/test/other-report.mjs') }).join('\n'), /same canonical tool-binding/u);
});

test('ordinary mutation caller rejects legacy manifest tool fallbacks and restore-only acceptance', () =>
{
    for (const operation of ['restore', 'run dotnet-stryker', 'install dotnet-stryker'])
    {
        const legacy = `RunBackendMutationWithConfig() {\n    cd "$ROOT_DIR"\n    Run dotnet tool ${operation}\n}\n`;
        assert.notDeepEqual(verify({ laneSource: legacy }), []);
        assert.match(verify({ laneSource: caller.replace('\n}', `\n    Run dotnet tool ${operation}\n}`) }).join('\n'), /legacy manifest tool execution/u);
    }
});

test('ordinary mutation caller rejects duplicate declarations and invocation duplication', () =>
{
    assert.match(verify({ laneSource: `${caller}\n${caller}` }).join('\n'), /exactly one original/u);
    const command = caller.match(/ {4}Run node "\$ROOT_DIR\/tools\/mutation\/stryker-tool\.mjs" run \\\n(?:.*\\\n)*.*\n/u)[0];
    assert.match(verify({ laneSource: caller.replace(command, `${command}${command}`) }).join('\n'), /exact canonical producer invocation/u);
});

test('ordinary mutation caller preserves canonical manifest discovery and version refusal', () =>
{
    for (const toolManifestPath of ['other/.config/dotnet-tools.json', '../.config/dotnet-tools.json'])
    {
        assert.match(verify({ policy: { ...policy, toolManifestPath } }).join('\n'), /canonical repository-root tool manifest/u);
    }
    for (const changed of [{ ...manifest, isRoot: false }, { ...manifest, tools: {} },
        { ...manifest, tools: { ...manifest.tools, 'dotnet-stryker': { ...manifest.tools['dotnet-stryker'], version: policy.packageVersion } } },
        { ...manifest, tools: { ...manifest.tools, 'dotnet-stryker': { ...manifest.tools['dotnet-stryker'], rollForward: true } } }])
    {
        assert.match(verify({ manifest: changed }).join('\n'), /manifest does not pin/u);
    }
});

test('ordinary mutation caller preserves upstream archive fork version and both overlay identities', () =>
{
    for (const changed of [{ ...policy, upstreamCommit: 'main' }, { ...policy, upstreamArchive: 'https://example.invalid/tool.tar.gz' },
        { ...policy, upstreamArchiveSha256: '' }, { ...policy, upstreamVersion: '4.14.1' }, { ...policy, packageVersion: '4.14.2' }])
    {
        assert.notDeepEqual(verify({ policy: changed }), []);
    }
    assert.match(verify({ patch: Buffer.concat([patch, Buffer.from('changed')]) }).join('\n'), /patch digest/u);
    assert.match(verify({ expressionTreePatch: Buffer.concat([expressionTreePatch, Buffer.from('changed')]) }).join('\n'), /expression-tree patch digest/u);
});

test('ordinary mutation caller refuses missing source and incomplete or unsupported literals', () =>
{
    for (const invalid of [null, `${caller}\ncat <<'UNFINISHED'\n`, `${caller}\n: 'unfinished`, `${caller}\ncat << "$delimiter"\n`])
    {
        assert.notDeepEqual(verify({ laneSource: invalid }), []);
    }
});

test('ordinary mutation governance delegates the obsolete restore check and retains adjacent gates', () =>
{
    const governance = source('tools/check-backend-test-governance.mjs');
    assert.match(governance, /for \(const error of verifyStrykerCallerContract\(/u);
    assert.match(governance, /fail\(error\);/u);
    assert.doesNotMatch(governance, /must restore \.config\/dotnet-tools\.json/u);
    for (const retained of ['must pin the reviewed upstream Stryker release', 'Stryker thresholds are below issue #40 minimums',
        'must pass the report output directory through the supported CLI option', 'backend mutation runner must export the dedicated MSBuild marker'])
    {
        assert.ok(governance.includes(retained), retained);
    }
});

test('ordinary mutation soundness rejects legal alternate declaration overrides', () =>
{
    for (const declaration of ['RunBackendMutationWithConfig ()', 'function RunBackendMutationWithConfig',
        'function RunBackendMutationWithConfig()', 'RunBackendMutationWithConfig\n()',
        'RunBackendMutationWithConfi\\g ()', '"RunBackendMutationWithConfig" ()'])
    {
        const override = `${declaration} { command dotnet tool run dotnet-stryker; }`;
        assert.notDeepEqual(verify({ laneSource: `${caller}\n${override}` }), [], declaration);
    }
    for (const override of ['RunBackendMutationWithConfig() ( return 0; )',
        'function RunBackendMutationWithConfig ( return 0; )',
        'RunBackendMutationWithConfig() if false; then return 0; fi'])
    {
        assert.notDeepEqual(verify({ laneSource: `${caller}\n${override}` }), [], override);
    }
});

test('ordinary mutation soundness rejects all additional producer and report invocations', () =>
{
    for (const extra of [producerBlock.replace('--working-directory "$workingDir"', '--working-directory "$otherDir"'),
        boundReportBlock.replace('--tool-binding "$outputDir/tool-binding.json"', '--tool-binding "$otherBinding"')])
    {
        assert.notDeepEqual(verify({ laneSource: caller.replace('\n}', `\n${extra}\n}`) }), []);
    }
});

test('ordinary mutation soundness rejects command and environment wrapped tool fallbacks', () =>
{
    for (const extra of ['command dotnet tool restore', 'env OTHER=1 dotnet tool run dotnet-stryker',
        'Run env OTHER=1 dotnet tool install dotnet-stryker', 'command "dotnet" tool restore',
        'OTHER=1 dotnet tool run dotnet-stryker'])
    {
        assert.notDeepEqual(verify({ laneSource: caller.replace('\n}', `\n    ${extra}\n}`) }), [], extra);
    }
});

test('ordinary mutation soundness rejects early exits and unreachable canonical calls', () =>
{
    for (const changed of [caller.replace(producerBlock, `    return 0\n${producerBlock}`),
        caller.replace(producerBlock, `    if false; then\n${producerBlock}    fi\n`),
        caller.replace('if [[ -n "$authorityTier" || -n "$authorityOut" ]]; then', 'if false; then')])
    {
        assert.notDeepEqual(verify({ laneSource: changed }), []);
    }
});

test('ordinary mutation soundness rejects variable origin reassignment and producer report ordering drift', () =>
{
    for (const changed of [caller.replace('find "$outputDir/logs" -maxdepth', 'find "$outputDir/logs"\n            -maxdepth'),
        caller.replace('strykerTraceArgs=()', 'strykerTraceArgs= ()'),
        caller.replace('< <(', '< < ('),
        caller.replace('local configPath="$1"', 'local configPath="$2"'),
        caller.replace('local outputDir="$2"', 'local outputDir="$3"'),
        caller.replace('local workingDir="${4:-$ROOT_DIR}"', 'local workingDir="$otherRoot"'),
        caller.replace(producerBlock, `${producerBlock}    outputDir="$otherDir"\n`),
        caller.replace(producerBlock, `${producerBlock}    configPath="$otherConfig"\n`),
        caller.replace(producerBlock, '').replace(boundReportBlock, `${boundReportBlock}${producerBlock}`)])
    {
        assert.notDeepEqual(verify({ laneSource: changed }), []);
    }
});

test('ordinary mutation soundness refuses unsupported caller control and dynamic evaluation', () =>
{
    for (const extra of ['eval "$dynamic"', 'source "$otherFile"', 'while true; do return 0; done',
        'RunBackendMutationWithConfig () { return 0; }', 'trap "return 0" DEBUG'])
    {
        assert.notDeepEqual(verify({ laneSource: caller.replace(producerBlock, `    ${extra}\n${producerBlock}`) }), [], extra);
    }
});

test('ordinary mutation soundness accepts supported declaration spacing and equivalent source layout', () =>
{
    for (const changed of [caller.replace('RunBackendMutationWithConfig() {', 'RunBackendMutationWithConfig () {'),
        caller.replace('RunBackendMutationWithConfig() {', 'function RunBackendMutationWithConfig() {'),
        caller.replace('RunBackendMutationWithConfig() {', 'function RunBackendMutationWithConfig {'),
        caller.replace(/\n/gu, '\r\n'), caller.replace(/^ {4}/gmu, '\t')])
    {
        assert.deepEqual(verify({ laneSource: changed }), []);
    }
});
