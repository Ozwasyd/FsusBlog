export type PublicContentTone = 'neutral' | 'error';

const metadataSeparatorClass = 'font-normal text-[var(--fsusblog-text-decorative)]';

export const publicPeriodMotif = {
    metadata: {
        glyph: '·',
        className: metadataSeparatorClass
    },
    loading: {
        className: 'fsusblog-dot-loader'
    },
    contentState: {
        showsForTone: (tone: PublicContentTone): boolean => tone === 'neutral'
    }
} as const;
