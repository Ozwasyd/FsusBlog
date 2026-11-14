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
