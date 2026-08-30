import { readFileSync } from 'node:fs';
import process from 'node:process';

import { analyzeHtmlSinks, formatHtmlSinkDiagnostic } from './html-sink-ast.mjs';

function parseCliFiles(argv)
{
    const files = [];
    for (let index = 2; index < argv.length; index += 1)
    {
        if (argv[index] === '--file')
        {
            const value = argv[index + 1];
            if (!value)
            {
                throw new Error('--file requires a path');
            }
            files.push(value);
            index += 1;
            continue;
        }
        throw new Error(`unknown argument ${argv[index]}`);
    }
    return files;
}

function runCli(argv)
{
    const files = parseCliFiles(argv);
    if (files.length === 0)
    {
        process.stderr.write('usage: node tools/security/html-sink-ast-cli.mjs --file <path>\n');
        process.exitCode = 2;
        return;
    }

    let failed = false;
    for (const filePath of files)
    {
        const diagnostics = analyzeHtmlSinks(readFileSync(filePath, 'utf8'), { filePath });
        for (const diagnostic of diagnostics)
        {
            failed = true;
            process.stderr.write(`${formatHtmlSinkDiagnostic(diagnostic)}\n`);
        }
    }
    process.exitCode = failed ? 1 : 0;
}

try
{
    runCli(process.argv);
}
catch (error)
{
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
}
