import { describe, expect, test } from 'vitest'
import { isSafeExternalUrl } from './external-url'

describe('isSafeExternalUrl', () => {
  test.each([
    'https://wzzapp.cloud',
    'http://127.0.0.1:8787/health',
    'mailto:support@wzzapp.cloud'
  ])('允许安全外链 %s', (url) => expect(isSafeExternalUrl(url)).toBe(true))

  test.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,test',
    'smb://example/share',
    'not a url'
  ])('拒绝本地或危险协议 %s', (url) => expect(isSafeExternalUrl(url)).toBe(false))
})
