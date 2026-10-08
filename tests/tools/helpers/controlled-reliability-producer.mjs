import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// Explicit protocol fixture inputs; this producer does not run production measurements
// or assert native containment, image, database or runtime acceptance.
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const canonicalize = value => Array.isArray(value) ? value.map(canonicalize)
    : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]))
        : value;
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const observations = [];
for (const entry of input.documents)
{
    const absolute = path.resolve(input.root, entry.path);
    if (!absolute.startsWith(`${path.resolve(input.root)}${path.sep}`)
        || !entry.path.startsWith('.tmp/') || fs.existsSync(absolute))
    {
        throw new Error('controlled producer output must be absent and owned by the fixture');
    }
    const document = structuredClone(entry.document);
    if (Object.hasOwn(document, 'contentDigest'))
    {
        const { contentDigest: ignored, ...content } = document;
        void ignored;
        document.contentDigest = digest(JSON.stringify(canonicalize(content)));
    }
    const bytes = `${JSON.stringify(document, null, 2)}\n`;
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, bytes, { flag: 'wx', mode: 0o600 });
    observations.push({ path: entry.path, digest: digest(bytes), contentDigest: document.contentDigest ?? null });
}
process.stdout.write(JSON.stringify({
    schema: 'fsusblog.controlled-reliability-producer-observation.v1',
    fixtureOnly: true, runtimeQualificationEligible: false,
    scenarioId: input.scenarioId, pid: process.pid,
    executable: process.execPath, argv: process.argv.slice(1),
    observations
}));
