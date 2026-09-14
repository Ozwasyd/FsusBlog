#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2)
{
    args.set(process.argv[index], process.argv[index + 1]);
}

const inputDirectory = args.get("--input");
const outputPath = args.get("--output");
if (!inputDirectory || !outputPath)
{
    throw new Error("usage: summarize-http3-local-evidence.mjs --input <directory> --output <file>");
}

async function readJson(name)
{
    return JSON.parse(await readFile(path.join(inputDirectory, name), "utf8"));
}

const probes = {
    h2PublicReuse: await readJson("h2-public-reuse.json"),
    h3PublicReuse: await readJson("h3-public-reuse.json"),
    h3LargeCold: await readJson("h3-large-cold.json"),
    h3Wasm: await readJson("h3-wasm.json"),
    h3Search: await readJson("h3-search.json"),
    h3Aeds: await readJson("h3-aeds.json"),
    h3Upload: await readJson("h3-upload.json"),
    h2Notification: await readJson("h2-notification.json")
};
const preflight = await readJson("preflight.json");
const curlH3 = await readJson("curl-h3.json");
const udpFallback = await readJson("udp-fallback.json");
const missingMsQuicFallback = await readJson("missing-msquic-fallback.json");
const errorScenarios = {
    cancellation: await readJson("h3-cancel.json"),
    timeout: await readJson("h3-timeout.json"),
    tlsRejected: await readJson("tls-rejected.json")
};
const netemRows = (await readFile(path.join(inputDirectory, "netem.csv"), "utf8"))
    .trim()
    .split(/\r?\n/u)
    .slice(1)
    .map((line) =>
    {
        const [condition, delayMs, lossPercent, round, requested, httpVersion, statusCode, timeTotal, exitCode] = line.split(",");
        return {
            condition,
            delayMs: Number(delayMs),
            lossPercent: Number(lossPercent),
            round: Number(round),
            requested,
            httpVersion,
            statusCode: Number(statusCode),
            latencyMs: Number(timeTotal) * 1000,
            exitCode: Number(exitCode)
        };
    });

const requiredConditions = ["baseline", "rtt40", "rtt100", "rtt200", "loss1", "loss3", "loss5"];
const matrixComplete = requiredConditions.every((condition) =>
    ["h2", "h3"].every((protocol) =>
        netemRows.filter((row) => row.condition === condition
            && row.requested === protocol
            && row.exitCode === 0
            && row.statusCode === 200).length >= 3));
const h3ProbeComplete = Object.entries(probes)
    .filter(([name]) => name.startsWith("h3"))
    .every(([, probe]) => probe.status === "complete"
        && probe.outcome.failed === 0
        && probe.outcome.http3Success === probe.outcome.attempts);
const h2ProbeComplete = probes.h2PublicReuse.outcome.protocolDistribution.http2 === probes.h2PublicReuse.outcome.attempts
    && probes.h2Notification.outcome.protocolDistribution.http2 === probes.h2Notification.outcome.attempts;
const fallbacksComplete = udpFallback.status === "complete"
    && udpFallback.http_version === "2"
    && udpFallback.status_code === 200
    && ["complete", "skipped"].includes(missingMsQuicFallback.status);
const errorScenariosComplete = errorScenarios.cancellation.outcome.errorCategories.cancelled > 0
    && errorScenarios.timeout.outcome.errorCategories.timeout > 0
    && errorScenarios.tlsRejected.outcome.errorCategories.tls_handshake > 0;
const complete = preflight.status === "ready"
    && curlH3.http_version === "3"
    && curlH3.status_code === 200
    && h3ProbeComplete
    && h2ProbeComplete
    && fallbacksComplete
    && errorScenariosComplete
    && matrixComplete;

function percentile(values, ratio)
{
    const sorted = values.toSorted((left, right) => left - right);
    return sorted.length === 0 ? 0 : sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

const matrix = requiredConditions.flatMap((condition) => ["h2", "h3"].map((protocol) =>
{
    const rows = netemRows.filter((row) => row.condition === condition && row.requested === protocol);
    return {
        condition,
        protocol,
        rounds: rows.length,
        successes: rows.filter((row) => row.exitCode === 0 && row.statusCode === 200).length,
        latencyMs: {
            p50: percentile(rows.map((row) => row.latencyMs), 0.5),
            p95: percentile(rows.map((row) => row.latencyMs), 0.95),
            p99: percentile(rows.map((row) => row.latencyMs), 0.99)
        }
    };
}));

const summary = {
    schema: "fsusblog.http3-local-equivalent-evidence.v1",
    status: complete ? "complete" : "incomplete",
    scope: "local Kestrel-only single-process transport experiment",
    publicNetworkClaim: false,
    prerequisites: preflight,
    clients: {
        dotnetRequestVersionExact: h3ProbeComplete && h2ProbeComplete,
        curlHttp3Only: curlH3
    },
    fallbacks: {
        udpBlocked: udpFallback,
        msquicMissing: missingMsQuicFallback
    },
    errorScenarios,
    probes,
    networkMatrix: matrix,
    releaseDecision: {
        http3DefaultEnabled: false,
        decision: "keep_opt_in_experiment",
        reason: "local evidence is environment-specific and does not establish a stable public-network benefit"
    }
};

await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ status: summary.status, output: outputPath }));
if (!complete)
{
    process.exitCode = 3;
}
