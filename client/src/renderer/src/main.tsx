import React from 'react'
import { createRoot } from 'react-dom/client'
import { Root } from './Root'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root 不存在')

createRoot(root).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
)
