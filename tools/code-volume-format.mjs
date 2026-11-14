// One Prettier process handles the entire stream; no project config or plugins.
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const root = process.env.CODE_VOLUME_PRETTIER_ROOT ?? '../../FsusUI';
const path = require.resolve('prettier', { paths: [resolve(import.meta.dirname, root)] });
const { default: formatter } = await import(pathToFileURL(path));
if (formatter.version !== '3.8.1') throw new Error(`Expected Prettier 3.8.1, got ${formatter.version}`);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const { source, parser } = JSON.parse(line);
  try {
    const formatted = await formatter.format(source, { parser, printWidth: 100, objectWrap: 'collapse' });
    process.stdout.write(`${JSON.stringify({ formatted })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: String(error).split('\n', 1)[0] })}\n`);
  }
}
