import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../src/frontend/package.json', import.meta.url));
const ts = require('typescript');
const baseline = '0a755584aa256995fd9997ca974806e8a0e29d2e';
const candidate = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const sourcePath = 'src/frontend/src/generated/fsusBinaryRoutes.ts';
const digest = source => createHash('sha256').update(source).digest('hex');
async function builder(sha) {
  const source = execFileSync('git', ['show', `${sha}:${sourcePath}`], { encoding: 'utf8' });
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return { build: (await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)).buildFsusBinaryRoute, digest: digest(source) };
}
const before = await builder(baseline), after = await builder(candidate);
const scenarios = [
  ['binary_get_category_aeds', {}, undefined],
  ['binary_get_article_id_aeds', { id: 11 }, undefined],
  ['binary_get_article_search_query_aeds', {}, { q: 'AEDS 空白&参数', page: 2, size: 20 }],
  ['binary_get_admin_article_id_int', { id: 42 }, { tab: 'current', include: true }]
];
for (const args of scenarios) {
  if (before.build(...args) !== after.build(...args)) throw new Error('URL semantic drift');
}
let consumed = 0;
function batch(build, count) {
  const start = performance.now();
  for (let index = 0; index < count; index++) consumed += build(...scenarios[index % scenarios.length]).length;
  return (performance.now() - start) * 1e6 / count;
}
batch(before.build, 100000); batch(after.build, 100000);
const beforeSamples = [], afterSamples = [];
for (let index = 0; index < 41; index++) {
  if (index % 2) { afterSamples.push(batch(after.build, 100000)); beforeSamples.push(batch(before.build, 100000)); }
  else { beforeSamples.push(batch(before.build, 100000)); afterSamples.push(batch(after.build, 100000)); }
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const report = {
  schema: 'fsusblog.task-route-url-diagnostic.v1', runIdentity: new Date().toISOString(), node: process.version,
  baseline, candidate, sourcePath, baselineBlobSha256: before.digest, candidateBlobSha256: after.digest,
  scope: 'Actual generated URL builder in Node only; excludes full request allocation, browser runtime and bundle qualification.',
  samples: 41, operationsPerSample: 100000, beforeSamplesNs: beforeSamples, afterSamplesNs: afterSamples,
  baselineMedianNs: median(beforeSamples), candidateMedianNs: median(afterSamples),
  ratio: median(afterSamples) / median(beforeSamples), withinTwoPercent: median(afterSamples) / median(beforeSamples) <= 1.02, consumed
};
writeFileSync(`.tmp/1773/route-url-benchmark-${candidate}.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ baseline, candidate, baselineMedianNs: report.baselineMedianNs, candidateMedianNs: report.candidateMedianNs, ratio: report.ratio, withinTwoPercent: report.withinTwoPercent }));
