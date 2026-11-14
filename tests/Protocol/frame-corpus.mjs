import { deepEqual, equal, throws } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';

const instance = (await WebAssembly.instantiate(readFileSync(process.argv[2]))).instance;
const { memory, fsus_aeds_buffer, fsus_aeds_validate } = instance.exports;
const address = fsus_aeds_buffer();
const fixtures = ['api-error-v1.hex', 'article-command.hex', 'article-detail-ard5.hex',
  'article-list-cursor-v2.hex', 'article-search-fas4.hex'].map(name => Buffer.from(
  readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8').replaceAll(/\s/g, ''), 'hex'));

const cases = [];
const seed = 0x20661411;
let state = seed;
function random(bound) {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return (state >>> 0) % bound;
}

for (const fixture of fixtures) {
  cases.push(fixture);
  for (let i = 0; i < 256; i++) {
    const mutated = Buffer.from(fixture);
    const flips = 1 + random(8);
    for (let j = 0; j < flips; j++) mutated[random(mutated.length)] ^= 1 << random(8);
    cases.push(mutated);
    cases.push(fixture.subarray(0, random(fixture.length)));
  }
}
for (let i = 0; i < 256; i++) {
  const noise = Buffer.alloc(random(256));
  for (let j = 0; j < noise.length; j++) noise[j] = random(256);
  cases.push(noise);
}

const results = [];
for (const bytes of cases) {
  const workspace = new Uint8Array(memory.buffer, address, bytes.length);
  workspace.set(bytes);
  const wasm = fsus_aeds_validate(bytes.length);
  let ts = 0;
  try { ts = decodeFrame(bytes).type; }
  catch (error) { if (!(error instanceof ProtocolError)) throw error; }
  equal(wasm, ts, 'seed ' + seed + ' case ' + results.length);
  results.push(wasm);
}
deepEqual(fixtures.map((_, i) => results[513 * i]), [251, 32771, 2, 1, 4]);
throws(() => decodeFrame(new Uint8Array(0)), ProtocolError);
console.log('AEDS deterministic JS/Wasm differential corpus passed (' + cases.length + ' cases, seed ' + seed + ')');
