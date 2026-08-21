import { describe, expect, it } from 'vitest'
import { errText } from './errors'

// errText 是渲染层所有错误文案的必经之路——它剥掉 Electron IPC 的英文包装只留真正原因。
// 正则一旦回归，全 App 的报错都会露出 "Error invoking remote method 'omni:xxx': Error: …" 噪音。
describe('errText', () => {
  it('剥掉 Electron IPC 调用包装 + Error: 前缀，只留真正原因', () => {
    expect(
      errText(new Error("Error invoking remote method 'omni:login': Error: 密码错误"))
    ).toBe('密码错误')
  })

  it('剥掉单独的 Error: 前缀', () => {
    expect(errText(new Error('Error: 网络超时'))).toBe('网络超时')
  })

  it('普通消息原样返回（不误伤）', () => {
    expect(errText(new Error('余额不足'))).toBe('余额不足')
    expect(errText(new Error('报错里也带 Error: 二字'))).toBe('报错里也带 Error: 二字') // 只剥开头
  })

  it('非 Error 值转成字符串', () => {
    expect(errText('直接的字符串')).toBe('直接的字符串')
    expect(errText(42)).toBe('42')
    expect(errText(null)).toBe('null')
  })
})
