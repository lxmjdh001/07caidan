import { describe, expect, it } from 'vitest'
import { accentVars } from './apply-accent'

describe('accentVars（品牌主题色 → 强调色）', () => {
  it('最终品牌绿会覆盖强调色与 Logo 渐变', () => {
    expect(accentVars('#16a56a')).toEqual({
      accent: '#16a56a',
      accentSoft: 'rgba(22, 165, 106, 0.13)',
      logoGradient: 'linear-gradient(135deg, #16a56a, rgb(15, 112, 72))'
    })
  })
  it('空/非法色不覆盖', () => {
    expect(accentVars(undefined)).toBeNull()
    expect(accentVars('')).toBeNull()
    expect(accentVars('purple')).toBeNull()
    expect(accentVars('#12')).toBeNull()
  })
  it('自定义 6 位色 → 覆盖 accent + 半透明 soft + Logo 渐变', () => {
    expect(accentVars('#7c3aed')).toEqual({
      accent: '#7c3aed',
      accentSoft: 'rgba(124, 58, 237, 0.13)',
      logoGradient: 'linear-gradient(135deg, #7c3aed, rgb(84, 39, 161))'
    })
  })
  it('3 位色展开', () => {
    expect(accentVars('#f0a')).toEqual({
      accent: '#f0a',
      accentSoft: 'rgba(255, 0, 170, 0.13)',
      logoGradient: 'linear-gradient(135deg, #f0a, rgb(173, 0, 116))'
    })
  })
})
