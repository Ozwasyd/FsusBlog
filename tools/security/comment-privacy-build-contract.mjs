#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const commentPrivacyBuildContract = Object.freeze({
    circuitId: 'fsus.anonymous.comment.v5',
    publicInputLayoutVersion: 6,
    trustedSetupManifest: 'security/zk/provenance/comment-v5-trusted-setup.manifest.json',
    verifyingKeyConfig: 'config/zk/anonymous-comment-v5-verifying-key.manifest.json',
    circuitManifest: 'security/zk/contracts/comment-v5-circuit.manifest.json',
    productionOutputs: Object.freeze([
        'comment-privacy-prover.zkey',
        'comment-privacy-prover.manifest.json'
    ])
});

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha256Pattern = /^[a-f0-9]{64}$/u;

export function productionZkRequested(env = process.env)
{
    const value = String(env.FSUSBLOG_ZK_PRODUCTION_ENABLED ?? '0').trim();
    if (value !== '0' && value !== '1')
    {
        throw new Error('FSUSBLOG_ZK_PRODUCTION_ENABLED must be 0 or 1');
    }
    return value === '1';
}

export function validateCommentPrivacyWasmBuildSource(source)
{
    const buildSource = String(source ?? '');
    const errors = [];
    const requiredTokens = [
        'COMMENT_PRIVACY_BUILD_CONTRACT="${REPOSITORY_ROOT}/tools/security/comment-privacy-build-contract.mjs"',
        '"${FSUSBLOG_NODE:-node}" "${COMMENT_PRIVACY_BUILD_CONTRACT}" --print-mode)',
        '"${FSUSBLOG_NODE:-node}" "${COMMENT_PRIVACY_BUILD_CONTRACT}" --print-proving-key)',
        'comment_privacy=%s circuit=fsus.anonymous.comment.v5 layout=6'
    ];
    for (const token of requiredTokens)
    {
        if (!buildSource.includes(token))
        {
            errors.push(`Wasm build is missing current v5 contract token: ${token}`);
        }
    }

    for (const [label, statement, enabledOnlyBlock] of [
        [
            'proving key',
            'cp -f "${COMMENT_PRIVACY_PROVER_KEY}" "${OUT_DIR}/comment-privacy-prover.zkey"',
            'if [[ "${COMMENT_PRIVACY_BUILD_MODE}" == "enabled" ]]; then\n' +
        '    cp -f "${COMMENT_PRIVACY_PROVER_KEY}" "${OUT_DIR}/comment-privacy-prover.zkey"\nfi'
        ],
        [
            'prover manifest',
            'node "${REPOSITORY_ROOT}/tools/frontend/write-comment-privacy-prover-manifest.mjs"',
            'if [[ "${COMMENT_PRIVACY_BUILD_MODE}" == "enabled" ]]; then\n' +
        '    FSUSBLOG_REPOSITORY_ROOT="${REPOSITORY_ROOT}" \\\n' +
        '        node "${REPOSITORY_ROOT}/tools/frontend/write-comment-privacy-prover-manifest.mjs"\nfi'
        ]
    ])
    {
        if (!buildSource.includes(enabledOnlyBlock))
        {
            errors.push(`Wasm build must emit the ${label} only when the current v5 contract is enabled`);
        }
        if (buildSource.split(statement).length !== 2)
        {
            errors.push(`Wasm build must contain exactly one ${label} emission statement`);
        }
    }

    errors.push(...validateRetiredCommentPrivacyBuildResidue(buildSource));
    return errors;
}

