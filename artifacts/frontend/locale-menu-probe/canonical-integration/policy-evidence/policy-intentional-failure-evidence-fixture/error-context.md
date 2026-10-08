# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: policy.spec.ts >> intentional failure evidence fixture
- Location: .tmp/issue-830-policy-probe/policy.spec.ts:6:5

# Error details

```
Error: expect(locator).toHaveText(expected) failed

Locator:  getByRole('button')
Expected: "intentional failure"
Received: "actual fixture"
Timeout:  50ms

Call log:
  - Expect "toHaveText" with timeout 50ms
  - waiting for getByRole('button')
    2 × locator resolved to <button>actual fixture</button>
      - unexpected value "actual fixture"

```

# Page snapshot

```yaml
- button "actual fixture" [ref=e2]
```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test'
  2  | test('successful evidence fixture', async ({ page }) => {
  3  |   await page.setContent('<button>actual fixture</button>')
  4  |   await expect(page.getByRole('button')).toHaveText('actual fixture')
  5  | })
  6  | test('intentional failure evidence fixture', async ({ page }) => {
  7  |   await page.setContent('<button>actual fixture</button>')
> 8  |   await expect(page.getByRole('button')).toHaveText('intentional failure', { timeout: 50 })
     |                                          ^ Error: expect(locator).toHaveText(expected) failed
  9  | })
  10 | 
```