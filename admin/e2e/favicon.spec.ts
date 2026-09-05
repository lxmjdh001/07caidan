import { test, expect } from '@playwright/test'

test('后台 favicon 按品牌生成并注入', async ({ page }) => {
  await page.goto('/')
  // main.tsx 启动即设置 link[rel=icon] 为品牌 SVG favicon
  const href = await page
    .locator('link[rel="icon"]')
    .getAttribute('href', { timeout: 10_000 })
  expect(href).toBeTruthy()
  const decoded = decodeURIComponent(href ?? '')
  expect(decoded).toContain('image/svg+xml')
  expect(decoded).toContain('<svg')
  // 最终品牌：绿色渐变底 + 固定 W 矢量标识
  expect(decoded).toContain('#16a56a')
  expect(decoded).toContain('M14 19 24 46 32 29 40 46 50 19')
})
