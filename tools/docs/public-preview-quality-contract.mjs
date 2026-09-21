import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { qualitySidecarFile, stableJson } from '../release/public-preview-quality-receipt-contract.mjs';
export { publicPreviewQualityReportSchema, publicPreviewQualityMatrixSchema, stableJson, finiteNumber, qualitySidecarFile, validatePublicPreviewQualityReport, createPublicPreviewQualityMatrix, validatePublicPreviewQualityMatrix } from '../release/public-preview-quality-receipt-contract.mjs';

export async function writePublicPreviewQualitySidecar(directory, screenshotFile, report)
{
    const file = qualitySidecarFile(directory, screenshotFile);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, stableJson(report), 'utf8');
    return file;
}

export async function writePublicPreviewQualityMatrix(directory, matrix)
{
    const file = path.join(directory, 'quality-matrix.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, stableJson(matrix), 'utf8');
    return file;
}
