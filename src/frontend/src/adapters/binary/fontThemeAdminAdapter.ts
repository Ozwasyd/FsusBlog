import { AppErrorCode, createAppError } from '@/utils/appError';

const maxRegistryItems = 1024;
const maxFontFaces = 32;
const maxFontActivations = 256;
const maxThemeModes = 2;
const maxThemeActivations = 1024;
const maxThemeHistory = 50;
const maxBlobBytes = 7 * 1024 * 1024;
const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export type ThemeInstallState = 'Discovered' | 'Validated' | 'Installed' | 'Enabled'
    | 'Disabled' | 'Failed' | 'RolledBack' | 'Uninstalled';
export type ThemeActivationStatus = 'Applied' | 'Rejected' | 'RolledBack' | 'ResetToDefault';

export interface FontRegistryItem {
    fontId: string;
    name: string;
    family: string;
    category: string;
    version: string;
    installState: 'installed';
    enabled: boolean;
    builtIn: boolean;
    faceCount: number;
    criticalFaceCount: number;
    totalSizeBytes: string;
    installedAt: string;
    updatedAt: string;
}

export interface FontDetail extends FontRegistryItem {
    licenseText: string;
    licenseSourceJson: string;
    manifestJson: string;
    faces: FontFaceItem[];
}

export interface FontFaceItem {
    weight: number;
    style: string;
    filePath: string;
    contentHash: string;
    sizeBytes: string;
    unicodeRange: string | null;
    critical: boolean;
    fontDisplay: string;
}

export interface FontActivationItem {
    scope: string;
    uiFontId: string;
    proseFontId: string;
    codeFontId: string;
    cjkFontId: string;
    emojiFontId: string;
    configVersion: string;
    updatedAt: string;
}

export interface ThemeRegistryItem {
    themeId: string;
    name: string;
    version: string;
    author: string;
    description: string;
    type: string;
    installState: ThemeInstallState;
    enabled: boolean;
    packageHash: string;
    packageLocation: string;
    installedAtUtc: string;
    updatedAtUtc: string;
}

export interface ThemeSupport {
    public: boolean;
    admin: boolean;
    console: boolean;
    highContrast: boolean;
    reducedMotion: boolean;
    rtl: boolean;
}

/** Int64 byte budgets are exact decimal strings; selector and duration budgets are Int32. */
export interface ThemeBudget {
    cssBytes: string;
    assetBytes: string;
    maxSelectors: number;
    maxSelectorDepth: number;
    maxImportant: number;
    maxMotionDurationMs: number;
    previewBytes: string;
}

export interface ThemePermission {
    script: boolean;
    network: boolean;
    filesystem: boolean;
}

export interface ThemeDetail extends ThemeRegistryItem {
    manifestJson: string;
    configSchemaJson: string;
    modes: string[];
    supports: ThemeSupport;
    budgets: ThemeBudget;
    permissions: ThemePermission;
}

export interface ThemeActivationItem {
    scope: string;
    activeThemeId: string | null;
    mode: string | null;
    activationId: string | null;
    assetVersion: string | null;
    configVersion: string | null;
    updatedAtUtc: string | null;
}

export interface ThemeActivationHistoryItem {
    id: string;
    scope: string;
    themeId: string | null;
    previousThemeId: string | null;
    assetVersion: string | null;
    previousAssetVersion: string | null;
    configVersion: string | null;
    previousConfigVersion: string | null;
    mode: string | null;
    previousMode: string | null;
    status: ThemeActivationStatus;
    failureReason: string | null;
    startedAtUtc: string;
    completedAtUtc: string;
    activatedBy: string;
}

interface SliceRef {
    offset: number;
    length: number;
}

interface ParsedPayload {
    records: Uint8Array[];
    blob: Uint8Array;
}

class WireReader
{
    private readonly bytes: Uint8Array;
    private readonly view: DataView;
    private offset = 0;

    constructor(bytes: Uint8Array)
    {
        this.bytes = bytes;
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }

