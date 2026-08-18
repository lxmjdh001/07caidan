import { describe, expect, it } from 'vitest'
import { accentVars } from './apply-accent'

describe('accentVars（品牌主题色 → 强调色）', () => {
  it('默认绿不覆盖', () => {
    expect(accentVars('#22a06b')).toBeNull()
    expect(accentVars('#22A06B')).toBeNull()
  })
  it('空/非法色不覆盖', () => {
    expect(accentVars(undefined)).toBeNull()
    expect(accentVars('')).toBeNull()
    expect(accentVars('purple')).toBeNull()
    expect(accentVars('#12')).toBeNull()
  })
  it('自定义 6 位色 → 覆盖 accent + 半透明 soft', () => {
    expect(accentVars('#7c3aed')).toEqual({
      accent: '#7c3aed',
      accentSoft: 'rgba(124, 58, 237, 0.13)'
    })
  })
  it('3 位色展开', () => {
    expect(accentVars('#f0a')).toEqual({
      accent: '#f0a',
      accentSoft: 'rgba(255, 0, 170, 0.13)'
    })
  })
})
