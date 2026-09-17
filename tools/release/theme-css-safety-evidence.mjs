import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const THEME_CSS_SAFETY_SCHEMA = 'fsusblog.theme.css-safety.v1';

const LIMITS = Object.freeze({
    cssBytes: 64 * 1024,
    assetBytes: 512 * 1024,
    previewBytes: 256 * 1024,
    selectorCount: 512,
    maxSelectorDepth: 4,
    importantCount: 8,
    maxMotionDurationMs: 1_000
});

export function validateThemeCssSafetyEvidence(summary)
{
    const errors = [];
    if (!summary || typeof summary !== 'object' || Array.isArray(summary))
    {
        return ['theme CSS safety evidence must be an object'];
    }
    if (summary.schema !== THEME_CSS_SAFETY_SCHEMA)
    {
        errors.push(`schema must be ${THEME_CSS_SAFETY_SCHEMA}`);
    }
    if (!/^fsusblog\.theme\.[a-z0-9](?:[a-z0-9.-]{0,94}[a-z0-9])?$/u.test(String(summary.themeId ?? '')))
    {
        errors.push('themeId must use the fsusblog.theme.* namespace');
    }
    if (summary.status !== 'ok')
    {
        errors.push(`status must be ok, got ${String(summary.status)}`);
    }
    for (const [field, maximum] of Object.entries(LIMITS))
    {
        const value = summary[field];
        if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
        {
            errors.push(`${field} must be an integer between 0 and ${maximum}`);
        }
    }
    if (!Array.isArray(summary.violations) || summary.violations.length !== 0)
    {
        errors.push('violations must be an empty array');
    }
    if (!Array.isArray(summary.warnings)
        || summary.warnings.some((warning) => typeof warning !== 'string'))
    {
        errors.push('warnings must be an array of strings');
    }
    return errors;
}

export function readAndValidateThemeCssSafetyEvidence(file)
{
    const resolved = path.resolve(file);
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink())
    {
        throw new Error('theme CSS safety evidence must be a regular non-symlink file');
    }
    const summary = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    const errors = validateThemeCssSafetyEvidence(summary);
    if (errors.length > 0)
    {
        throw new Error(errors.join('; '));
    }
    return summary;
}

if (process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)))
{
    const file = process.argv[2]
        ?? path.resolve('.tmp/release-evidence/theme-css-safety-summary.json');
    try
    {
        const summary = readAndValidateThemeCssSafetyEvidence(file);
        console.log(`[theme-css-safety] ok theme=${summary.themeId} file=${file}`);
    }
    catch (error)
    {
        console.error(`[theme-css-safety] ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}
