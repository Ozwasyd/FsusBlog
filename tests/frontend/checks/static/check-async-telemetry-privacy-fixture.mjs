#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const checker = resolve(repoRoot, 'tools/security/check-async-telemetry-privacy.mjs')

function runFixture(source) {
  const root = mkdtempSync(join(tmpdir(), 'fsusblog-async-privacy-'))
  try {
    const sourceRoot = join(root, 'src/backend')
    mkdirSync(sourceRoot, { recursive: true })
    writeFileSync(join(sourceRoot, 'Queue.cs'), source)
    return spawnSync(process.execPath, [checker, '--root', root], { encoding: 'utf8' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const accepted = runFixture(`
using System.Threading.Channels;
public readonly record struct SafeTelemetry(string? ClientIpHash, int Count);
public sealed class SafeQueue
{
    private readonly Channel<SafeTelemetry> _queue = Channel.CreateBounded<SafeTelemetry>(8);
}
`)
if (accepted.status !== 0) {
  throw new Error(`safe hash-only contract was rejected:\n${accepted.stderr}`)
}

for (const [label, source, expected] of [
  [
    'raw field',
    `using System.Threading.Channels; public record BadTelemetry(string RemoteIpAddress); public class Q { Channel<BadTelemetry> Queue = Channel.CreateBounded<BadTelemetry>(8); }`,
    'raw network identifier RemoteIpAddress'
  ],
  [
    'raw type',
    `using System.Net; using System.Threading.Channels; public record BadTelemetry(IPAddress Address); public class Q { Channel<BadTelemetry> Queue = Channel.CreateBounded<BadTelemetry>(8); }`,
    'raw network type IPAddress'
  ],
  [
    'raw scalar sink',
    `using System.Threading.Channels; public class Q { Channel<string> Queue = Channel.CreateBounded<string>(8); void Add(HttpContext context) => Queue.Writer.TryWrite(context.Connection.RemoteIpAddress!.ToString()); }`,
    'raw request network identity flows into an async writer'
  ]
]) {
  const result = runFixture(source)
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  if (result.status === 0 || !output.includes(expected)) {
    throw new Error(`${label} fixture did not fail with ${expected}:\n${output}`)
  }
}

console.log('[check-async-telemetry-privacy-fixture] ok')
