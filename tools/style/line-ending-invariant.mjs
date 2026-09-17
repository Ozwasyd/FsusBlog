#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(scriptPath), '../..');

function parseArguments(argv)
{
    const parsed = { root: defaultRoot };
    for (let index = 0; index < argv.length; index += 1)
    {
        const argument = argv[index];
        if (argument !== '--root')
        {
            throw new Error(`unknown argument ${argument}`);
        }
        const value = argv[index + 1];
        if (!value)
        {
            throw new Error('--root requires a value');
        }
        parsed.root = path.resolve(value);
        index += 1;
    }
    return parsed;
}

function runGit(root, argumentsList, options = {})
{
    const result = spawnSync('git', argumentsList, {
        cwd: root,
        encoding: options.encoding,
        input: options.input,
        maxBuffer: 64 * 1024 * 1024
    });
    if (result.status !== 0)
    {
        const stderr = Buffer.isBuffer(result.stderr)
            ? result.stderr.toString('utf8')
            : String(result.stderr ?? '');
        const stdout = Buffer.isBuffer(result.stdout)
            ? result.stdout.toString('utf8')
            : String(result.stdout ?? '');
        throw new Error(`git ${argumentsList.join(' ')} failed: ${(stderr || stdout).trim()}`);
    }
    return result.stdout;
}

function parseTrackedFiles(root)
{
    const output = runGit(root, ['ls-files', '--eol', '-z']);
    return output.toString('utf8')
        .split('\0')
        .filter(Boolean)
        .map((record) =>
        {
            const separator = record.indexOf('\t');
            if (separator < 0)
            {
                throw new Error(`cannot parse git ls-files --eol record: ${record}`);
            }
            const metadata = record.slice(0, separator);
            const file = record.slice(separator + 1);
            const match = metadata.match(/^i\/(\S+)\s+w\/(\S+)\s+attr\/(.*)$/u);
            if (!match)
            {
                throw new Error(`cannot parse git ls-files --eol metadata for ${file}: ${metadata}`);
            }
            return {
                file,
                indexState: match[1],
                worktreeState: match[2]
            };
        })
        .sort((left, right) => left.file === right.file ? 0 : left.file < right.file ? -1 : 1);
}

function readAttributes(root, files)
{
    if (files.length === 0)
    {
        return new Map();
    }
    const input = Buffer.from(`${files.join('\0')}\0`, 'utf8');
    const output = runGit(
        root,
        ['check-attr', '-z', '--stdin', 'text', 'eol'],
        { input }
    ).toString('utf8').split('\0');
    if (output.at(-1) === '')
    {
        output.pop();
    }
    if (output.length % 3 !== 0)
    {
        throw new Error('cannot parse git check-attr output');
    }
    const attributes = new Map();
    for (let index = 0; index < output.length; index += 3)
    {
        const file = output[index];
        const name = output[index + 1];
        const value = output[index + 2];
        const fileAttributes = attributes.get(file) ?? {};
        fileAttributes[name] = value;
        attributes.set(file, fileAttributes);
    }
    return attributes;
}

function inspectLineEndings(content)
{
    let crlf = 0;
    let lf = 0;
    let loneCr = 0;
    for (let index = 0; index < content.length; index += 1)
    {
        const value = content[index];
        if (value === 0x0d)
        {
            if (content[index + 1] === 0x0a)
            {
                crlf += 1;
                index += 1;
            }
            else
            {
                loneCr += 1;
            }
        }
        else if (value === 0x0a)
        {
            lf += 1;
        }
    }
    return { crlf, lf, loneCr };
}

function isBinary(record, attributes)
{
    return attributes.text === 'unset'
    || (record.indexState === '-text' && record.worktreeState === '-text');
}

function validateFile(root, record, attributes)
{
    if (isBinary(record, attributes))
    {
        return { binary: true, diagnostics: [] };
    }
    if (!['lf', 'crlf'].includes(attributes.eol))
    {
        return {
            binary: false,
            diagnostics: [`resolved text file has no explicit LF or CRLF policy (eol=${attributes.eol ?? 'unspecified'})`]
        };
    }
    const absolute = path.join(root, ...record.file.split('/'));
    if (!fs.existsSync(absolute))
    {
        return { binary: false, diagnostics: ['tracked worktree file is missing'] };
    }
    const endings = inspectLineEndings(fs.readFileSync(absolute));
    if (endings.loneCr > 0)
    {
        return {
            binary: false,
            diagnostics: [`contains ${endings.loneCr} lone carriage-return byte(s)`]
        };
    }
    if (endings.crlf > 0 && endings.lf > 0)
    {
        return {
            binary: false,
            diagnostics: [`contains mixed line endings (CRLF=${endings.crlf}, LF=${endings.lf})`]
        };
    }
    if (attributes.eol === 'lf' && endings.crlf > 0)
    {
        return {
            binary: false,
            diagnostics: [`expected LF but found ${endings.crlf} CRLF line ending(s)`]
        };
    }
    if (attributes.eol === 'crlf' && endings.lf > 0)
    {
        return {
            binary: false,
            diagnostics: [`expected CRLF but found ${endings.lf} LF line ending(s)`]
        };
    }
    return { binary: false, diagnostics: [] };
}

function main()
{
    const { root } = parseArguments(process.argv.slice(2));
    const tracked = parseTrackedFiles(root);
    const attributes = readAttributes(root, tracked.map((record) => record.file));
    const diagnostics = [];
    let binary = 0;
    let checked = 0;
    let crlfExceptions = 0;

    for (const record of tracked)
    {
        const fileAttributes = attributes.get(record.file) ?? {};
        const result = validateFile(root, record, fileAttributes);
        if (result.binary)
        {
            binary += 1;
            continue;
        }
        checked += 1;
        if (fileAttributes.eol === 'crlf')
        {
            crlfExceptions += 1;
        }
        for (const message of result.diagnostics)
        {
            diagnostics.push(`${record.file}: ${message}`);
        }
    }

    if (diagnostics.length > 0)
    {
        for (const diagnostic of diagnostics)
        {
            process.stderr.write(`[line-endings] ${diagnostic}\n`);
        }
        process.stderr.write(
            `[line-endings] failed tracked=${tracked.length} checked=${checked} binary=${binary} crlfExceptions=${crlfExceptions} violations=${diagnostics.length}\n`
        );
        process.exitCode = 1;
        return;
    }

    process.stdout.write(
        `[line-endings] ok tracked=${tracked.length} checked=${checked} binary=${binary} crlfExceptions=${crlfExceptions} violations=0\n`
    );
}

try
{
    main();
}
catch (error)
{
    process.stderr.write(`[line-endings] fatal: ${error.stack ?? error.message}\n`);
    process.exitCode = 1;
}
