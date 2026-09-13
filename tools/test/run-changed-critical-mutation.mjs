#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
    attributeMutantsToBehaviors,
    qualifyBehaviorMutations,
} from "./changed-critical-mutation-attribution.mjs";
import {
    createChangedCriticalMutationAuthority,
    scopeChangedCriticalMutationReport,
} from "./changed-critical-mutation-evidence.mjs";
import {
    readChangedPaths,
    repoRelative,
} from "./changed-critical-mutation-support.mjs";
import {
    createChangedCriticalStrykerConfig,
    selectChangedCriticalMutation,
    validateToolPolicy,
} from "./changed-critical-mutation.mjs";
import { sealMutationEvidenceReceipt } from "./mutation-evidence-receipt.mjs";

export function executeChangedCriticalSelection({ selection, spawnStryker }) {
    if (selection.status === "empty") {
        return {
            schema: "fsusblog.changed-critical-mutation-run.v1",
            status: "empty",
            closureDigest: selection.closureDigest,
            strykerStarted: false,
        };
    }
    const result = spawnStryker();
    if (result.status !== 0) {
        throw new Error(`Stryker failed with exit code ${result.status}`);
    }
    return {
        schema: "fsusblog.changed-critical-mutation-run.v1",
        status: "completed",
        closureDigest: selection.closureDigest,
        strykerStarted: true,
    };
}

