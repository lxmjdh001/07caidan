import { describe, expect, it } from 'vitest'
import { cleanBackendUrl, packagedBackendMigration } from './backend-url'

describe('packagedBackendMigration', () => {
  it('正式包把遗留 localhost 地址迁移到品牌公网后台', () => {
    expect(
      packagedBackendMigration('http://localhost:8787/', 'https://wzzapp.cloud/', true)
    ).toBe('https://wzzapp.cloud')
  })

  it('开发运行、自定义远程后台和本身就是品牌地址时均不覆盖', () => {
    expect(packagedBackendMigration('http://localhost:8787', 'https://wzzapp.cloud', false)).toBeUndefined()
    expect(packagedBackendMigration('https://staging.example.com', 'https://wzzapp.cloud', true)).toBeUndefined()
    expect(packagedBackendMigration('https://wzzapp.cloud/', 'https://wzzapp.cloud', true)).toBeUndefined()
  })

  it('地址标准化只去空白和末尾斜杠', () => {
    expect(cleanBackendUrl(' https://wzzapp.cloud/// ')).toBe('https://wzzapp.cloud')
  })
})
