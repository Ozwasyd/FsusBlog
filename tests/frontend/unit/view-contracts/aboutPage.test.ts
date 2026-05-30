import { describe, it, expect } from 'vitest'
import { createAboutPageViewContract } from '@/view-contracts/aboutPage'

describe('createAboutPageViewContract', () => {
  it('creates the correct view contract structure', () => {
    const contract = createAboutPageViewContract({
      siteTitle: "Fsu's Blog",
      currentYear: 2025,
      content: 'About content'
    })

    expect(contract.header.title).toBe('关于')
    expect(contract.header.currentYear).toBe(2025)
    expect(contract.header.manifestoLabel).toBe('MANIFESTO')
    expect(contract.header.readmeLabel).toBe('README.MD')
    expect(contract.body.content).toBe('About content')
    expect(contract.footer.siteTitle).toBe("Fsu's Blog")
  })

  it('passes currentYear through correctly', () => {
    const contract = createAboutPageViewContract({
      siteTitle: 'Blog',
      currentYear: 2024,
      content: ''
    })
    expect(contract.header.currentYear).toBe(2024)
  })

  it('passes empty content', () => {
    const contract = createAboutPageViewContract({
      siteTitle: 'Blog',
      currentYear: 2025,
      content: ''
    })
    expect(contract.body.content).toBe('')
  })
})
