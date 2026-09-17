import fs from 'node:fs';

export function readReceipt(file)
{
    return fs.readFileSync(file, 'utf8');
}