function writeJsonAtomic(path, value) {
    mkdirSync(dirname(path), { recursive: true });
    const next = `${path}.next-${process.pid}`;
    writeFileSync(next, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(next, path);
}

function parseArguments(args) {
    const options = {
        catalog: null,
        changedPaths: null,
        sourceCommit: null,
        worktreeFingerprint: null,
        outputRoot: null,
        runId: null,
        ownerReceipt: null,
        behaviorCatalog: null,
        testBindings: null,
    };
    const names = new Map([
        ["--catalog", "catalog"],
        ["--changed-paths", "changedPaths"],
        ["--source-commit", "sourceCommit"],
        ["--worktree-fingerprint", "worktreeFingerprint"],
        ["--output-root", "outputRoot"],
        ["--run-id", "runId"],
        ["--owner-receipt", "ownerReceipt"],
        ["--behavior-catalog", "behaviorCatalog"],
        ["--test-bindings", "testBindings"],
    ]);
    for (let index = 0; index < args.length; index += 2) {
        const key = names.get(args[index]);
        const value = args[index + 1];
        if (!key || !value || value.startsWith("--")) {
            throw new Error(`unknown or incomplete option ${args[index]}`);
        }
        options[key] = value;
    }
    for (const [key, value] of Object.entries(options)) {
        if (!value) {
            throw new Error(`missing required option ${key}`);
        }
    }
    return options;
}

function findTraceLog(physicalOutput) {
    const logDirectory = resolve(physicalOutput, "logs");
    const traceFiles = readdirSync(logDirectory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /^log-.*\.txt$/u.test(entry.name))
        .map((entry) => resolve(logDirectory, entry.name))
        .sort((left, right) => left.localeCompare(right));
    if (traceFiles.length !== 1) {
        throw new Error(
            `physical Stryker run must emit exactly one verbose trace log; found ${traceFiles.length}`,
        );
    }
    return traceFiles[0];
}

function runPhysicalMutations({
    selection,
    toolPolicy,
    runDirectory,
    root,
    physicalRuns,
}) {
    const restore = spawnSync("dotnet", ["tool", "restore"], {
        cwd: root,
        stdio: "inherit",
    });
    if (restore.status !== 0) {
        return restore;
    }
    for (const closure of selection.projectClosures) {
        const runName = closure.sourceProject.replaceAll("/", "-");
        const physicalOutput = resolve(runDirectory, "physical", runName);
        const config = createChangedCriticalStrykerConfig(
            selection,
            toolPolicy,
            closure.sourceProject,
        );
        const configPath = resolve(runDirectory, "configs", `${runName}.json`);
        writeJsonAtomic(configPath, config);
        const reportPath = resolve(
            physicalOutput,
            "reports/changed-critical-mutation.json",
        );
        // Resume support: when a valid report already exists from a prior run
        // that was interrupted after Stryker completed (e.g. ENOSPC during
        // downstream attribution), skip re-running Stryker and reuse the
        // existing report.  This avoids a multi-hour re-run just to recover
        // the attribution/qualification phase.
        let reportUsable = false;
        try {
            JSON.parse(readFileSync(reportPath, "utf8"));
            reportUsable = true;
        } catch {
            reportUsable = false;
        }
        if (!reportUsable) {
            const result = spawnSync(
                "dotnet",
                [
                    "tool",
                    "run",
                    "dotnet-stryker",
                    "--config-file",
                    configPath,
                    "--output",
                    physicalOutput,
                    "--log-to-file",
                    "--verbosity",
                    "info",
                ],
                {
                    cwd: resolve(root, closure.sourceProject),
                    stdio: ["ignore", "ignore", "inherit"],
                    env: { ...process.env, FSUSBLOG_MUTATION_BUILD: "1" },
                },
            );
            if (result.status !== 0) {
                // Stryker exits non-zero when the mutation score is below the
                // break threshold.  The JSON report is written before the
                // crash, so check whether it exists and is valid before
                // treating this as a hard failure.  When the report is usable
                // the downstream qualification producer will evaluate it and
                // emit a proper receipt.
                try {
                    JSON.parse(readFileSync(reportPath, "utf8"));
                    reportUsable = true;
                } catch {
                    reportUsable = false;
                }
                if (!reportUsable) {
                    return result;
                }
            }
        }
        physicalRuns.push({
            sourceProject: closure.sourceProject,
            config,
            configPath,
            reportPath,
            tracePath: findTraceLog(physicalOutput),
        });
    }
    return { status: 0 };
}

/**
 * Run the physical Stryker closures for a selection.
 *
 * Reused by the canonical per-behavior mutation qualification producer so the
 * two runners share the exact same physical execution path.
 *
 * @returns {{ status: number, physicalRuns: object[] }}
 */
export function runChangedCriticalPhysicalMutations({
    selection,
    toolPolicy,
    runDirectory,
    root,
}) {
    const physicalRuns = [];
    const result = runPhysicalMutations({
        selection,
        toolPolicy,
        runDirectory,
        root,
        physicalRuns,
    });
    return { ...result, physicalRuns };
}

function main() {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const options = parseArguments(process.argv.slice(2));
    const toolPolicyPath = resolve(options.catalog);
    const rawToolPolicy = readFileSync(toolPolicyPath);
    const toolPolicy = JSON.parse(rawToolPolicy);
    validateToolPolicy(toolPolicy);
    const ownerReceiptPath = resolve(options.ownerReceipt);
    const ownerReceipt = JSON.parse(readFileSync(ownerReceiptPath));
    const behaviorCatalogPath = resolve(options.behaviorCatalog);
    const behaviorCatalog = JSON.parse(readFileSync(behaviorCatalogPath));
    const testBindingPath = resolve(options.testBindings);
    const rawTestBindingScan = readFileSync(testBindingPath);
    const testBindingScan = JSON.parse(rawTestBindingScan);
    const selection = selectChangedCriticalMutation({
        toolPolicy,
        rawToolPolicy,
        changedPaths: readChangedPaths(resolve(options.changedPaths)),
        sourceState: {
            commit: options.sourceCommit,
            worktreeFingerprint: options.worktreeFingerprint,
        },
        ownerReceipt,
        behaviorCatalog,
        testBindingScan,
        rawTestBindingScan,
    });
    const runDirectory = resolve(options.outputRoot, options.runId);
    const selectionPath = resolve(runDirectory, "selection.json");
    writeJsonAtomic(selectionPath, selection);
    const rawSelection = readFileSync(selectionPath);

    const physicalRuns = [];
    const run = executeChangedCriticalSelection({
        selection,
        spawnStryker: () =>
            runPhysicalMutations({
                selection,
                toolPolicy,
                runDirectory,
                root,
                physicalRuns,
            }),
    });
    writeJsonAtomic(resolve(runDirectory, "run.json"), run);
    if (run.status === "empty") {
        process.stdout.write(
            `[changed-critical-mutation] empty closure=${selection.closureDigest}; ` +
                "Stryker not started\n",
        );
        return;
    }

    const authorityRuns = physicalRuns.map((physical) => {
        const rawConfig = readFileSync(physical.configPath);
        const rawReport = readFileSync(physical.reportPath);
        const rawTrace = readFileSync(physical.tracePath);
        return {
            sourceProject: physical.sourceProject,
            config: physical.config,
            rawConfig,
            report: JSON.parse(rawReport),
            rawReport,
            reportAbsolutePath: physical.reportPath,
            rawTrace,
            paths: {
                config: repoRelative(root, physical.configPath),
                report: repoRelative(root, physical.reportPath),
                trace: repoRelative(root, physical.tracePath),
            },
        };
    });
    const runManifestPath = resolve(runDirectory, "run-manifest.json");
    writeJsonAtomic(runManifestPath, {
        schema: "fsusblog.changed-critical-mutation-run-manifest.v1",
        runs: authorityRuns.map((physical) => ({
            sourceProject: physical.sourceProject,
            config: physical.paths.config,
            report: physical.paths.report,
            trace: physical.paths.trace,
        })),
    });
    const authority = createChangedCriticalMutationAuthority({
        selection,
        rawSelection,
        catalog: toolPolicy,
        rawCatalog: rawToolPolicy,
        runs: authorityRuns,
        selectionPath: repoRelative(root, selectionPath),
        runId: options.runId,
        generatedAt: new Date().toISOString(),
        repositoryRoot: root,
    });
    writeJsonAtomic(resolve(runDirectory, "authority.json"), authority);
    const attributed = authorityRuns.map((physical) =>
        attributeMutantsToBehaviors({
            report: scopeChangedCriticalMutationReport(
                physical.report,
                selection.projectClosures.find(
                    ({ sourceProject }) =>
                        sourceProject === physical.sourceProject,
                ).mutateFiles,
                physical.sourceProject,
            ).report,
            sourceProject: physical.sourceProject,
            ownerReceipt,
            selection,
        }),
    );
    const attributions = attributed.flatMap(({ attributions }) => attributions);
    const blocked = attributed.flatMap(({ blocked }) => blocked);
    const qualification = qualifyBehaviorMutations({
        attributions,
        blocked,
        behaviorCatalog,
        behaviorIds: selection.behaviors.map(({ behaviorId }) => behaviorId),
    });
    const failureReasons = [
        ...blocked.map(
            (entry) => `${entry.mutantId} attribution blocked: ${entry.reason}`,
        ),
        ...qualification.qualifications.flatMap((entry) => entry.failures),
    ].sort();
    const mutationEvidence = sealMutationEvidenceReceipt({
        sourceCommit: selection.sourceState.commit,
        worktreeFingerprint: selection.sourceState.worktreeFingerprint,
        catalogDigest: selection.behaviorCatalogDigest,
        selectionDigest: selection.closureDigest,
        ownerReceiptDigest: ownerReceipt.contentDigest,
        testBindingScanDigest: selection.testBindingScanDigest,
        rawReportDigest: authority.rawReportDigest,
        rawTraceDigest: authority.rawTraceDigest,
        attributions,
        qualifications: qualification.qualifications,
        blockedCount: blocked.length,
        status: qualification.failed ? "failed" : "ok",
        failureReasons,
    });
    writeJsonAtomic(
        resolve(runDirectory, "mutation-evidence.json"),
        mutationEvidence,
    );
    process.stdout.write(
        `[changed-critical-mutation] ok closure=${selection.closureDigest} ` +
            `executed=${authority.mutants.executed} ` +
            `evidence=${repoRelative(root, resolve(runDirectory, "mutation-evidence.json"))}\n`,
    );
}

if (
    process.argv[1] &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
    try {
        main();
    } catch (error) {
        process.stderr.write(
            `[changed-critical-mutation] ` +
                `${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = 1;
    }
}
