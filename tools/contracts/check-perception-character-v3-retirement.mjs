#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const rootArgumentIndex = process.argv.indexOf('--root');
const root = rootArgumentIndex >= 0
    ? path.resolve(process.argv[rootArgumentIndex + 1] ?? '')
    : repositoryRoot;
const historyRelative = 'docs/security/perception-character-v3-protocol.md';
const historyStart = '<!-- retired-v3-history:start -->';
const historyEnd = '<!-- retired-v3-history:end -->';
const retired = [
    ['retired algorithm', /fsu\.challenge\/perception-character-raster@v3/giu],
    ['retired visual media', /application\/x-fsus-gray8/giu],
    ['retired audio media', /audio\/wav/giu],
    ['retired dimensions', /512\s*(?:x|×|\*)\s*192/giu],
    ['retired raw payload size', /98(?:,|\s)?304(?:-byte|\s+bytes?)/giu]
];
const productionRoots = [
    'src/backend',
    'src/shared',
    'src/core',
    'src/frontend/src',
    'config'
];


function files(directory)
{
    if (!fs.existsSync(directory))
    {
        return [];
    }
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory())
        {
            return ['bin', 'obj', 'node_modules', 'wwwroot'].includes(entry.name) ? [] : files(absolute);
        }
        return entry.isFile() ? [absolute] : [];
    });
}

function inspect(relative, source, errors)
{
    for (const [label, expression] of retired)
    {
        expression.lastIndex = 0;
        if (expression.test(source))
        {
            errors.push(`${relative}: ${label} remains`);
        }
    }
}

export function validatePerceptionCharacterRetirement(root)
{
    const errors = [];
    for (const productionRoot of productionRoots)
    {
        for (const file of files(path.join(root, productionRoot)))
        {
            const relative = path.relative(root, file);
            let source;
            try
            {
                source = fs.readFileSync(file, 'utf8');
            }
            catch
            {
                continue;
            }
            inspect(relative, source, errors);
        }
    }

    const historyFile = path.join(root, historyRelative);
    if (!fs.existsSync(historyFile))
    {
        errors.push(`${historyRelative}: historical retirement note is missing`);
    }
    else
    {
        const history = fs.readFileSync(historyFile, 'utf8');
        const start = history.indexOf(historyStart);
        const end = history.indexOf(historyEnd);
        if (start < 0 || end <= start || history.indexOf(historyStart, start + historyStart.length) >= 0
      || history.indexOf(historyEnd, end + historyEnd.length) >= 0)
        {
            errors.push(`${historyRelative}: exactly one bounded historical retirement note is required`);
        }
        else
        {
            const note = history.slice(start, end + historyEnd.length);
            for (const [label, expression] of retired)
            {
                expression.lastIndex = 0;
                if (!expression.test(note))
                {
                    errors.push(`${historyRelative}: historical note does not identify ${label}`);
                }
            }
            inspect(historyRelative, `${history.slice(0, start)}${history.slice(end + historyEnd.length)}`, errors);
        }
    }

    for (const file of files(path.join(root, 'docs')))
    {
        const relative = path.relative(root, file);
        if (relative === historyRelative)
        {
            continue;
        }
        let source;
        try
        {
            source = fs.readFileSync(file, 'utf8');
        }
        catch
        {
            continue;
        }
        inspect(relative, source, errors);
    }

    return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    const errors = validatePerceptionCharacterRetirement(root);
    if (errors.length > 0)
    {
        process.stderr.write(`[perception-character-v3-retirement] ${errors.join('; ')}\n`);
        process.exit(1);
    }
    process.stdout.write('[perception-character-v3-retirement] ok\n');

}