    remaining(): number
    {
        return this.bytes.byteLength - this.offset;
    }

    int32(): number
    {
        this.require(4);
        const value = this.view.getInt32(this.offset, true);
        this.offset += 4;
        return value;
    }

    span(length: number): Uint8Array
    {
        if (!Number.isSafeInteger(length) || length < 0)
        {
            fail('font_theme_length_invalid');
        }
        this.require(length);
        const result = this.bytes.subarray(this.offset, this.offset + length);
        this.offset += length;
        return result;
    }

    private require(length: number): void
    {
        if (length > this.remaining())
        {
            fail('font_theme_payload_truncated');
        }
    }
}

function fail(code: string): never
{
    throw createAppError(AppErrorCode.ProtocolFailure, code);
}

function dataView(bytes: Uint8Array): DataView
{
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function int32(bytes: Uint8Array, offset: number): number
{
    if (offset < 0 || offset + 4 > bytes.byteLength)
    {
        fail('font_theme_record_truncated');
    }
    return dataView(bytes).getInt32(offset, true);
}

function int64(bytes: Uint8Array, offset: number): bigint
{
    if (offset < 0 || offset + 8 > bytes.byteLength)
    {
        fail('font_theme_record_truncated');
    }
    return dataView(bytes).getBigInt64(offset, true);
}

function byte(bytes: Uint8Array, offset: number): number
{
    if (offset < 0 || offset >= bytes.byteLength)
    {
        fail('font_theme_record_truncated');
    }
    return bytes[offset] ?? fail('font_theme_record_truncated');
}

function booleanByte(bytes: Uint8Array, offset: number): boolean
{
    const value = byte(bytes, offset);
    if (value > 1)
    {
        fail('font_theme_boolean_invalid');
    }
    return value === 1;
}

function reservedZero(bytes: Uint8Array, offset: number, length: number): void
{
    for (let index = 0; index < length; index += 1)
    {
        if (byte(bytes, offset + index) !== 0)
        {
            fail('font_theme_reserved_nonzero');
        }
    }
}

function slice(bytes: Uint8Array, offset: number): SliceRef
{
    return { offset: int32(bytes, offset), length: int32(bytes, offset + 4) };
}

function parsePayload(payload: Uint8Array, recordSize: number, maximum: number): ParsedPayload
{
    const reader = new WireReader(payload);
    const version = reader.int32();
    const count = reader.int32();
    const bodyLength = reader.int32();
    const reserved = reader.int32();
    if (version !== 1 || reserved !== 0 || count < 0 || count > maximum || bodyLength !== reader.remaining())
    {
        fail('font_theme_envelope_invalid');
    }
    if (recordSize > 0 && count > Math.floor((reader.remaining() - 4) / recordSize))
    {
        fail('font_theme_record_count_invalid');
    }
    const records: Uint8Array[] = [];
    for (let index = 0; index < count; index += 1)
    {
        records.push(reader.span(recordSize));
    }
    const blobLength = reader.int32();
    if (blobLength < 0 || blobLength > maxBlobBytes || blobLength !== reader.remaining())
    {
        fail('font_theme_blob_length_invalid');
    }
    return { records, blob: reader.span(blobLength) };
}

function parseDetailPayload(payload: Uint8Array, childSize: number, detailSize: number, maximum: number): { detail: Uint8Array; children: Uint8Array[]; blob: Uint8Array; }
{
    const reader = new WireReader(payload);
    const version = reader.int32();
    const count = reader.int32();
    const bodyLength = reader.int32();
    const reserved = reader.int32();
    if (version !== 1 || reserved !== 0 || count < 0 || count > maximum || bodyLength !== reader.remaining())
    {
        fail('font_theme_envelope_invalid');
    }
    const detail = reader.span(detailSize);
    if (childSize > 0 && count > Math.floor((reader.remaining() - 4) / childSize))
    {
        fail('font_theme_record_count_invalid');
    }
    const children: Uint8Array[] = [];
    for (let index = 0; index < count; index += 1)
    {
        children.push(reader.span(childSize));
    }
    const blobLength = reader.int32();
    if (blobLength < 0 || blobLength > maxBlobBytes || blobLength !== reader.remaining())
    {
        fail('font_theme_blob_length_invalid');
    }
    return { detail, children, blob: reader.span(blobLength) };
}

class BlobCursor
{
    private readonly blob: Uint8Array;
    private offset = 0;

    constructor(blob: Uint8Array)
    {
        this.blob = blob;
    }

    text(reference: SliceRef, maximum: number, allowEmpty = false): string
    {
        if (reference.offset !== this.offset || reference.length < 0 || reference.length > maximum || reference.length > this.blob.byteLength - this.offset)
        {
            fail('font_theme_slice_invalid');
        }
        let value: string;
        try
        {
            value = textDecoder.decode(this.blob.subarray(this.offset, this.offset + reference.length));
        }
        catch
        {
            fail('font_theme_utf8_invalid');
        }
        this.offset += reference.length;
        if (!allowEmpty && value.length === 0)
        {
            fail('font_theme_required_text_empty');
        }
        return value;
    }

    optional(present: number, reference: SliceRef, maximum: number): string | null
    {
        if (present > 1)
        {
            fail('font_theme_presence_invalid');
        }
        if (present === 0)
        {
            if (reference.offset !== 0 || reference.length !== 0)
            {
                fail('font_theme_absent_slice_nonzero');
            }
            return null;
        }
        return this.text(reference, maximum, true);
    }

    finish(): void
    {
        if (this.offset !== this.blob.byteLength)
        {
            fail('font_theme_blob_trailing');
        }
    }
}

function isoDate(value: bigint): string
{
    if (value < -62135596800000n || value > 253402300799999n)
    {
        fail('font_theme_timestamp_invalid');
    }
    const date = new Date(Number(value));
    if (Number.isNaN(date.getTime()))
    {
        fail('font_theme_timestamp_invalid');
    }
    return date.toISOString();
}

function nonnegative(value: number, code = 'font_theme_numeric_invalid'): number
{
    if (value < 0)
    {
        fail(code);
    }
    return value;
}

function nonnegative64(value: bigint): string
{
    if (value < 0n)
    {
        fail('font_theme_numeric_invalid');
    }
    return value.toString(10);
}

function positive(value: number): number
{
    if (value <= 0)
    {
        fail('font_theme_numeric_invalid');
    }
    return value;
}

function fontInstallState(value: number): 'installed'
{
    if (value !== 1)
    {
        fail('font_install_state_invalid');
    }
    return 'installed';
}

const themeInstallStates: Record<number, ThemeInstallState> = {
    1: 'Discovered', 2: 'Validated', 3: 'Installed', 4: 'Enabled',
    5: 'Disabled', 6: 'Failed', 7: 'RolledBack', 8: 'Uninstalled'
};

const themeActivationStatuses: Record<number, ThemeActivationStatus> = {
    1: 'Applied', 2: 'Rejected', 3: 'RolledBack', 4: 'ResetToDefault'
};

function closedName<T extends string>(values: Record<number, T>, code: number, error: string): T
{
    return values[code] ?? fail(error);
}

function decodeFontSummary(record: Uint8Array, blob: BlobCursor): FontRegistryItem
{
    if (record.byteLength !== 76)
    {
        fail('font_registry_record_size_invalid');
    }
    reservedZero(record, 35, 1);
    const faceCount = nonnegative(int32(record, 24));
    const criticalFaceCount = nonnegative(int32(record, 28));
    if (faceCount > maxFontFaces || criticalFaceCount > faceCount)
    {
        fail('font_face_count_invalid');
    }
    return {
        fontId: blob.text(slice(record, 36), 256),
        name: blob.text(slice(record, 44), 4096),
        family: blob.text(slice(record, 52), 16 * 1024),
        category: blob.text(slice(record, 60), 256),
        version: blob.text(slice(record, 68), 256),
        installState: fontInstallState(byte(record, 34)),
        enabled: booleanByte(record, 32),
        builtIn: booleanByte(record, 33),
        faceCount,
        criticalFaceCount,
        totalSizeBytes: nonnegative64(int64(record, 16)),
        installedAt: isoDate(int64(record, 0)),
        updatedAt: isoDate(int64(record, 8))
    };
}

export function mapFontRegistryListFromPayload(payload: Uint8Array): FontRegistryItem[]
{
    const parsed = parsePayload(payload, 76, maxRegistryItems);
    const blob = new BlobCursor(parsed.blob);
    const result = parsed.records.map(record => decodeFontSummary(record, blob));
    blob.finish();
    return result;
}

export function mapFontRegistryDetailFromPayload(payload: Uint8Array): FontDetail
{
    const parsed = parseDetailPayload(payload, 56, 100, maxFontFaces);
    const blob = new BlobCursor(parsed.blob);
    const detail = parsed.detail;
    reservedZero(detail, 35, 1);
    const faceCount = nonnegative(int32(detail, 24));
    const criticalFaceCount = nonnegative(int32(detail, 28));
    if (faceCount !== parsed.children.length || criticalFaceCount > faceCount)
    {
        fail('font_face_count_invalid');
    }
    const result: FontDetail = {
        fontId: blob.text(slice(detail, 36), 256),
        name: blob.text(slice(detail, 44), 4096),
        family: blob.text(slice(detail, 52), 16 * 1024),
        category: blob.text(slice(detail, 60), 256),
        version: blob.text(slice(detail, 68), 256),
        licenseText: blob.text(slice(detail, 76), 2 * 1024 * 1024, true),
        licenseSourceJson: blob.text(slice(detail, 84), 2 * 1024 * 1024, true),
        manifestJson: blob.text(slice(detail, 92), 2 * 1024 * 1024, true),
        installState: fontInstallState(byte(detail, 34)),
        enabled: booleanByte(detail, 32),
        builtIn: booleanByte(detail, 33),
        faceCount,
        criticalFaceCount,
        totalSizeBytes: nonnegative64(int64(detail, 16)),
        installedAt: isoDate(int64(detail, 0)),
        updatedAt: isoDate(int64(detail, 8)),
        faces: []
    };
    result.faces = parsed.children.map((record): FontFaceItem =>
    {
        reservedZero(record, 14, 2);
        return {
            sizeBytes: nonnegative64(int64(record, 0)),
            weight: positive(int32(record, 8)),
            critical: booleanByte(record, 12),
            style: blob.text(slice(record, 16), 256),
            filePath: blob.text(slice(record, 24), 4096),
            contentHash: blob.text(slice(record, 32), 256),
            unicodeRange: blob.optional(byte(record, 13), slice(record, 40), 4096),
            fontDisplay: blob.text(slice(record, 48), 256)
        };
    });
    if (result.faces.filter(face => face.critical).length !== criticalFaceCount)
    {
        fail('font_critical_face_count_invalid');
    }
    blob.finish();
    return result;
}

export function mapFontActivationListFromPayload(payload: Uint8Array): FontActivationItem[]
{
    const parsed = parsePayload(payload, 64, maxFontActivations);
    const blob = new BlobCursor(parsed.blob);
    const result = parsed.records.map((record): FontActivationItem => ({
        configVersion: nonnegative64(int64(record, 0)),
        updatedAt: isoDate(int64(record, 8)),
        scope: blob.text(slice(record, 16), 256),
        uiFontId: blob.text(slice(record, 24), 256),
        proseFontId: blob.text(slice(record, 32), 256),
        codeFontId: blob.text(slice(record, 40), 256),
        cjkFontId: blob.text(slice(record, 48), 256),
        emojiFontId: blob.text(slice(record, 56), 256)
    }));
    blob.finish();
    return result;
}

function decodeThemeSummary(record: Uint8Array, blob: BlobCursor): ThemeRegistryItem
{
    if (record.byteLength !== 84)
    {
        fail('theme_registry_record_size_invalid');
    }
    reservedZero(record, 18, 2);
    return {
        themeId: blob.text(slice(record, 20), 256),
        name: blob.text(slice(record, 28), 4096),
        version: blob.text(slice(record, 36), 256),
        author: blob.text(slice(record, 44), 4096),
        description: blob.text(slice(record, 52), 4096, true),
        type: blob.text(slice(record, 60), 256),
        packageHash: blob.text(slice(record, 68), 256),
        packageLocation: blob.text(slice(record, 76), 4096),
        installState: closedName(themeInstallStates, byte(record, 17), 'theme_install_state_invalid'),
        enabled: booleanByte(record, 16),
        installedAtUtc: isoDate(int64(record, 0)),
        updatedAtUtc: isoDate(int64(record, 8))
    };
}

export function mapThemeRegistryListFromPayload(payload: Uint8Array): ThemeRegistryItem[]
{
    const parsed = parsePayload(payload, 84, maxRegistryItems);
    const blob = new BlobCursor(parsed.blob);
    const result = parsed.records.map(record => decodeThemeSummary(record, blob));
    blob.finish();
    return result;
}

export function mapThemeRegistryDetailFromPayload(payload: Uint8Array): ThemeDetail
{
    const parsed = parseDetailPayload(payload, 8, 148, maxThemeModes);
    const record = parsed.detail;
    const blob = new BlobCursor(parsed.blob);
    reservedZero(record, 67, 1);
    const flags = Array.from(record.subarray(58, 67));
    if (flags.some(value => value > 1))
    {
        fail('theme_detail_boolean_invalid');
    }
    const result: ThemeDetail = {
        themeId: blob.text(slice(record, 68), 256),
        name: blob.text(slice(record, 76), 4096),
        version: blob.text(slice(record, 84), 256),
        author: blob.text(slice(record, 92), 4096),
        description: blob.text(slice(record, 100), 4096, true),
        type: blob.text(slice(record, 108), 256),
        packageHash: blob.text(slice(record, 116), 256),
        packageLocation: blob.text(slice(record, 124), 4096),
        manifestJson: blob.text(slice(record, 132), 2 * 1024 * 1024, true),
        configSchemaJson: blob.text(slice(record, 140), 2 * 1024 * 1024, true),
        installState: closedName(themeInstallStates, byte(record, 57), 'theme_install_state_invalid'),
        enabled: booleanByte(record, 56),
        installedAtUtc: isoDate(int64(record, 0)),
        updatedAtUtc: isoDate(int64(record, 8)),
        modes: [],
        supports: {
            public: flags[0] === 1, admin: flags[1] === 1, console: flags[2] === 1,
            highContrast: flags[3] === 1, reducedMotion: flags[4] === 1, rtl: flags[5] === 1
        },
        budgets: {
            cssBytes: nonnegative64(int64(record, 16)), assetBytes: nonnegative64(int64(record, 24)),
            maxSelectors: nonnegative(int32(record, 40)), maxSelectorDepth: nonnegative(int32(record, 44)),
            maxImportant: nonnegative(int32(record, 48)), maxMotionDurationMs: nonnegative(int32(record, 52)),
            previewBytes: nonnegative64(int64(record, 32))
        },
        permissions: { script: flags[6] === 1, network: flags[7] === 1, filesystem: flags[8] === 1 }
    };
    result.modes = parsed.children.map(mode => blob.text(slice(mode, 0), 256));
    if (new Set(result.modes).size !== result.modes.length || result.modes.some(mode => mode !== 'light' && mode !== 'dark'))
    {
        fail('theme_modes_invalid');
    }
    blob.finish();
    return result;
}

function decodeThemeActivationRecord(record: Uint8Array, blob: BlobCursor): ThemeActivationItem
{
    if (record.byteLength !== 64)
    {
        fail('theme_activation_record_size_invalid');
    }
    reservedZero(record, 22, 2);
    const hasConfig = byte(record, 20);
    const hasUpdated = byte(record, 21);
    const configVersion = int64(record, 0);
    const updatedAt = int64(record, 8);
    if (hasConfig > 1 || hasUpdated > 1 || (hasConfig === 0 && configVersion !== 0n) || (hasUpdated === 0 && updatedAt !== 0n))
    {
        fail('theme_activation_nullable_scalar_invalid');
    }
    return {
        scope: blob.text(slice(record, 24), 256),
        activeThemeId: blob.optional(byte(record, 16), slice(record, 32), 256),
        mode: blob.optional(byte(record, 17), slice(record, 40), 256),
        activationId: validateGuid(blob.optional(byte(record, 18), slice(record, 48), 256)),
        assetVersion: blob.optional(byte(record, 19), slice(record, 56), 256),
        configVersion: hasConfig === 1 ? nonnegative64(configVersion) : null,
        updatedAtUtc: hasUpdated === 1 ? isoDate(updatedAt) : null
    };
}

export function mapThemeActivationListFromPayload(payload: Uint8Array): ThemeActivationItem[]
{
    const parsed = parsePayload(payload, 64, maxThemeActivations);
    const blob = new BlobCursor(parsed.blob);
    const result = parsed.records.map(record => decodeThemeActivationRecord(record, blob));
    blob.finish();
    return result;
}

export function mapThemeActivationFromPayload(payload: Uint8Array): ThemeActivationItem
{
    const parsed = parsePayload(payload, 64, 1);
    if (parsed.records.length !== 1)
    {
        fail('theme_activation_singleton_invalid');
    }
    const blob = new BlobCursor(parsed.blob);
    const result = decodeThemeActivationRecord(parsed.records[0] ?? fail('theme_activation_singleton_invalid'), blob);
    blob.finish();
    return result;
}

function validateGuid(value: string | null): string | null
{
    if (value !== null && (value.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)))
    {
        fail('theme_activation_guid_invalid');
    }
    return value;
}

