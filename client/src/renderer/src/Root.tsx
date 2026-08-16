import { useEffect, useState } from 'react'
import { App } from './App'
import { AuthGate } from './components/AuthGate'
import { I18nProvider, isLocale, type Locale } from './i18n'

const api = window.omni

/**
 * 根组件：先判断登录状态。未登录显示 AuthGate（账号登录/注册），
 * 登录后进入主应用。i18n 在两态之间共享。
 */
export function Root(): React.JSX.Element {
  const [authed, setAuthed] = useState<boolean | null>(null)
  const [locale, setLocale] = useState<Locale>('zh-CN')

  useEffect(() => {
    void api.authState().then((s) => setAuthed(s.authenticated))
    void api.getSettings().then((s) => {
      if (isLocale(s.locale)) setLocale(s.locale)
    })
  }, [])

  if (authed === null) return <div />

  if (!authed) {
    return (
      <I18nProvider locale={locale}>
        <AuthGate onAuthed={() => setAuthed(true)} />
      </I18nProvider>
    )
  }
  return <App onLogout={() => setAuthed(false)} />
}
