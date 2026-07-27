const CODE_FONT_WEIGHTS = Object.freeze([400, 500, 700] as const);
let codeStylePromise: Promise<unknown> | null = null;

export async function prepareCodeFonts(): Promise<void>
{
    codeStylePromise ??= import('@/assets/fonts/code.css').catch((error: unknown) =>
    {
        codeStylePromise = null;
        throw error;
    });
    await codeStylePromise;

    if (typeof document === 'undefined' || !document.fonts)
    {
        throw new Error('code_font_face_set_unavailable');
    }
    await Promise.all(CODE_FONT_WEIGHTS.map(async (weight) =>
    {
        const query = `${weight} 1em "JetBrains Mono"`;
        const faces = await document.fonts.load(query, 'const value = 1540');
        if (faces.length === 0 || !document.fonts.check(query, 'const value = 1540'))
        {
            throw new Error(`code_font_face_unavailable:${weight}`);
        }
    }));
}
