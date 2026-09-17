import fs from 'node:fs';
import path from 'node:path';

export function writeBundleSummaryAtomically(summaryFile, summary)
{
    fs.mkdirSync(path.dirname(summaryFile), { recursive: true });
    const temporary = `${summaryFile}.next-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(summary, null, 2)}\n`);
    fs.renameSync(temporary, summaryFile);
    return JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
}
