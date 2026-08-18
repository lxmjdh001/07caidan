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
  // 默认品牌：绿色底 + logoText OC
  expect(decoded).toContain('#22a06b')
  expect(decoded).toContain('>OC<')
})