export function validateRetiredCommentPrivacyBuildResidue(source)
{
    const buildSource = String(source ?? '');
    const errors = [];
    const retiredCompatibilityTokens = [
        ['FSUSBLOG', 'COMMENT', 'PROVER', 'BUNDLE'].join('_'),
        ['FSUSBLOG', 'COMMENT', 'PROVER', 'KEY'].join('_'),
        ['PROVER', 'BUNDLE', 'TAR'].join('_'),
        ['PROVER', 'BUNDLE'].join('_')
    ];
    for (const token of retiredCompatibilityTokens)
    {
        if (buildSource.includes(token))
        {
            errors.push(`Wasm build retains retired comment-prover compatibility token: ${token}`);
        }
    }
    const proverArchivePath = /artifacts\/zk\/[^\s"'`]*(?:prover|bundle)[^\s"'`]*(?:\.tar(?:\.gz)?|\.tgz)\b/iu;
    if (proverArchivePath.test(buildSource))
    {
        errors.push('Wasm build must not recreate a prover archive under artifacts/zk');
    }
    const logicalLines = buildSource.replace(/\\\r?\n[ \t]*/gu, ' ').split(/\r?\n/u);
    const archiveCommand = /^[ \t]*(?:(?:[A-Za-z_][A-Za-z0-9_]*=[^ \t]+)[ \t]+)*(?:command[ \t]+)?(?<tool>tar|gzip)(?:[ \t]|$)/u;
    const privacyArchiveArgument = new RegExp([
        'comment[-_]privacy[-_](?:prover|runtime)',
        ...retiredCompatibilityTokens,
        'artifacts/zk/[^\\s"\'`]*(?:prover|bundle)[^\\s"\'`]*(?:\\.tar(?:\\.gz)?|\\.tgz)\\b'
    ].join('|'), 'iu');
    for (const line of logicalLines)
    {
        const command = line.match(archiveCommand);
        if (!command || !privacyArchiveArgument.test(line))
        {
            continue;
        }
        errors.push(`Wasm build must not package comment-prover outputs with ${command.groups.tool}`);
    }
    return errors;
}

export function validateCommentPrivacyBuild({
    root = process.env.FSUSBLOG_REPOSITORY_ROOT || defaultRoot,
    env = process.env
} = {})
{
    const repositoryRoot = path.resolve(root);
    const requested = productionZkRequested(env);
    const setup = readJson(repositoryRoot, commentPrivacyBuildContract.trustedSetupManifest);
    const config = readJson(repositoryRoot, commentPrivacyBuildContract.verifyingKeyConfig);
    const circuit = readJson(repositoryRoot, commentPrivacyBuildContract.circuitManifest);

    for (const [label, document] of [['trusted setup', setup], ['verifying-key config', config], ['circuit', circuit]])
    {
        requireEqual(document.circuit_id, commentPrivacyBuildContract.circuitId, `${label} circuit_id`);
        requireEqual(Number(document.public_input_layout_version), commentPrivacyBuildContract.publicInputLayoutVersion,
            `${label} public_input_layout_version`);
    }

    if (!requested)
    {
        return {
            mode: 'disabled',
            circuitId: commentPrivacyBuildContract.circuitId,
            publicInputLayoutVersion: commentPrivacyBuildContract.publicInputLayoutVersion,
            productionUsable: setup.production_usable === true
        };
    }

    requireEqual(setup.ceremony_status, 'verified', 'trusted setup ceremony_status');
    requireEqual(setup.production_usable, true, 'trusted setup production_usable');
    requireEqual(config.production_usable, true, 'verifying-key config production_usable');
    requireEqual(circuit.production_usable, true, 'circuit production_usable');
    requireEqual(config.trusted_setup_manifest, commentPrivacyBuildContract.trustedSetupManifest,
        'verifying-key config trusted_setup_manifest');
    requireEqual(config.circuit_manifest, commentPrivacyBuildContract.circuitManifest,
        'verifying-key config circuit_manifest');

    const phase2 = setup.phase2 ?? {};
    requireEqual(phase2.status, 'verified', 'trusted setup phase2.status');
    if (!Number.isInteger(phase2.minimum_contributions) || phase2.minimum_contributions < 3)
    {
        throw new Error('trusted setup phase2.minimum_contributions must be at least 3');
    }
    verifyBoundFile(repositoryRoot, phase2.transcript_path, phase2.transcript_sha256, 'phase2 transcript');

    for (const name of ['r1cs', 'proving_key', 'verifying_key', 'wasm_prover_bundle'])
    {
        const artifact = setup.artifacts?.[name];
        if (!artifact || !['required', 'verified'].includes(artifact.status))
        {
            throw new Error(`trusted setup artifact ${name} must be required or verified`);
        }
        verifyBoundFile(repositoryRoot, artifact.path, artifact.sha256, `trusted setup artifact ${name}`);
    }

    const verifyingKeyHash = requireSha256(setup.verifying_key_hash, 'trusted setup verifying_key_hash');
    requireEqual(setup.artifacts.verifying_key.sha256, verifyingKeyHash,
        'trusted setup verifying-key artifact hash');
    requireEqual(config.verifying_key_hash, verifyingKeyHash, 'verifying-key config hash');
    requireEqual(config.verifying_key_path, setup.artifacts.verifying_key.path, 'verifying-key config path');
    requireEqual(circuit.verifying_key_hash, verifyingKeyHash, 'circuit verifying_key_hash');

    return {
        mode: 'enabled',
        circuitId: commentPrivacyBuildContract.circuitId,
        publicInputLayoutVersion: commentPrivacyBuildContract.publicInputLayoutVersion,
        productionUsable: true,
        provingKeyPath: resolveRepoFile(repositoryRoot, setup.artifacts.proving_key.path, 'proving key')
    };
}

function readJson(root, relativePath)
{
    const absolutePath = resolveRepoFile(root, relativePath, relativePath);
    try
    {
        return JSON.parse(readFileSync(absolutePath, 'utf8'));
    }
    catch (error)
    {
        throw new Error(
            `${relativePath} is invalid: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error }
        );
    }
}

function resolveRepoFile(root, value, label)
{
    const raw = String(value ?? '').trim();
    if (!raw || path.isAbsolute(raw))
    {
        throw new Error(`${label} path must be repository-relative`);
    }
    const absolutePath = path.resolve(root, raw);
    const relative = path.relative(root, absolutePath);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    {
        throw new Error(`${label} path escapes the repository root`);
    }
    if (!existsSync(absolutePath))
    {
        throw new Error(`${label} is missing: ${raw}`);
    }
    return absolutePath;
}

function verifyBoundFile(root, artifactPath, expectedHash, label)
{
    const hash = requireSha256(expectedHash, `${label} sha256`);
    const absolutePath = resolveRepoFile(root, artifactPath, label);
    const actualHash = createHash('sha256').update(readFileSync(absolutePath)).digest('hex');
    if (actualHash !== hash)
    {
        throw new Error(`${label} SHA-256 mismatch`);
    }
}

function requireSha256(value, label)
{
    const normalized = String(value ?? '').trim().toLowerCase();
    if (!sha256Pattern.test(normalized))
    {
        throw new Error(`${label} must be a complete SHA-256 digest`);
    }
    return normalized;
}

function requireEqual(actual, expected, label)
{
    if (actual !== expected)
    {
        throw new Error(`${label} must equal ${JSON.stringify(expected)}`);
    }
}

async function main()
{
    const command = process.argv[2] ?? '--check';
    if (command === '--validate-wasm-source')
    {
        const sourceFile = resolveRepoFile(
            defaultRoot,
            process.argv[3],
            'Wasm build source'
        );
        const errors = validateCommentPrivacyWasmBuildSource(
            readFileSync(sourceFile, 'utf8')
        );
        if (errors.length > 0)
        {
            throw new Error(errors.join('; '));
        }
        console.log('[comment-privacy-build] Wasm source contract ok');
        return;
    }
    const result = validateCommentPrivacyBuild();
    if (command === '--print-mode')
    {
        process.stdout.write(`${result.mode}\n`);
        return;
    }
    if (command === '--print-proving-key')
    {
        if (result.mode !== 'enabled')
        {
            throw new Error('production ZK is disabled');
        }
        process.stdout.write(`${result.provingKeyPath}\n`);
        return;
    }
    if (command !== '--check')
    {
        throw new Error(`unknown command: ${command}`);
    }
    console.log(`[comment-privacy-build] mode=${result.mode} circuit=${result.circuitId} layout=${result.publicInputLayoutVersion}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main().catch((error) =>
    {
        console.error(`[comment-privacy-build] failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    });
}
