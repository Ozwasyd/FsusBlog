/**
 * Screenshot registry projection preserves its named viewport; quality scenarios use numeric dimensions.
 * @typedef {Omit<import('./public-preview-quality.mjs').PublicPreviewQualityScenario, 'viewport'> & {
 *   file: string; viewport: string; qualityViewport: { width: number; height: number; };
 * }} PublicPreviewScreenshotEntry
 * @typedef {{
 *   schema: string; screenshots: PublicPreviewScreenshotEntry[];
 *   qualityPolicy: import('./public-preview-quality.mjs').PublicPreviewQualityPolicy;
 *   qualityScenarios: import('./public-preview-quality.mjs').PublicPreviewQualityScenario[];
 *   visualInputs: Record<string, unknown[]>;
 *   capturePolicy?: Record<string, string | boolean>;
 *   failClosedRoots?: { path: string; excludedEntries: string[]; }[];
 *   qualityPolicyFile?: string; qualityScenarioFiles?: string[];
 * }} PublicPreviewRegistry
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { projectPublicPreviewQualityRegistry } from '../release/public-preview-quality-receipt-contract.mjs';

function readJson(file)
{
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * @param {string | URL} rootDirectory
 * @returns {PublicPreviewRegistry}
 */
export function loadPublicPreviewRegistry(rootDirectory)
{
    const root = rootDirectory instanceof URL ? fileURLToPath(rootDirectory) : path.resolve(rootDirectory);
    const registry = readJson(path.join(root, 'config/docs/public-preview-screenshots.json'));
    const policy = readJson(path.join(root, String(registry.qualityPolicyFile ?? '')));
    const scenarioDocuments = (registry.qualityScenarioFiles ?? []).map((file) => readJson(path.join(root, String(file))));
    return projectPublicPreviewQualityRegistry(registry, policy, scenarioDocuments);
}
