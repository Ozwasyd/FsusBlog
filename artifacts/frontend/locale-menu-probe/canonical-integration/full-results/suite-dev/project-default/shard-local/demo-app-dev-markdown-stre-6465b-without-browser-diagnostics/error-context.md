# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: demo-app-dev.spec.ts >> markdown stress route renders long raw HTML without browser diagnostics
- Location: vue/tests/demo-app-dev/demo-app-dev.spec.ts:429:5

# Error details

```
Error: expect(locator).toHaveText(expected) failed

Locator:  locator('[data-testid="markdown-stress-status"]')
Expected: "complete"
Received: "rendering"
Timeout:  30000ms

Call log:
  - Expect "toHaveText" with timeout 30000ms
  - waiting for locator('[data-testid="markdown-stress-status"]')
    3 × locator resolved to <strong data-testid="markdown-stress-status">rendering</strong>
      - unexpected value "rendering"

```

# Test source

```ts
  347 |       Math.abs(
  348 |         titleRect.top +
  349 |           titleRect.height / 2 -
  350 |           (buttonRect.top + buttonRect.height / 2),
  351 |       ) <
  352 |       Math.max(titleRect.height, buttonRect.height) / 2
  353 | 
  354 |     return {
  355 |       buttonRightOverflow: buttonRect.right - cardRect.right,
  356 |       horizontalGap: buttonRect.left - titleRect.right,
  357 |       sameRow,
  358 |       titleLeftOverflow: cardRect.left - titleRect.left,
  359 |       verticalGap: buttonRect.top - titleRect.bottom,
  360 |     }
  361 |   })
  362 | 
  363 |   expect(metrics.titleLeftOverflow).toBeLessThanOrEqual(1)
  364 |   expect(metrics.buttonRightOverflow).toBeLessThanOrEqual(1)
  365 |   if (metrics.sameRow) {
  366 |     expect(metrics.horizontalGap).toBeGreaterThanOrEqual(8)
  367 |   } else {
  368 |     expect(metrics.verticalGap).toBeGreaterThanOrEqual(8)
  369 |   }
  370 | })
  371 | 
  372 | test('Calendar header controls use soft segmented styling', async ({
  373 |   page,
  374 | }) => {
  375 |   await page.goto('/?visual=data&theme=light', {
  376 |     waitUntil: 'domcontentloaded',
  377 |   })
  378 | 
  379 |   const buttonGroup = page.locator('.el-calendar__button-group').first()
  380 |   await expect(buttonGroup).toBeVisible()
  381 | 
  382 |   const metrics = await buttonGroup.evaluate((group) => {
  383 |     const shell = group.querySelector<HTMLElement>('.el-button-group')
  384 |     const buttons = Array.from(
  385 |       group.querySelectorAll<HTMLElement>('.el-button'),
  386 |     )
  387 | 
  388 |     if (!shell || buttons.length !== 3) {
  389 |       throw new Error('Calendar header button group is missing')
  390 |     }
  391 | 
  392 |     const shellStyle = getComputedStyle(shell)
  393 | 
  394 |     return {
  395 |       buttonBorders: buttons.map(
  396 |         (button) => getComputedStyle(button).borderLeftWidth,
  397 |       ),
  398 |       buttonMargins: buttons.map(
  399 |         (button) => getComputedStyle(button).marginLeft,
  400 |       ),
  401 |       buttonRadii: buttons.map(
  402 |         (button) => getComputedStyle(button).borderRadius,
  403 |       ),
  404 |       shellDisplay: shellStyle.display,
  405 |       shellGap: shellStyle.gap,
  406 |       shellRadius: shellStyle.borderRadius,
  407 |     }
  408 |   })
  409 | 
  410 |   expect(metrics.shellDisplay).toBe('inline-flex')
  411 |   expect(metrics.shellGap).toBe('8px')
  412 |   expect(metrics.shellRadius).toBe('6px')
  413 |   expect(metrics.buttonBorders).toEqual(['0px', '0px', '0px'])
  414 |   expect(metrics.buttonMargins).toEqual(['0px', '0px', '0px'])
  415 |   expect(metrics.buttonRadii).toEqual(['4px', '4px', '4px'])
  416 | })
  417 | 
  418 | test('Calendar title follows the browser locale in demo app', async ({
  419 |   page,
  420 | }) => {
  421 |   await page.goto('/?visual=data&theme=light', {
  422 |     waitUntil: 'domcontentloaded',
  423 |   })
  424 | 
  425 |   const title = await page.locator('.el-calendar__title').first().textContent()
  426 |   expect(title?.trim()).toMatch(/^\d{4}年\d{1,2}月$/)
  427 | })
  428 | 
  429 | test('markdown stress route renders long raw HTML without browser diagnostics', async ({
  430 |   page,
  431 | }) => {
  432 |   test.setTimeout(60_000)
  433 | 
  434 |   await page.emulateMedia({ reducedMotion: 'no-preference' })
  435 |   await page.goto('/?visual=markdown-stress&theme=light', {
  436 |     waitUntil: 'domcontentloaded',
  437 |   })
  438 | 
  439 |   await expect(
  440 |     page.locator('[data-testid="section-markdown-stress"]'),
  441 |   ).toBeVisible()
  442 |   await expect(
  443 |     page.locator('[data-testid="markdown-stress-renderer"]'),
  444 |   ).toBeVisible()
  445 |   await expect(
  446 |     page.locator('[data-testid="markdown-stress-status"]'),
> 447 |   ).toHaveText('complete', { timeout: 30_000 })
      |     ^ Error: expect(locator).toHaveText(expected) failed
  448 | 
  449 |   const metrics = await page
  450 |     .locator('[data-testid="markdown-stress-metrics"]')
  451 |     .textContent()
  452 |   expect(metrics).toContain('source: 500')
  453 |   expect(metrics).toContain('placeholders:')
  454 | 
  455 |   const timings = await page
  456 |     .locator('[data-testid="markdown-stress-timings"]')
  457 |     .textContent()
  458 |   expect(timings).toContain('html-only')
  459 |   expect(timings).toContain('summary')
  460 |   expect(timings).toContain('full-result')
  461 | 
  462 |   const renderer = page.locator('.markdown-stress-renderer')
  463 |   const stressScrollbar = page.locator('.markdown-stress-scrollbar')
  464 |   const stressScrollWrap = stressScrollbar
  465 |     .locator('.el-scrollbar__wrap')
  466 |     .first()
  467 |   const findRenderedMarkdownNode = async (selector: string) => {
  468 |     const maxScrollTop = await stressScrollWrap.evaluate((element) =>
  469 |       Math.max(0, element.scrollHeight - element.clientHeight),
  470 |     )
  471 |     const scrollPositions = [
  472 |       0,
  473 |       640,
  474 |       1_600,
  475 |       3_200,
  476 |       6_400,
  477 |       12_000,
  478 |       maxScrollTop * 0.25,
  479 |       maxScrollTop * 0.5,
  480 |       maxScrollTop * 0.75,
  481 |       maxScrollTop,
  482 |     ]
  483 | 
  484 |     for (const position of scrollPositions) {
  485 |       await stressScrollWrap.evaluate((element, top) => {
  486 |         element.scrollTop = Math.max(0, Math.min(element.scrollHeight, top))
  487 |         element.dispatchEvent(new Event('scroll'))
  488 |       }, position)
  489 |       await page.waitForTimeout(25)
  490 |       const locator = renderer.locator(selector)
  491 |       if ((await locator.count()) > 0) {
  492 |         return locator.first()
  493 |       }
  494 |     }
  495 | 
  496 |     throw new Error(`markdown_stress_selector_not_rendered:${selector}`)
  497 |   }
  498 | 
  499 |   await expect(renderer).toContainText('Escaped html probe 1:')
  500 |   await expect(renderer.locator('iframe')).toHaveCount(0)
  501 |   await expect(
  502 |     await findRenderedMarkdownNode('.markdown-renderer__text--inline-code'),
  503 |   ).toBeVisible()
  504 |   const liveRenderUnits = await renderer
  505 |     .locator('[data-fsus-render-unit]')
  506 |     .count()
  507 |   expect(liveRenderUnits).toBeGreaterThan(0)
  508 |   expect(liveRenderUnits).toBeLessThan(96)
  509 |   const hasWorkerRuntime = await page.evaluate(
  510 |     () => typeof Worker !== 'undefined',
  511 |   )
  512 |   const renderStrategy = await page
  513 |     .locator(
  514 |       '[data-testid="markdown-stress-renderer"] [data-markdown-renderer]',
  515 |     )
  516 |     .getAttribute('data-fsus-render-strategy')
  517 |   expect(renderStrategy).toBe(
  518 |     hasWorkerRuntime ? 'chunked-worker' : 'chunked-main',
  519 |   )
  520 | 
  521 |   await expect(stressScrollbar).toBeVisible()
  522 |   await stressScrollWrap.evaluate((element) => {
  523 |     element.scrollTop = 640
  524 |     element.dispatchEvent(new Event('scroll'))
  525 |   })
  526 |   await expect(stressScrollbar).toHaveClass(/is-scrolling/)
  527 |   await page.waitForTimeout(25)
  528 | 
  529 |   const stressScrollMotion = await stressScrollbar.evaluate((element) => {
  530 |     const content = element.querySelector<HTMLElement>(
  531 |       '.el-scrollbar__view > *',
  532 |     )
  533 |     const thumb = element.querySelector<HTMLElement>('.el-scrollbar__thumb')
  534 | 
  535 |     if (!content || !thumb) {
  536 |       return null
  537 |     }
  538 | 
  539 |     const contentStyle = window.getComputedStyle(content)
  540 |     const thumbStyle = window.getComputedStyle(thumb)
  541 | 
  542 |     return {
  543 |       contentFilter: contentStyle.filter,
  544 |       contentTransform: contentStyle.transform,
  545 |       thumbFilter: thumbStyle.filter,
  546 |       thumbShadow: thumbStyle.boxShadow,
  547 |     }
```