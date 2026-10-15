import type { DocumentExportCallFailure } from './documentExportCall';

/** Display-only registry projection; values must come from the canonical catalog. */
export interface DocumentExportFormatChoice {
    id: string;
    label: string;
    providerId: string;
    available: boolean;
    reason: string;
    layouts: readonly string[];
    themes: readonly string[];
    support: readonly string[];
}

export interface DocumentExportSourceChoice {
    id: string;
    label: string;
    private: boolean;
}

/** Ephemeral form values, not a job/input schema or persistence authority. */
export interface DocumentExportSelection {
    sourceId: string;
    formatId: string;
    layout: string;
    theme: string;
}

/**
 * Presentation facts derived from an actual canonical job/provider/storage
 * snapshot. Missing warnings/output metadata remain unavailable, never guessed.
 * Numeric status is DocumentExportTaskStatus from DocumentExportContracts.cs.
 */
export interface DocumentExportPresentation {
    taskId: string;
    version: number | string;
    status: number;
    source: string;
    format: string;
    provider: string;
    options: string;
    inputDigest: string;
    contentDigest: string;
    reason: string;
    warnings: readonly string[] | null;
    diagnostic: boolean;
    output: {
        filename: string | null;
        bytes: number | string;
        mediaType: string;
        expiresAt: string;
        deleted: boolean;
    } | null;
}

/**
 * Product composition port over the sole #2434 IDocumentExportJobs contract.
 * TSnapshot/TRequest are owned by the canonical adapter; this port neither
 * decodes wire bytes nor copies a job/input/receipt schema. Shared AEDS codecs,
 * authenticated context and frozen admission belong to the integration owner.
 * Download performs authorized delivery without exposing grants or URLs to UI.
 * Its adapter must honor the AbortSignal before saving bytes to the browser.
 * Uniform privacy-safe authorization denial is permission-revoked, clearing
 * all private cached metadata even when missing/expired cannot be distinguished.
 */
export interface DocumentExportUiPort<TSnapshot, TRequest> {
    catalog: readonly DocumentExportFormatChoice[];
    sources: readonly DocumentExportSourceChoice[];
    prepareRequest: (selection: Readonly<DocumentExportSelection>) => TRequest;
    captureRequest: (request: TRequest) => TRequest;
    request: (request: TRequest) => Promise<TSnapshot>;
    list: (offset: number, limit: number) => Promise<readonly TSnapshot[]>;
    status: (taskId: string) => Promise<TSnapshot>;
    cancel: (taskId: string) => Promise<TSnapshot>;
    retry: (taskId: string) => Promise<TSnapshot>;
    delete: (taskId: string) => Promise<TSnapshot>;
    download: (taskId: string, signal: AbortSignal) => Promise<void>;
    inspect: (snapshot: TSnapshot) => DocumentExportPresentation;
    classifyFailure: (error: unknown) => DocumentExportCallFailure;
}

/** Unknown status is deliberately non-actionable. Progress uses real stages. */
export function documentExportStatusLabel(status: number): string
{
    return new Map([
        [1, '排队中'], [2, '准备中'], [3, '正在导出'], [4, '正在取消'],
        [5, '已取消'], [6, '已完成'], [7, '失败'], [8, '已阻止'],
        [9, '已过期'], [10, '需要清理']
    ]).get(status) ?? '状态不可用';
}

export function documentExportCanDownload(view: DocumentExportPresentation, now: number): boolean
{
    const expiresAt = view.output ? Date.parse(view.output.expiresAt) : Number.NaN;
    return view.status === 6 && !view.diagnostic && view.output !== null
        && !view.output.deleted && Number.isFinite(expiresAt) && expiresAt > now;
}

/** Accept exact Int64 projections without rounding wire values through Number. */
function presentationInt64(value: number | string, minimum: bigint): bigint
{
    if (typeof value === 'number' ? !Number.isSafeInteger(value)
        : typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value))
    {
        throw new Error('document_export_presentation_int64');
    }
    const exact = BigInt(value);
    if (exact < minimum || exact > 9223372036854775807n)
    {
        throw new Error('document_export_presentation_int64');
    }
    return exact;
}

export function documentExportCompareVersions(left: number | string, right: number | string): number
{
    const a = presentationInt64(left, 1n);
    const b = presentationInt64(right, 1n);
    return a < b ? -1 : a > b ? 1 : 0;
}

export function documentExportValidatePresentation(view: DocumentExportPresentation): void
{
    presentationInt64(view.version, 1n);
    if (view.output !== null)
    {
        presentationInt64(view.output.bytes, 0n);
    }
}
