import { afterEach, describe, expect, it, vi } from 'vitest'
import { GoogleFreeTranslator } from './google-free'

afterEach(() => vi.unstubAllGlobals())

describe('GoogleFreeTranslator', () => {
  it('首个端点限流时自动使用备用端点', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([['Hello', 'zh-CN']]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(new GoogleFreeTranslator().translate('你好', 'en')).resolves.toEqual({
      text: 'Hello',
      sourceLang: 'zh-CN'
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
