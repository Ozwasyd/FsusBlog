# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: demo-app-dev.spec.ts >> markdown stress scrollbar thumb drag stays smooth without text blur
- Location: vue/tests/demo-app-dev/demo-app-dev.spec.ts:661:5

# Error details

```
Error: expect(locator).toHaveText(expected) failed

Locator:  locator('[data-testid="markdown-stress-status"]')
Expected: "complete"
Received: "rendering"
Timeout:  20000ms

Call log:
  - Expect "toHaveText" with timeout 20000ms
  - waiting for locator('[data-testid="markdown-stress-status"]')
    3 × locator resolved to <strong data-testid="markdown-stress-status">rendering</strong>
      - unexpected value "rendering"

```

# Test source

```ts
  572 |       const style = window.getComputedStyle(element)
  573 | 
  574 |       return {
  575 |         clientWidth: element.clientWidth,
  576 |         hasIframeText: element.textContent?.includes('<iframe') ?? false,
  577 |         overflowX: element.scrollWidth - element.clientWidth,
  578 |         wordBreak: style.wordBreak,
  579 |         overflowWrap: style.overflowWrap,
  580 |       }
  581 |     })
  582 | 
  583 |   expect(escapedProbeLayout.hasIframeText).toBe(true)
  584 |   expect(escapedProbeLayout.overflowX).toBeLessThanOrEqual(2)
  585 |   expect(escapedProbeLayout.clientWidth).toBeGreaterThan(0)
  586 |   expect(['anywhere', 'break-word']).toContain(escapedProbeLayout.overflowWrap)
  587 |   expect(['break-word', 'normal']).toContain(escapedProbeLayout.wordBreak)
  588 | 
  589 |   const mermaidFigure = await findRenderedMarkdownNode(
  590 |     '.markdown-renderer__mermaid[data-mermaid-rendered="true"]',
  591 |   )
  592 |   const diagramLayout = await mermaidFigure.evaluate((figure) => {
  593 |     const svg = figure.querySelector('svg')
  594 |     const root = figure.closest('.markdown-renderer')
  595 | 
  596 |     if (!svg || !root) {
  597 |       return null
  598 |     }
  599 | 
  600 |     const figureRect = figure.getBoundingClientRect()
  601 |     const svgRect = svg.getBoundingClientRect()
  602 |     const rootRect = root.getBoundingClientRect()
  603 | 
  604 |     return {
  605 |       figureWidth: figureRect.width,
  606 |       rootWidth: rootRect.width,
  607 |       svgHeight: svgRect.height,
  608 |       svgWidth: svgRect.width,
  609 |       heightAttr: svg.getAttribute('height'),
  610 |       widthAttr: svg.getAttribute('width'),
  611 |     }
  612 |   })
  613 | 
  614 |   expect(diagramLayout?.widthAttr).toMatch(/^\d+$/)
  615 |   expect(diagramLayout?.heightAttr).toMatch(/^\d+$/)
  616 |   expect(
  617 |     diagramLayout?.svgWidth ?? Number.POSITIVE_INFINITY,
  618 |   ).toBeLessThanOrEqual(520)
  619 |   expect(
  620 |     diagramLayout?.svgHeight ?? Number.POSITIVE_INFINITY,
  621 |   ).toBeLessThanOrEqual(180)
  622 |   expect(diagramLayout?.figureWidth ?? Number.POSITIVE_INFINITY).toBeLessThan(
  623 |     (diagramLayout?.rootWidth ?? 0) * 0.6,
  624 |   )
  625 | 
  626 |   await page.addStyleTag({
  627 |     content: [
  628 |       '.markdown-renderer p,',
  629 |       '.markdown-renderer li {',
  630 |       '  text-align: justify;',
  631 |       '  text-align-last: justify;',
  632 |       '  word-spacing: 12px;',
  633 |       '}',
  634 |     ].join('\n'),
  635 |   })
  636 | 
  637 |   const protectedTechnicalText = await (
  638 |     await findRenderedMarkdownNode('.markdown-renderer__text--inline-code')
  639 |   ).evaluate((element) => {
  640 |     const style = window.getComputedStyle(element)
  641 |     return {
  642 |       textAlign: style.textAlign,
  643 |       textAlignLast: style.textAlignLast,
  644 |       wordSpacing: style.wordSpacing,
  645 |     }
  646 |   })
  647 |   expect(protectedTechnicalText.textAlign).not.toBe('justify')
  648 |   expect(protectedTechnicalText.textAlignLast).not.toBe('justify')
  649 |   expect(protectedTechnicalText.wordSpacing).not.toBe('12px')
  650 | 
  651 |   const layout = await renderer.evaluate((element) => ({
  652 |     viewportOverflow:
  653 |       document.documentElement.scrollWidth -
  654 |       document.documentElement.clientWidth,
  655 |     rendererOverflow: element.scrollWidth - element.clientWidth,
  656 |   }))
  657 |   expect(layout.viewportOverflow).toBeLessThanOrEqual(2)
  658 |   expect(layout.rendererOverflow).toBeLessThanOrEqual(2)
  659 | })
  660 | 
  661 | test('markdown stress scrollbar thumb drag stays smooth without text blur', async ({
  662 |   page,
  663 | }) => {
  664 |   test.setTimeout(60_000)
  665 |   await page.emulateMedia({ reducedMotion: 'no-preference' })
  666 |   await page.goto('/?visual=markdown-stress&theme=light', {
  667 |     waitUntil: 'domcontentloaded',
  668 |   })
  669 | 
  670 |   await expect(
  671 |     page.locator('[data-testid="markdown-stress-status"]'),
> 672 |   ).toHaveText('complete', { timeout: 20_000 })
      |     ^ Error: expect(locator).toHaveText(expected) failed
  673 | 
  674 |   const scrollbar = page.locator('.markdown-stress-scrollbar')
  675 |   const wrap = scrollbar.locator('.el-scrollbar__wrap').first()
  676 |   const thumb = scrollbar
  677 |     .locator('.el-scrollbar__bar.is-vertical .el-scrollbar__thumb')
  678 |     .first()
  679 | 
  680 |   await expect(scrollbar).toBeVisible()
  681 |   await expect(thumb).toBeVisible()
  682 |   await wrap.evaluate((element) => {
  683 |     element.scrollTop = 0
  684 |     element.dispatchEvent(new Event('scroll'))
  685 |   })
  686 |   await expect(scrollbar).not.toHaveClass(/is-scrolling/, { timeout: 2500 })
  687 | 
  688 |   const thumbBox = await thumb.boundingBox()
  689 |   expect(thumbBox).not.toBeNull()
  690 |   if (!thumbBox) return
  691 | 
  692 |   const readDragPosition = () =>
  693 |     scrollbar.evaluate((element) => {
  694 |       const wrap = element.querySelector<HTMLElement>('.el-scrollbar__wrap')
  695 |       const renderer = element.querySelector<HTMLElement>(
  696 |         '.markdown-stress-renderer',
  697 |       )
  698 |       if (!wrap || !renderer) {
  699 |         throw new Error('Markdown stress scrollbar drag internals are missing')
  700 |       }
  701 | 
  702 |       const wrapRect = wrap.getBoundingClientRect()
  703 |       let section = 0
  704 |       let bestTop = Number.NEGATIVE_INFINITY
  705 |       for (const heading of renderer.querySelectorAll<HTMLElement>('h2')) {
  706 |         const rect = heading.getBoundingClientRect()
  707 |         if (rect.top <= wrapRect.top + 40 && rect.top > bestTop) {
  708 |           bestTop = rect.top
  709 |           section =
  710 |             Number.parseInt(
  711 |               /Stress Section\s+(\d+)/.exec(heading.textContent || '')?.[1] ||
  712 |                 '0',
  713 |               10,
  714 |             ) || 0
  715 |         }
  716 |       }
  717 | 
  718 |       return {
  719 |         clientHeight: wrap.clientHeight,
  720 |         scrollTop: wrap.scrollTop,
  721 |         section,
  722 |       }
  723 |     })
  724 | 
  725 |   await page.mouse.move(
  726 |     thumbBox.x + thumbBox.width / 2,
  727 |     thumbBox.y + Math.min(8, thumbBox.height / 2),
  728 |   )
  729 |   await page.mouse.down()
  730 |   await page.mouse.move(thumbBox.x + thumbBox.width / 2, thumbBox.y + 160, {
  731 |     steps: 16,
  732 |   })
  733 |   await expect(scrollbar).toHaveClass(/is-scrolling/)
  734 |   await expect(scrollbar).toHaveClass(/is-thumb-dragging/)
  735 |   await page.waitForTimeout(50)
  736 | 
  737 |   const forwardDragPosition = await readDragPosition()
  738 |   await page.mouse.move(thumbBox.x + thumbBox.width / 2, thumbBox.y + 120, {
  739 |     steps: 8,
  740 |   })
  741 |   await page.waitForTimeout(80)
  742 |   const reverseDragPosition = await readDragPosition()
  743 | 
  744 |   expect(reverseDragPosition.scrollTop).toBeGreaterThanOrEqual(
  745 |     forwardDragPosition.scrollTop - 18_000,
  746 |   )
  747 |   if (forwardDragPosition.section > 0 && reverseDragPosition.section > 0) {
  748 |     expect(reverseDragPosition.section).toBeGreaterThanOrEqual(
  749 |       forwardDragPosition.section - 64,
  750 |     )
  751 |   }
  752 | 
  753 |   const dragMetrics = await scrollbar.evaluate((element) => {
  754 |     const wrap = element.querySelector<HTMLElement>('.el-scrollbar__wrap')
  755 |     const content = element.querySelector<HTMLElement>(
  756 |       '.el-scrollbar__view > *',
  757 |     )
  758 |     const thumb = element.querySelector<HTMLElement>(
  759 |       '.el-scrollbar__bar.is-vertical .el-scrollbar__thumb',
  760 |     )
  761 | 
  762 |     if (!wrap || !content || !thumb) {
  763 |       throw new Error('Markdown stress scrollbar drag internals are missing')
  764 |     }
  765 | 
  766 |     const readBlur = (filter: string) => {
  767 |       const match = /blur\(([\d.]+)px\)/.exec(filter)
  768 |       return match ? Number.parseFloat(match[1]) : 0
  769 |     }
  770 |     const contentStyle = getComputedStyle(content)
  771 |     const thumbStyle = getComputedStyle(thumb)
  772 |     const thumbAfterStyle = getComputedStyle(thumb, '::after')
```