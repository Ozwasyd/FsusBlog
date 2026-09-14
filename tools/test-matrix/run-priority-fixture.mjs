#!/usr/bin/env node
import fs from 'node:fs';
import process from 'node:process';

import { rankReadyTiers } from './priority-score.mjs';

const inputFile = process.argv[2];
if (!inputFile)
{
    process.stderr.write('usage: node tools/test-matrix/run-priority-fixture.mjs <fixture.json>\n');
    process.exit(2);
}

const fixture = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
const result = rankReadyTiers(
    fixture.tiers ?? [],
    fixture.priorityInput,
    {
        enabled: fixture.enabled,
        minimumSamples: fixture.minimumSamples,
        agingCap: fixture.agingCap,
        readyAges: fixture.readyAges
    }
);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
