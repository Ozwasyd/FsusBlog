import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const summarizer = path.join(root, "tools/transport/summarize-http3-local-evidence.mjs");

test("HTTP/3 evidence summary requires both clients, fallbacks, error categories, and all netem cells", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "fsus-http3-evidence-"));
    try {
        const probe = (major = 3) => ({
            schema: "fsusblog.http3-probe.v1",
            status: "complete",
            outcome: {
                attempts: 3,
                failed: 0,
                http3Success: major === 3 ? 3 : 0,
                protocolDistribution: { [`http${major}`]: 3 },
                errorCategories: {}
            }
        });
        const files = {
            "preflight.json": { status: "ready" },
            "h2-public-reuse.json": probe(2),
            "h3-public-reuse.json": probe(),
            "h3-large-cold.json": probe(),
            "h3-wasm.json": probe(),
            "h3-search.json": probe(),
            "h3-aeds.json": probe(),
            "h3-upload.json": probe(),
            "h2-notification.json": probe(2),
            "curl-h3.json": { status: "complete", http_version: "3", status_code: 200 },
            "udp-fallback.json": { status: "complete", http_version: "2", status_code: 200 },
            "missing-msquic-fallback.json": { status: "complete", http_version: "1.1", status_code: 200 },
            "h3-cancel.json": { outcome: { errorCategories: { cancelled: 2 } } },
            "h3-timeout.json": { outcome: { errorCategories: { timeout: 2 } } },
            "tls-rejected.json": { outcome: { errorCategories: { tls_handshake: 1 } } }
        };
        await Promise.all(Object.entries(files).map(([name, value]) =>
            writeFile(path.join(directory, name), `${JSON.stringify(value)}\n`, "utf8")));

        const rows = ["condition,delay_ms,loss_percent,round,requested,http_version,status,time_total,exit_code"];
        for (const condition of ["baseline", "rtt40", "rtt100", "rtt200", "loss1", "loss3", "loss5"]) {
            for (const protocol of ["h2", "h3"]) {
                for (let round = 1; round <= 3; round += 1) {
                    rows.push(`${condition},0,0,${round},${protocol},${protocol === "h2" ? 2 : 3},200,0.01,0`);
                }
            }
        }
        await writeFile(path.join(directory, "netem.csv"), `${rows.join("\n")}\n`, "utf8");

        const output = path.join(directory, "summary.json");
        await execFileAsync(process.execPath, [summarizer, "--input", directory, "--output", output]);
        const summary = JSON.parse(await readFile(output, "utf8"));

        assert.equal(summary.status, "complete");
        assert.equal(summary.publicNetworkClaim, false);
        assert.equal(summary.releaseDecision.http3DefaultEnabled, false);
        assert.equal(summary.networkMatrix.length, 14);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
