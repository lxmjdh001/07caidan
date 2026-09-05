import { describe, expect, it } from 'vitest'
import { DEFAULT_PLATFORM_ORDER, normalizePlatformOrder, reorderPlatformOrder } from './platform-order'

describe('reorderPlatformOrder', () => {
  it('把下方平台拖到上方目标之前', () => {
    expect(reorderPlatformOrder(DEFAULT_PLATFORM_ORDER, 'line', 'whatsapp')).toEqual([
      'line', 'whatsapp', 'telegram', 'telegram_bot', 'kakaotalk', 'facebook', 'instagram', 'tiktok', 'x', 'snapchat'
    ])
  })

  it('把上方平台拖到下方目标之前', () => {
    expect(reorderPlatformOrder(DEFAULT_PLATFORM_ORDER, 'whatsapp', 'line')).toEqual([
      'telegram', 'telegram_bot', 'whatsapp', 'line', 'kakaotalk', 'facebook', 'instagram', 'tiktok', 'x', 'snapchat'
    ])
  })

  it('升级旧设置时补上新平台', () => {
    expect(normalizePlatformOrder(['line', 'whatsapp', 'telegram', 'telegram_bot'])).toEqual([
      'line', 'whatsapp', 'telegram', 'telegram_bot', 'kakaotalk', 'facebook', 'instagram', 'tiktok', 'x', 'snapchat'
    ])
  })
})
