import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Development build entry only. A compile database is written after the real Darwin compiler
// succeeds, never on another host or as replacement evidence for a missing SDK.
if (process.platform !== 'darwin') {
    throw new Error('mac_vault_native_build_requires_darwin');
}
if (process.argv.length !== 4 || process.argv[2] !== '--output-directory') {
    throw new Error('Expected --output-directory <MSBuild native output directory>.');
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outputDirectory = path.resolve(process.argv[3]);
const source = path.join(root, 'src/article-vault/macos/native/MacVaultFSEvents.c');
const library = path.join(outputDirectory, 'libFsusBlog.ArticleVault.MacOS.dylib');

function Run(executable, argumentsList) {
    const result = spawnSync(executable, argumentsList, {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
        process.stderr.write(result.stderr ?? '');
        throw new Error('mac_vault_native_compile_failed');
    }
    return result.stdout.trim();
}

const compiler = Run('xcrun', ['--find', 'clang']);
const sdk = Run('xcrun', ['--sdk', 'macosx', '--show-sdk-path']);
const argumentsList = ['-std=c11', '-Wall', '-Wextra', '-Werror', '-Wno-deprecated-declarations',
    '-fvisibility=hidden', '-isysroot', sdk, '-dynamiclib', '-framework', 'CoreServices',
    '-framework', 'CoreFoundation', source, '-o', library];
fs.mkdirSync(outputDirectory, { recursive: true });
const database = path.join(outputDirectory, 'compile_commands.json');
// Remove only this builder's stale diagnostic database before starting a new compile attempt.
fs.rmSync(database, { force: true });
Run(compiler, argumentsList);
fs.writeFileSync(database, `${JSON.stringify([{ directory: root, file: source,
    arguments: [compiler, ...argumentsList] }], null, 4)}\n`);
process.stdout.write('macOS Vault native library compiled; qualification=false\n');
