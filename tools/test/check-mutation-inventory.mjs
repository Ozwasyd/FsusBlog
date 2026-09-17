#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateStrykerAuthority } from "./check-stryker-report.mjs";
import { readReleaseReliabilityEvidenceBinding } from "./release-reliability-evidence-binding.mjs";

function canonicalJson(value) {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(",")}]`;
    }
    if (value && typeof value === "object") {
        return `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
}

function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}

function requiredText(value, label) {
    if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`${label} is required`);
    }
    return value;
}

function requiredDigest(value, label) {
    if (!/^[0-9a-f]{64}$/u.test(requiredText(value, label))) {
        throw new Error(`${label} must be a SHA-256 digest`);
    }
    return value;
}

function requiredShare(value, label) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error(`${label} must be between 0 and 1`);
    }
    return value;
}

function uniqueStrings(value, label) {
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error(`${label} must be a non-empty array`);
    }
    const values = value.map((entry) => requiredText(entry, label));
    if (new Set(values).size !== values.length) {
        throw new Error(`${label} contains duplicates`);
    }
    return values.sort((left, right) => left.localeCompare(right));
}

function nonNegativeInteger(value, label) {
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`${label} must be a non-negative integer`);
    }
    return value;
}

function authorityInputPath(root, value, label) {
    const path = requiredText(value, label);
    const absolutePath = resolve(root, path);
    if (isAbsolute(path) || relative(root, absolutePath).startsWith("..")) {
        throw new Error(`${label} must be repository-relative`);
    }
    return absolutePath;
}

function validateAuthority(
    authority,
    repositoryRoot,
    authorityInputs,
    environment,
) {
    if (authorityInputs) {
        validateStrykerAuthority({ authority, ...authorityInputs });
        return {
            plannedIds: uniqueStrings(
                authority.plannedMutantIds,
                "authority plannedMutantIds",
            ),
            inventoryIds: authority.inventory
                .map(({ mutantId }) =>
                    requiredText(mutantId, "authority mutantId"),
                )
                .sort((left, right) => left.localeCompare(right)),
        };
    }
    const reportPath = authorityInputPath(
        repositoryRoot,
        authority?.rawReport?.path,
        "authority rawReport path",
    );
    const tracePath = authorityInputPath(
        repositoryRoot,
        authority?.rawTrace?.path,
        "authority rawTrace path",
    );
    const configPath = authorityInputPath(
        repositoryRoot,
        authority?.config?.path,
        "authority config path",
    );
    const rawReport = readFileSync(reportPath);
    const rawTrace = readFileSync(tracePath);
    const rawConfig = readFileSync(configPath);
    const report = JSON.parse(rawReport);
    const config = JSON.parse(rawConfig);
    const sourceRoot =
        authority?.sourceRoot ??
        (authority?.tierId === "release-mutation-critical-slice"
            ? "src/core"
            : undefined);
    const releaseReliability = readReleaseReliabilityEvidenceBinding({
        repositoryRoot,
        environment,
    });
    validateStrykerAuthority({
        authority,
        report,
        rawReport,
        reportPath: authority.rawReport.path,
        reportAbsolutePath: reportPath,
        rawTrace,
        tracePath: authority.rawTrace.path,
        config,
        rawConfig,
        configPath: authority.config.path,
        tierId: authority.tierId,
        runId: authority?.producer?.runId,
        sourceState: authority?.producer?.sourceState,
        generatedAt: authority?.producer?.generatedAt,
        repositoryRoot,
        sourceRoot,
        releaseReliability,
        scoreDenominator: authority?.scoreDenominator,
    });
    const plannedIds = uniqueStrings(
        authority.plannedMutantIds,
        "authority plannedMutantIds",
    );
    const inventoryIds = authority.inventory
        .map(({ mutantId }) => requiredText(mutantId, "authority mutantId"))
        .sort((left, right) => left.localeCompare(right));
    return { plannedIds, inventoryIds };
}

