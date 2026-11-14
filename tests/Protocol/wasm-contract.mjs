import { equal } from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const bytes = readFileSync(process.argv[2]);
const { instance } = await WebAssembly.instantiate(bytes);
const { memory, fsus_aeds_buffer, fsus_aeds_validate } = instance.exports;
const address = fsus_aeds_buffer();

for (const [fixture, type] of [
  ['api-error-v1.hex', 251],
  ['article-command.hex', 32771],
  ['article-detail-ard5.hex', 2],
  ['article-list-cursor-v2.hex', 1],
  ['article-search-fas4.hex', 4],
]) {
  const hex = readFileSync(new URL(`./fixtures/${fixture}`, import.meta.url), 'utf8').trim();
  const frame = Buffer.from(hex, 'hex');
  const payload = new Uint8Array(memory.buffer, address, frame.length);
  payload.set(frame);
  equal(fsus_aeds_validate(frame.length), type, fixture);
  equal(fsus_aeds_validate(frame.length - 1), 0, `short ${fixture}`);
  equal(fsus_aeds_validate(-1), 0, `oversize ${fixture}`);
  payload[payload.length - 1] ^= 1;
  equal(fsus_aeds_validate(frame.length), 0, `corrupt ${fixture}`);
}

console.log('AEDS Wasm frame checks passed');
