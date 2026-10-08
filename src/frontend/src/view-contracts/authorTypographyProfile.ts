/** Client preflight mirror of Shared AuthorTypographyCatalog IDs, checked against that source.
 * No CSS values, font assets, baseline default, persistence or server authority live here. */
export const AUTHOR_TYPOGRAPHY_CHOICES = Object.freeze({
    fontFamily: Object.freeze(['system-sans', 'reading-serif', 'cjk-sans'] as const),
    fontSize: Object.freeze(['compact', 'standard', 'large'] as const),
    lineHeight: Object.freeze(['compact', 'standard', 'relaxed'] as const),
    canvasWidth: Object.freeze(['narrow', 'standard', 'wide'] as const),
    paragraphSpacing: Object.freeze(['compact', 'standard', 'relaxed'] as const)
});

export type AuthorTypographyDimension = keyof typeof AUTHOR_TYPOGRAPHY_CHOICES;
export type AuthorTypographyProfileView = Readonly<{ schemaVersion: 1; } & {
    [Dimension in AuthorTypographyDimension]: typeof AUTHOR_TYPOGRAPHY_CHOICES[Dimension][number];
}>;

export const AUTHOR_TYPOGRAPHY_FIELDS = Object.freeze([
    'fontFamily', 'fontSize', 'lineHeight', 'canvasWidth', 'paragraphSpacing'
] as const);

export function isAuthorTypographyChoice(dimension: AuthorTypographyDimension, value: unknown): value is string
{
    const choices: readonly string[] = AUTHOR_TYPOGRAPHY_CHOICES[dimension];
    return typeof value === 'string' && choices.includes(value);
}

export function isAuthorTypographyProfileView(value: unknown): value is AuthorTypographyProfileView
{
    if (typeof value !== 'object' || value === null || Array.isArray(value))
    {
        return false;
    }
    const fields = value as Record<string, unknown>;
    const keys = Reflect.ownKeys(fields);
    return keys.length === AUTHOR_TYPOGRAPHY_FIELDS.length + 1
        && keys.every(key => key === 'schemaVersion' || AUTHOR_TYPOGRAPHY_FIELDS.some(field => field === key))
        && fields.schemaVersion === 1
        && AUTHOR_TYPOGRAPHY_FIELDS.every(dimension => isAuthorTypographyChoice(dimension, fields[dimension]));
}