function validatePolicy(policy) {
    if (policy?.schema !== "fsusblog.mutation-inventory-retention.v1") {
        throw new Error("retention policy schema is invalid");
    }
    const baselineMutantIds = uniqueStrings(
        policy.baselineMutantIds,
        "baselineMutantIds",
    );
    const baselineInventoryDigest = requiredDigest(
        policy.baselineInventoryDigest,
        "baselineInventoryDigest",
    );
    if (baselineInventoryDigest !== sha256(canonicalJson(baselineMutantIds))) {
        throw new Error(
            "baselineInventoryDigest does not bind baselineMutantIds",
        );
    }
    const requiredSourceRegions = uniqueStrings(
        policy.requiredSourceRegions,
        "requiredSourceRegions",
    );
    const requiredOperators = uniqueStrings(
        policy.requiredOperators,
        "requiredOperators",
    );
    const minimumPlannedMutants = nonNegativeInteger(
        policy.minimumPlannedMutants,
        "minimumPlannedMutants",
    );
    const minimumExecutedMutants = nonNegativeInteger(
        policy.minimumExecutedMutants,
        "minimumExecutedMutants",
    );
    if (minimumPlannedMutants > baselineMutantIds.length) {
        throw new Error("minimumPlannedMutants exceeds baseline inventory");
    }
    return {
        baselineMutantIds,
        baselineInventoryDigest,
        requiredSourceRegions,
        requiredOperators,
        minimumPlannedMutants,
        minimumExecutedMutants,
        maximumIgnoredShare: requiredShare(
            policy.maximumIgnoredShare,
            "maximumIgnoredShare",
        ),
        maximumCompileErrorShare: requiredShare(
            policy.maximumCompileErrorShare,
            "maximumCompileErrorShare",
        ),
        maximumNoCoverageShare: requiredShare(
            policy.maximumNoCoverageShare,
            "maximumNoCoverageShare",
        ),
        retiredMutants: Array.isArray(policy.retiredMutants)
            ? policy.retiredMutants
            : (() => {
                  throw new Error("retiredMutants must be an array");
              })(),
    };
}

function validateRetirements({
    policy,
    authority,
    baselineMutantIds,
    plannedIds,
}) {
    const baseline = new Set(baselineMutantIds);
    const planned = new Set(plannedIds);
    const testIds = new Set(
        Array.isArray(authority.executedTestIds)
            ? authority.executedTestIds
            : [],
    );
    const retired = new Map();
    for (const entry of policy.retiredMutants) {
        const mutantId = requiredText(entry?.mutantId, "retired mutantId");
        if (!baseline.has(mutantId)) {
            throw new Error(
                `retirement references unknown baseline mutant ${mutantId}`,
            );
        }
        if (retired.has(mutantId)) {
            throw new Error(`retirement duplicates mutant ${mutantId}`);
        }
        const reasonCode = requiredText(
            entry.reasonCode,
            `retirement ${mutantId} reasonCode`,
        );
        if (reasonCode === "refactor") {
            throw new Error(
                `retirement ${mutantId} cannot use the generic refactor reason`,
            );
        }
        const replacements = Array.isArray(entry.replacementMutantIds)
            ? entry.replacementMutantIds.map((value) =>
                  requiredText(
                      value,
                      `retirement ${mutantId} replacementMutantIds`,
                  ),
              )
            : [];
        const proofs = Array.isArray(entry.proofTestIds)
            ? entry.proofTestIds.map((value) =>
                  requiredText(value, `retirement ${mutantId} proofTestIds`),
              )
            : [];
        if (replacements.length === 0 && proofs.length === 0) {
            throw new Error(
                `retirement ${mutantId} requires replacementMutantIds or proofTestIds`,
            );
        }
        if (
            new Set(replacements).size !== replacements.length ||
            new Set(proofs).size !== proofs.length
        ) {
            throw new Error(
                `retirement ${mutantId} has duplicate replacement or proof IDs`,
            );
        }
        for (const replacement of replacements) {
            if (!planned.has(replacement)) {
                throw new Error(
                    `retirement ${mutantId} replacement mutant ${replacement} is not planned`,
                );
            }
        }
        for (const proof of proofs) {
            if (!testIds.has(proof)) {
                throw new Error(
                    `retirement ${mutantId} proof test ${proof} is not executed`,
                );
            }
        }
        retired.set(mutantId, entry);
    }
    const missing = baselineMutantIds.filter(
        (mutantId) => !planned.has(mutantId) && !retired.has(mutantId),
    );
    if (missing.length > 0) {
        throw new Error(
            `baseline mutants were removed without retirement proof: ${missing.join(",")}`,
        );
    }
}

