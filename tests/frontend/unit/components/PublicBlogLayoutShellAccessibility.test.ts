import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const shellSource = readFileSync(
  resolve(process.cwd(), 'src/components/public/PublicBlogLayoutShell.vue'),
  'utf8',
)
const foundationCss = readFileSync(
  resolve(process.cwd(), 'src/assets/public-shell-foundation.css'),
  'utf8',
)

describe('PublicBlogLayoutShell accessibility', () => {
  it('keeps the skip link first and points it at the focusable main target', () => {
    const template = shellSource.match(/<template>(?<body>[\s\S]*?)<\/template>/u)?.groups?.body ?? ''
    const skipLinkIndex = template.indexOf('href="#main-content"')
    const nextFocusableIndex = template.search(/<(?:a|button|input|select|textarea)\b/u)

    expect(skipLinkIndex).toBeGreaterThanOrEqual(0)
    expect(template.lastIndexOf('<a', skipLinkIndex)).toBe(nextFocusableIndex)
    expect(shellSource).toMatch(/id="main-content"[\s\S]*?tabindex="-1"/u)
  })

  it('places the focused skip link eight pixels below measured header geometry', () => {
    expect(shellSource).toContain('class="fsusblog-public-skip-link sr-only')
    expect(shellSource).not.toContain('focus:top-4')
    expect(foundationCss).toMatch(
      /#fsus-aot-shell \.fsusblog-public-skip-link:focus\s*\{\s*top: calc\(var\(--fsusblog-public-header-height-current\) \+ 8px\);\s*\}/u,
    )
  })
})
