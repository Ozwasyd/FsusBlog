import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const correctnessTimeoutPhases = Object.freeze(['preparation', 'measurement', 'post-measurement', 'termination', 'scheduler', 'global']);
export const correctnessBudgetPolicyFile = path.join(root, 'config/testing/correctness-budget-policy.json');
function canonicalize(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonicalize);
    }
    if (value && typeof value === 'object')
    {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
    }
    return value;
}
export function canonicalBudgetPolicy(value)
{
    return JSON.stringify(canonicalize(value));
}
export function correctnessBudgetPolicyDigest(policy)
{
    return `sha256:${createHash('sha256').update(canonicalBudgetPolicy(policy)).digest('hex')}`;
}
export function loadCorrectnessBudgetPolicy(file = correctnessBudgetPolicyFile)
{
    // The authoritative checkout must always supply this policy. A missing source
    // is represented explicitly so matrix validation fails closed instead of
    // silently treating a correctness producer as unbounded.
    if (!fs.existsSync(file))
    {
        return { missing: true };
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}
export function validateCorrectnessBudgetPolicy(policy, matrix)
{
    const errors = [];
    if (policy?.missing === true)
    {
        return ['correctness budget policy source is missing'];
    }
    if (policy?.schema !== 'fsusblog.correctness-budget-policy.v1' || !Array.isArray(policy?.policies))
    {
        return ['correctness budget policy schema or policies is invalid'];
    }
    const maximumTierSchedulerBudgetMs = Number(policy.maximumTierSchedulerBudgetMs);
    if (!Number.isFinite(maximumTierSchedulerBudgetMs) || maximumTierSchedulerBudgetMs <= 0)
    {
        errors.push('maximumTierSchedulerBudgetMs must be positive');
    }
    const seen = new Set();
    const matrixById = new Map((matrix?.tiers ?? []).map((tier) => [tier.id, tier]));
    for (const entry of policy.policies)
    {
        const label = entry?.tierId ?? 'unknown';
        if (!entry?.tierId || seen.has(entry.tierId))
        {
            errors.push(`${label}: tierId must be unique`);
        } seen.add(entry?.tierId);
        const tier = matrixById.get(entry?.tierId);
        if (!tier)
        {
            errors.push(`${label}: policy tier is absent from matrix`);
            continue;
        }
        if (tier.command !== entry.producer && !String(tier.command).endsWith(entry.producer))
        {
            errors.push(`${label}: producer must match matrix command`);
        }
        const numeric = ['preparationUpperBoundMs', 'postMeasurementUpperBoundMs', 'terminationGraceMs', 'producerExecutionBudgetMs', 'tierSchedulerBudgetMs', 'profileGlobalBudgetMs'];
        for (const field of numeric)
        {
            if (!Number.isFinite(entry[field]) || entry[field] <= 0)
            {
                errors.push(`${label}: ${field} must be positive`);
            }
        }
        const measurement = entry.measurementWindowMs;
        const isNa = measurement === 'not-applicable';
        if (isNa ? !entry.notApplicableReason : !Number.isFinite(measurement) || measurement <= 0)
        {
            errors.push(`${label}: measurementWindowMs requires a positive value or not-applicable reason`);
        }
        if (tier.commandKind === 'finalizer' && !isNa)
        {
            errors.push(`${label}: finalizer-only tier must not inherit a producer measurement window`);
        }
        const required = isNa ? correctnessTimeoutPhases.filter((phase) => phase !== 'measurement') : correctnessTimeoutPhases;
        if (!Array.isArray(entry.timeoutPhases) || required.some((phase) => !entry.timeoutPhases.includes(phase))
      || entry.timeoutPhases.some((phase) => !correctnessTimeoutPhases.includes(phase)))
        {
            errors.push(`${label}: timeout phase coverage is incomplete`);
        }
        if (!correctnessTimeoutPhases.includes(entry.producerTimeoutPhase)
      || !entry.timeoutPhases.includes(entry.producerTimeoutPhase))
        {
            errors.push(`${label}: producerTimeoutPhase must be a declared timeout phase`);
        }
        if (entry.observeOnly === true && (!Number.isFinite(entry.hardSafetyBudgetMs) || entry.hardSafetyBudgetMs <= 0))
        {
            errors.push(`${label}: observe-only requires hardSafetyBudgetMs`);
        }
        const measured = isNa ? 0 : measurement;
        if (!isNa && (!Number.isFinite(entry.minimumMeasurementWindowMs) || entry.minimumMeasurementWindowMs <= 0 || measurement < entry.minimumMeasurementWindowMs))
        {
            errors.push(`${label}: measurementWindowMs must retain its minimum declared window`);
        }
        if (measured + entry.preparationUpperBoundMs + entry.postMeasurementUpperBoundMs + entry.terminationGraceMs > entry.producerExecutionBudgetMs)
        {
            errors.push(`${label}: producer execution budget does not cover all phases and termination grace`);
        }
        if (!(entry.producerExecutionBudgetMs <= entry.tierSchedulerBudgetMs && entry.tierSchedulerBudgetMs <= entry.profileGlobalBudgetMs))
        {
            errors.push(`${label}: budget hierarchy is inverted`);
        }
        if (entry.tierSchedulerBudgetMs !== tier.timeoutMinutes * 60_000)
        {
            errors.push(`${label}: matrix timeoutMinutes disagrees with policy`);
        }
        if (entry.tierSchedulerBudgetMs > maximumTierSchedulerBudgetMs)
        {
            errors.push(`${label}: tier scheduler budget exceeds policy maximum`);
        }
        if (entry.observeOnly === true && entry.hardSafetyBudgetMs > entry.tierSchedulerBudgetMs)
        {
            errors.push(`${label}: hard safety budget exceeds tier scheduler budget`);
        }
    }
    const policyProducers = new Set(policy.policies.map((entry) => entry.producer));
    for (const tier of matrix?.tiers ?? [])
    {
        if (!policyProducers.has(String(tier.command).split(/\s+/u).at(-1)))
        {
            continue;
        }
        if (!seen.has(tier.id))
        {
            errors.push(`${tier.id}: matrix producer is absent from correctness budget policy`);
        }
    }
    return errors;
}
export function applyCorrectnessBudgetPolicy(tiers, policy)
{
    const byTierId = new Map((policy?.policies ?? []).map((entry) => [entry.tierId, entry]));
    return tiers.map((tier) =>
    {
        const budget = byTierId.get(tier.id);
        if (!budget)
        {
            return tier;
        }
        return {
            ...tier,
            budgetMs: budget.tierSchedulerBudgetMs,
            producerExecutionBudgetMs: budget.producerExecutionBudgetMs,
            terminationGraceMs: budget.terminationGraceMs,
            producerTimeoutPhase: budget.producerTimeoutPhase,
            correctnessBudget: budget
        };
    });
}
export function bindBudgetPolicy(identity = {}, receipt = {}, policy)
{
    const budgetPolicyDigest = correctnessBudgetPolicyDigest(policy);
    return { identity: { ...identity, budgetPolicyDigest }, receipt: { ...receipt, budgetPolicyDigest } };
}
