import React from 'react'
import { createRoot } from 'react-dom/client'
import { brand } from '@shared/branding'
import { applyBrandAccent } from './apply-accent'
import { Root } from './Root'
import './styles.css'

applyBrandAccent(brand.themeColor)

const root = document.getElementById('root')
if (!root) throw new Error('#root 不存在')

createRoot(root).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
)
