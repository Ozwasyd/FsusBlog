import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const parserRoot = fileURLToPath(new URL('./csharp-format-parser/', import.meta.url));
const inputs = ['Program.cs', 'Parser.csproj', 'global.json'];
function digestFiles(directory, files)
{
    const digest = createHash('sha256');
    for (const file of files)
    {
        const target = join(directory, file);
        if (!lstatSync(target).isFile())
        {
            throw new Error(`C# parser requires regular files: ${file}`);
        }
        const bytes = readFileSync(target);
        digest.update(JSON.stringify([file, bytes.length])).update(bytes);
    }
    return digest.digest('hex');
}
const inputDigest = () => digestFiles(parserRoot, inputs);
let parser = null;

function outputFiles(directory, prefix = '')
{
    return readdirSync(directory).sort().flatMap(name =>
    {
        const target = join(directory, name);
        const relative = join(prefix, name);
        const stat = lstatSync(target);
        if (stat.isDirectory())
        {
            return outputFiles(target, relative);
        }
        if (!stat.isFile())
        {
            throw new Error(`C# parser requires regular output: ${relative}`);
        }
        return [relative];
    });
}

export function inspectCsharpFormat(source)
{
    if (parser === null)
    {
        const directory = mkdtempSync(join(tmpdir(), 'fsusblog-csharp-format-parser-'));
        process.once('exit', () => rmSync(directory, { recursive: true, force: true }));
        const digest = inputDigest();
        for (const file of inputs)
        {
            copyFileSync(join(parserRoot, file), join(directory, file));
        }
        execFileSync('dotnet', ['build', 'Parser.csproj', '--output', 'out',
            '-p:RestoreSources=', '--verbosity', 'quiet'], {
            cwd: directory, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe']
        });
        const output = join(directory, 'out');
        const files = outputFiles(output);
        parser = { directory, digest, output, files, outputDigest: digestFiles(output, files) };
    }
    // The parser belongs to this checker checkout, never the candidate --root.
    if (inputDigest() !== parser.digest)
    {
        throw new Error('C# parser source changed after build');
    }
    if (JSON.stringify(outputFiles(parser.output)) !== JSON.stringify(parser.files)
        || digestFiles(parser.output, parser.files) !== parser.outputDigest)
    {
        throw new Error('C# parser output changed after build');
    }
    return JSON.parse(execFileSync('dotnet', [join(parser.directory, 'out/Parser.dll')], {
        cwd: parser.directory, input: source, encoding: 'utf8', timeout: 30_000,
        maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe']
    }));
}

export function csharpFormatFingerprint(source)
{
    return JSON.stringify(inspectCsharpFormat(source).fingerprint);
}
