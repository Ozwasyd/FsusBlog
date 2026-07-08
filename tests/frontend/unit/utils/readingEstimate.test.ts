import { describe, expect, it } from 'vitest'
import {
  LONG_READ_THRESHOLD,
  countEffectiveReadingChars,
  estimateReading
} from '@/utils/readingEstimate'

describe('readingEstimate', () => {
  it('uses content-aware reading speeds', () => {
    expect(estimateReading('').minutes).toBe(1)
    expect(estimateReading('字'.repeat(420)).minutes).toBe(1)
    expect(estimateReading('字'.repeat(421)).minutes).toBe(2)
    expect(estimateReading(`${'word '.repeat(240)}`).minutes).toBe(1)
    expect(estimateReading(`${'word '.repeat(241)}`).minutes).toBe(2)
  })

  it('ignores whitespace when counting readable content', () => {
    expect(countEffectiveReadingChars(' A \n B \t C ')).toBe(3)
    expect(estimateReading(`${'字'.repeat(210)}\n\n${'字'.repeat(210)}`).minutes).toBe(1)
  })

  it('accounts for code and images separately from prose', () => {
    const codeEstimate = estimateReading(`\`\`\`ts\n${'x'.repeat(141)}\n\`\`\``)
    expect(codeEstimate.codeChars).toBe(141)
    expect(codeEstimate.minutes).toBe(2)

    const imageEstimate = estimateReading('![a](/a.png)\n'.repeat(6))
    expect(imageEstimate.imageCount).toBe(6)
    expect(imageEstimate.minutes).toBe(2)

    const tableEstimate = estimateReading(`| 列 | 值 |\n| --- | --- |\n| ${'单元格'.repeat(80)} | 值 |`)
    expect(tableEstimate.tableChars).toBeGreaterThan(220)
    expect(tableEstimate.minutes).toBeGreaterThan(1)
  })

  it('matches the long-read notice threshold', () => {
    expect(estimateReading('字'.repeat(LONG_READ_THRESHOLD)).showLongReadNotice).toBe(false)
    expect(estimateReading('字'.repeat(LONG_READ_THRESHOLD + 1)).showLongReadNotice).toBe(true)
  })
})
