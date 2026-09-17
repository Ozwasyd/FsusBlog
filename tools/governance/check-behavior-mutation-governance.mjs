#!/usr/bin/env node
/**
 * Static governance for per-behavior mutation qualification (#2187, item 12).
 *
 * Fails closed when the required release mutation path can be skipped,
 * masked by a global score, replaced by manual approval, allowed to reuse
 * history, filtered by a mutant allowlist, or overridden by a warning/force:
 *
 *   - backend-mutation-changed-critical must be automatic (cadence pr),
 *     production-required (requiredFor production), never manualOnly,
 *     never nightlyOnly and never release-manual;
 *   - mutation tooling/configs may not carry global-score-pass, manual
 *     override/approval, history reuse, mutant allowlist, warning-success or
 *     skip/fallback fields;
 *   - every active mutation-required behavior must require executed mutants
 *     and forbid equivalent-mutant acceptance in the BehaviorCatalog;
 *   - the canonical producer/verifier and the fail-closed lane inputs must
 *     exist, and the lane must reject missing inputs with the canonical
 *     producer command instead of manual approval or warning success.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
);

export const behaviorMutationGovernanceRuleId =
    "application:behavior-mutation-governance";

const REQUIRED_RELEASE_BEHAVIORS = Object.freeze([
    "binary-api-aeds-contract",
    "authentication-session-permission",
    "configuration-error-security-policy",
    "article-comment-lifecycle-outbox",
]);

export const FORBIDDEN_CONFIG_FIELDS = Object.freeze([
    "globalScorePass",
    "allowGlobalScorePass",
    "scoreOnly",
    "manualOverride",
    "manualApproval",
    "allowManual",
    "allowlist",
    "allowedMutants",
    "ignoreMutants",
    "skipMutants",
    "historyReuse",
    "reuseHistory",
    "useMain",
    "useLatest",
    "latestEvidence",
    "warningSuccess",
    "warnOnFail",
    "forcePass",
    "fallbackToManual",
]);

const FORBIDDEN_TOOLING_PATTERNS = Object.freeze([
    /manualApproval/u,
    /manualOverride/u,
    /allowlist/u,
    /allowedMutants/u,
    /reuseHistory/u,
    /historyReceipt/u,
    /useMainEvidence/u,
    /warningSuccess/u,
    /--warn\b/u,
    /\|\|\s*(?:true|exit\s+0)\b/u,
]);

export function extractMatrixTierBlock(matrixYaml, tierId) {
    const marker = `- id: ${tierId}`;
    const start = matrixYaml.indexOf(marker);
    if (start < 0) {
        return null;
    }
    const remainder = matrixYaml.slice(start + marker.length);
    const nextTier = remainder.search(/\n\s{4}- id: /u);
    const blockEnd = nextTier < 0 ? remainder.length : nextTier;
    return matrixYaml.slice(start, start + marker.length + blockEnd);
}

function tierField(block, field) {
    const match = block.match(new RegExp(`^\\s{6}${field}:\\s*(.+)$`, "mu"));
    return match ? String(match[1]).trim() : null;
}

function walkJsonFiles(directory) {
    const files = [];
    if (!existsSync(directory)) {
        return files;
    }
    const stack = [directory];
    while (stack.length > 0) {
        const current = stack.pop();
        for (const entry of readdirSafe(current)) {
            const absolute = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(absolute);
                continue;
            }
            if (entry.isFile() && /\.json$/u.test(entry.name)) {
                files.push(absolute);
            }
        }
    }
    return files.sort((left, right) => left.localeCompare(right));
}

function readdirSafe(directory) {
    try {
        return readdirSync(directory, { withFileTypes: true });
    } catch {
        return [];
    }
}

export function collectForbiddenFields(
    value,
    label,
    violations,
    seen = new Set(),
) {
    if (Array.isArray(value)) {
        value.forEach((entry, index) =>
            collectForbiddenFields(
                entry,
                `${label}[${index}]`,
                violations,
                seen,
            ),
        );
        return;
    }
    if (value === null || typeof value !== "object") {
        return;
    }
    for (const [key, nested] of Object.entries(value)) {
        if (FORBIDDEN_CONFIG_FIELDS.includes(key)) {
            const message = `${label}.${key} is forbidden (global score pass / manual override / history reuse / allowlist / warning success)`;
            if (!seen.has(message)) {
                seen.add(message);
                violations.push(message);
            }
        }
        collectForbiddenFields(nested, `${label}.${key}`, violations, seen);
    }
}

function stripComments(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//gu, "")
        .replace(/^\s*\/\/.*$/gmu, "");
}

/**
 * Scan static governance violations for the required mutation path.
 *
 * @param {object} [options]
 * @param {string} [options.repositoryRoot]
 * @param {string} [options.matrixYaml] - Optional raw matrix.yml text (fixtures)
 * @param {string} [options.catalog] - Optional behavior catalog object (fixtures)
 * @returns {{ ok: boolean, violations: string[], checks: string[] }}
 */
