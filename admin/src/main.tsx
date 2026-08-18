import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { applyBrandAccent, brand } from './branding'
import { I18nProvider } from './i18n'
import './styles.css'

document.title = brand.appName
applyBrandAccent(brand.themeColor)

const root = document.getElementById('root')
if (!root) throw new Error('#root missing')
createRoot(root).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>
)
