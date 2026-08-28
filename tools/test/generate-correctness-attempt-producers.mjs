#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    buildCorrectnessAttemptProducerInventory,
    correctnessAttemptProducerFile
} from './correctness-attempt-producers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(root, correctnessAttemptProducerFile);
const generated = `${JSON.stringify(buildCorrectnessAttemptProducerInventory(root), null, 4)}\n`;

if (process.argv.includes('--write'))
{
    fs.writeFileSync(output, generated);
    process.stdout.write(`${correctnessAttemptProducerFile}\n`);
}
else if (process.argv.includes('--check'))
{
    if (!fs.existsSync(output) || fs.readFileSync(output, 'utf8') !== generated)
    {
        process.stderr.write(`${correctnessAttemptProducerFile} is stale\n`);
        process.exitCode = 1;
    }
}
else
{
    process.stdout.write(generated);
}