export function mapThemeActivationHistoryFromPayload(payload: Uint8Array): ThemeActivationHistoryItem[]
{
    const parsed = parsePayload(payload, 124, maxThemeHistory);
    const blob = new BlobCursor(parsed.blob);
    const result = parsed.records.map((record): ThemeActivationHistoryItem =>
    {
        reservedZero(record, 42, 2);
        const hasConfig = byte(record, 36);
        const hasPreviousConfig = byte(record, 37);
        const configVersion = int64(record, 0);
        const previousConfigVersion = int64(record, 8);
        if (hasConfig > 1 || hasPreviousConfig > 1 || (hasConfig === 0 && configVersion !== 0n) || (hasPreviousConfig === 0 && previousConfigVersion !== 0n))
        {
            fail('theme_history_nullable_scalar_invalid');
        }
        return {
            id: validateGuid(blob.text(slice(record, 44), 256)) ?? fail('theme_history_id_invalid'),
            scope: blob.text(slice(record, 52), 256),
            themeId: blob.optional(byte(record, 32), slice(record, 60), 256),
            previousThemeId: blob.optional(byte(record, 33), slice(record, 68), 256),
            assetVersion: blob.optional(byte(record, 34), slice(record, 76), 256),
            previousAssetVersion: blob.optional(byte(record, 35), slice(record, 84), 256),
            configVersion: hasConfig === 1 ? nonnegative64(configVersion) : null,
            previousConfigVersion: hasPreviousConfig === 1 ? nonnegative64(previousConfigVersion) : null,
            mode: blob.optional(byte(record, 38), slice(record, 92), 256),
            previousMode: blob.optional(byte(record, 39), slice(record, 100), 256),
            status: closedName(themeActivationStatuses, byte(record, 41), 'theme_activation_status_invalid'),
            failureReason: blob.optional(byte(record, 40), slice(record, 108), 4096),
            startedAtUtc: isoDate(int64(record, 16)),
            completedAtUtc: isoDate(int64(record, 24)),
            activatedBy: blob.text(slice(record, 116), 1024)
        };
    });
    blob.finish();
    return result;
}