export function checkMutationInventory({
    authority,
    policy,
    repositoryRoot = process.cwd(),
    authorityInputs,
    environment = process.env,
}) {
    const { plannedIds } = validateAuthority(
        authority,
        repositoryRoot,
        authorityInputs,
        environment,
    );
    const retention = validatePolicy(policy);
    if (authority.tierId !== policy.scopeId) {
        throw new Error("authority tierId does not match retention scopeId");
    }
    if (plannedIds.length < retention.minimumPlannedMutants) {
        throw new Error("planned mutant count is below minimumPlannedMutants");
    }
    const executed = authority.inventory.filter(({ status }) =>
        ["Killed", "Survived", "Timeout"].includes(status),
    );
    if (executed.length < retention.minimumExecutedMutants) {
        throw new Error(
            "executed mutant count is below minimumExecutedMutants",
        );
    }
    for (const sourceRegion of retention.requiredSourceRegions) {
        if (
            !authority.inventory.some(
                ({ sourceFile }) => sourceFile === sourceRegion,
            )
        ) {
            throw new Error(
                `required source region has no mutant: ${sourceRegion}`,
            );
        }
    }
    for (const operator of retention.requiredOperators) {
        if (!authority.inventory.some((entry) => entry.operator === operator)) {
            throw new Error(`required operator has no mutant: ${operator}`);
        }
    }
    for (const [status, maximum] of [
        ["Ignored", retention.maximumIgnoredShare],
        ["CompileError", retention.maximumCompileErrorShare],
        ["NoCoverage", retention.maximumNoCoverageShare],
    ]) {
        const share =
            authority.inventory.filter((entry) => entry.status === status)
                .length / authority.inventory.length;
        if (share > maximum) {
            throw new Error(
                `${status} share ${share} exceeds retention policy ${maximum}`,
            );
        }
    }
    validateRetirements({
        policy: retention,
        authority,
        baselineMutantIds: retention.baselineMutantIds,
        plannedIds,
    });
    const policyDigest = sha256(canonicalJson(policy));
    return {
        schema: "fsusblog.mutation-inventory-retention-result.v1",
        status: "success",
        scopeId: policy.scopeId,
        score: authority.score,
        inventory: {
            planned: plannedIds.length,
            executed: executed.length,
            baseline: retention.baselineMutantIds.length,
        },
        coverage: {
            operators: [
                ...new Set(authority.inventory.map(({ operator }) => operator)),
            ].sort(),
            sourceRegions: [
                ...new Set(
                    authority.inventory.map(({ sourceFile }) => sourceFile),
                ),
            ].sort(),
        },
        statusShares: Object.fromEntries(
            ["Ignored", "CompileError", "NoCoverage"].map((status) => [
                status,
                authority.inventory.filter((entry) => entry.status === status)
                    .length / authority.inventory.length,
            ]),
        ),
        candidateIdentity: sha256(
            canonicalJson({
                scopeId: policy.scopeId,
                authorityInventoryDigest: authority.inventoryDigest,
                authorityExecutionMatrixDigest: authority.executionMatrixDigest,
                authorityRawReportDigest: authority.rawReport.sha256,
                authorityRawTraceDigest: authority.rawTrace.sha256,
                authorityConfigDigest: authority.config.sha256,
                policyDigest,
                retirementLedgerDigest: sha256(
                    canonicalJson(policy.retiredMutants),
                ),
            }),
        ),
    };
}

function writeJsonAtomic(path, value) {
    mkdirSync(dirname(path), { recursive: true });
    const temporaryPath = `${path}.tmp-${process.pid}`;
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 4)}\n`);
    renameSync(temporaryPath, path);
}

function parseOptions(args) {
    if (args.length !== 2 || args[0] !== "--authority") {
        throw new Error(
            "usage: node tools/test/check-mutation-inventory.mjs --authority <authority.json>",
        );
    }
    return { authorityPath: args[1] };
}

function main() {
    const { authorityPath } = parseOptions(process.argv.slice(2));
    const authority = JSON.parse(readFileSync(resolve(authorityPath), "utf8"));
    const policyPath = resolve(
        "config/testing/mutation/inventory-retention.json",
    );
    const policy = JSON.parse(readFileSync(policyPath, "utf8"));
    const result = checkMutationInventory({ authority, policy });
    const outputPath = resolve(
        dirname(authorityPath),
        "inventory-retention.json",
    );
    writeJsonAtomic(outputPath, result);
    process.stdout.write(
        `[mutation-inventory] ok scope=${result.scopeId} planned=${result.inventory.planned} executed=${result.inventory.executed} candidate=${result.candidateIdentity}\n`,
    );
}

if (
    process.argv[1] &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
    try {
        main();
    } catch (error) {
        process.stderr.write(`[mutation-inventory] ${error.message}\n`);
        process.exitCode = 1;
    }
}
