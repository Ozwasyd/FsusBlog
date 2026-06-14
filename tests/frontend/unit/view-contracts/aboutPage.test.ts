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
    expect(contract.header.manifestoLabel).toBe('站点说明')
    expect(contract.header.readmeLabel).toBe('持续更新')
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

  it('allows static pages to override the title', () => {
    const contract = createAboutPageViewContract({
      siteTitle: 'Blog',
      currentYear: 2026,
      content: '',
      title: '隐私政策'
    })
    expect(contract.header.title).toBe('隐私政策')
    expect(contract.header.manifestoLabel).toBe('隐私说明')
    expect(contract.header.readmeLabel).toBe('访问边界')
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