export function scanBehaviorMutationGovernance({
    repositoryRoot = root,
    matrixYaml = null,
    catalog = null,
} = {}) {
    const violations = [];
    const checks = [];
    const matrix =
        matrixYaml ??
        readFileSync(path.join(repositoryRoot, "tests/matrix.yml"), "utf8");
    const tierId = "backend-mutation-changed-critical";
    const block = extractMatrixTierBlock(matrix, tierId);

    if (!block) {
        violations.push(`matrix tier ${tierId} is missing`);
    } else {
        checks.push(`matrix tier ${tierId} present`);
        const manualOnly = tierField(block, "manualOnly");
        if (manualOnly === "true") {
            violations.push(
                `matrix tier ${tierId} must not be manualOnly (required behaviors need automatic mutation qualification)`,
            );
        }
        const cadence = tierField(block, "cadence");
        if (cadence !== "pr") {
            violations.push(
                `matrix tier ${tierId} cadence must be pr (automatic), got ${cadence ?? "<missing>"}`,
            );
        }
        const requiredFor = tierField(block, "requiredFor");
        if (requiredFor !== "production") {
            violations.push(
                `matrix tier ${tierId} requiredFor must be production (release candidates run all required mutants), got ${requiredFor ?? "<missing>"}`,
            );
        }
        const nightlyOnly = tierField(block, "nightlyOnly");
        if (nightlyOnly === "true") {
            violations.push(`matrix tier ${tierId} must not be nightlyOnly`);
        }
    }

    const catalogValue =
        catalog ??
        JSON.parse(
            readFileSync(
                path.join(
                    repositoryRoot,
                    "config/contracts/behavior-contracts.json",
                ),
                "utf8",
            ),
        );
    const contracts = Array.isArray(catalogValue?.contracts)
        ? catalogValue.contracts
        : [];
    const required = contracts.filter(
        (contract) =>
            contract?.status === "active" &&
            contract?.mutationPolicy?.mutationRequired === true,
    );
    for (const behaviorId of REQUIRED_RELEASE_BEHAVIORS) {
        const contract = contracts.find((entry) => entry?.id === behaviorId);
        if (
            !contract ||
            contract.status !== "active" ||
            contract.mutationPolicy?.mutationRequired !== true
        ) {
            violations.push(
                `required release behavior ${behaviorId} must be active and mutationRequired in the BehaviorCatalog`,
            );
            continue;
        }
        const policy = contract.mutationPolicy;
        if (policy.requireExecutedMutants !== true) {
            violations.push(
                `${behaviorId} mutationPolicy.requireExecutedMutants must be true`,
            );
        }
        if (policy.allowedEquivalentMutantPolicy !== "documented") {
            violations.push(
                `${behaviorId} mutationPolicy.allowedEquivalentMutantPolicy must be documented`,
            );
        }
        if (!Number.isFinite(Number(policy.minimumMutationScore))) {
            violations.push(
                `${behaviorId} mutationPolicy.minimumMutationScore must be numeric`,
            );
        }
    }
    if (required.length < REQUIRED_RELEASE_BEHAVIORS.length) {
        violations.push(
            `only ${required.length} of ${REQUIRED_RELEASE_BEHAVIORS.length} required release behaviors are mutationRequired`,
        );
    }

    const mutationConfigRoot = path.join(
        repositoryRoot,
        "config/testing/mutation",
    );
    for (const file of walkJsonFiles(mutationConfigRoot)) {
        const relative = path
            .relative(repositoryRoot, file)
            .replaceAll("\\", "/");
        let parsed;
        try {
            parsed = JSON.parse(readFileSync(file, "utf8"));
        } catch (error) {
            violations.push(`${relative} is not valid JSON: ${error.message}`);
            continue;
        }
        collectForbiddenFields(parsed, relative, violations);
    }

    const lanePath = path.join(
        repositoryRoot,
        "tools/test/lanes/backend-mutation-changed-critical.sh",
    );
    if (!existsSync(lanePath)) {
        violations.push(
            "tools/test/lanes/backend-mutation-changed-critical.sh is missing",
        );
    } else {
        const lane = readFileSync(lanePath, "utf8");
        const requiredEnv = [
            "FSUSBLOG_CHANGED_CRITICAL_PATHS_FILE",
            "FSUSBLOG_TEST_SOURCE_COMMIT",
            "FSUSBLOG_TEST_SOURCE_FINGERPRINT",
            "FSUSBLOG_TEST_RUN_ID",
            "FSUSBLOG_BEHAVIOR_OWNER_RECEIPT",
            "FSUSBLOG_BEHAVIOR_TEST_BINDINGS",
            "FSUSBLOG_BEHAVIOR_TEST_EVIDENCE",
            "FSUSBLOG_TEST_PLAN",
        ];
        for (const env of requiredEnv) {
            if (!lane.includes(env)) {
                violations.push(
                    `lane is missing required input contract ${env}`,
                );
            }
        }
        if (!lane.includes("produce-behavior-mutation-qualification.mjs")) {
            violations.push(
                "lane must invoke the canonical per-behavior mutation qualification producer",
            );
        }
        if (
            /manualApproval|manualOverride|--warn\b|warning success|allowlist|reuseHistory/u.test(
                lane,
            )
        ) {
            violations.push(
                "lane must not fall back to manual approval, allowlist, history reuse or warning success",
            );
        }
    }

    const producerPath = path.join(
        repositoryRoot,
        "tools/test-matrix/produce-behavior-mutation-qualification.mjs",
    );
    const verifierPath = path.join(
        repositoryRoot,
        "tools/test-matrix/verify-behavior-mutation-qualification.mjs",
    );
    for (const [label, file] of [
        ["producer", producerPath],
        ["verifier", verifierPath],
    ]) {
        if (!existsSync(file)) {
            violations.push(
                `tools/test-matrix/...${label} is missing (${file})`,
            );
            continue;
        }
        const source = stripComments(readFileSync(file, "utf8"));
        for (const pattern of FORBIDDEN_TOOLING_PATTERNS) {
            if (pattern.test(source)) {
                violations.push(
                    `${label} must not contain forbidden fallback pattern ${pattern}`,
                );
            }
        }
        if (!source.includes("fsusblog.mutation-evidence-receipt.v1")) {
            violations.push(
                `${label} must seal the existing fsusblog.mutation-evidence-receipt.v1 schema`,
            );
        }
    }

    const governancePath = path.join(
        repositoryRoot,
        "tools/governance/check-behavior-mutation-governance.mjs",
    );
    if (!existsSync(governancePath)) {
        violations.push("static governance checker file is missing");
    }

    return {
        ok: violations.length === 0,
        violations: [...new Set(violations)].sort((left, right) =>
            left.localeCompare(right),
        ),
        checks: [...new Set(checks)].sort((left, right) =>
            left.localeCompare(right),
        ),
    };
}

if (
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
    const report = scanBehaviorMutationGovernance();
    if (!report.ok) {
        for (const violation of report.violations) {
            console.error(`[behavior-mutation-governance] ${violation}`);
        }
        console.error(
            `[behavior-mutation-governance] FAILED (${report.violations.length} violation(s))`,
        );
        process.exitCode = 1;
    } else {
        console.log(
            `[behavior-mutation-governance] ok (${report.checks.length} check(s))`,
        );
    }
}
