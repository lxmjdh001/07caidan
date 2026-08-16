import { createContext, useContext, type ReactNode } from 'react'

/**
 * 轻量 i18n：字典 + Context。新增语言 = 在 dictionaries 加一个对象。
 */
const zhCN = {
  'app.name': 'OmniChat',
  'sidebar.title': '消息',
  'sidebar.search': '搜索会话…',
  'sidebar.empty': '暂无会话\n连接渠道后，新消息会出现在这里',
  'chat.empty': '选择左侧会话开始聊天',
  'chat.composer.placeholder': '输入消息，Enter 发送，Shift+Enter 换行',
  'chat.send': '发送',
  'chat.sendFailed': '发送失败',
  'chat.original': '原文',
  'chat.attach': '发送图片 / 视频 / 文件',
  'chat.mediaDownloading': '下载中…',
  'chat.knownContact': '已在其他账号联系过',
  'chat.settings': '会话设置',
  'chat.customerLang': '客户语言',
  'chat.langAuto': '自动',
  'chat.detected': '已检测到',
  'chat.notDetected': '未检测到，回退默认',
  'chat.translatedAs': '译文',
  'chat.previewLabel': '发送预览',
  'chat.confirmSend': '确认发送',
  'channel.whatsapp': 'WhatsApp',
  'channel.telegram': 'Telegram（即将支持）',
  'channel.line': 'LINE（即将支持）',
  'rail.allChats': '全部消息',
  'rail.accounts': '账号',
  'rail.addAccount': '添加 WhatsApp 账号',
  'rail.searchAccounts': '搜索账号…',
  'rail.noMatch': '无匹配账号',
  'account.settings': '账号设置',
  'account.label': '备注名',
  'account.notLoggedIn': '未登录',
  'account.device': '设备名',
  'account.deviceAuto': '自动（各账号不同）',
  'account.deviceHint': '「已关联的设备」中显示的名称，各账号自动隔离；修改后需重新登录生效',
  'status.stopped': '未启动，点击图标连接',
  'status.connecting': '连接中…',
  'status.waiting_qr': '等待扫码',
  'status.connected': '已连接',
  'status.logged_out': '已退出登录，点击图标重新连接',
  'status.error': '连接出错',
  'qr.title': '连接 WhatsApp',
  'qr.step1': '1. 打开手机 WhatsApp',
  'qr.step2': '2. 进入 设置 → 已关联的设备 → 关联设备',
  'qr.step3': '3. 扫描下方二维码',
  'qr.waiting': '正在生成二维码…',
  'qr.hint': '登录后消息将同步到此设备。连接完全在本机进行，凭证仅保存在本地。',
  'connected.empty': '已连接。等待新消息，或在手机上打开一个会话即可在此同步。',
  'settings.title': '设置',
  'settings.general': '通用',
  'settings.locale': '界面语言',
  'settings.translation': '聊天翻译',
  'settings.engine': '翻译引擎',
  'settings.engine.hint': '默认使用免费引擎；也可配置自己的翻译接口',
  'settings.inbound': '自动翻译收到的消息',
  'settings.outbound': '发送时自动翻译成客户语言',
  'settings.confirmBeforeSend': '发送前预览译文确认（关闭则直发）',
  'settings.sync': '聊天记录后台同步',
  'settings.syncEnabled': '将聊天记录同步到后台（供查询与 AI 意向分析）',
  'settings.syncUrl': '后台服务地址',
  'settings.syncToken': '同步令牌',
  'settings.syncMedia': '同时上传媒体文件（图片/语音/视频）',
  'settings.syncHint': '批量定时上传，记录含译文；后台按客户唯一标识聚合，可按需做 AI 意向分析',
  'settings.displayLang': '我的本地语言（收到的消息译成）',
  'settings.targetLangDefault': '全局默认客户语言（未识别到客户语言时使用）',
  'settings.accountLang': '本账号默认客户语言（覆盖全局）',
  'settings.followGlobal': '跟随全局',
  'settings.deeplKey': 'DeepL API Key（:fx 结尾为免费版）',
  'settings.gcKey': 'Google Cloud API Key',
  'settings.llmBaseUrl': '接口地址（OpenAI 兼容）',
  'settings.llmKey': 'API Key',
  'settings.llmModel': '模型名称',
  'settings.customUrl': '自定义接口地址',
  'settings.customKey': 'API Key（可选）',
  'settings.customHint': '协议：POST JSON {"text","target_lang"} → {"text","source_lang"?}',
  'settings.account': '账号',
  'settings.proxy': 'WhatsApp 代理（socks5:// 或 http://，留空走默认网络）',
  'settings.proxyHint': '修改后下次重连生效',
  'settings.logout': '退出登录',
  'settings.logoutConfirm': '确定退出登录？本地凭证将被清除，需要重新扫码。',
  'settings.removeAccount': '删除此账号',
  'settings.removeConfirm': '删除账号？将退出登录并从列表移除（聊天记录保留）。',
  'settings.save': '保存',
  'settings.cancel': '取消',
  'time.yesterday': '昨天'
}

const en: typeof zhCN = {
  'app.name': 'OmniChat',
  'sidebar.title': 'Chats',
  'sidebar.search': 'Search chats…',
  'sidebar.empty': 'No conversations yet\nNew messages will appear here once connected',
  'chat.empty': 'Select a conversation to start',
  'chat.composer.placeholder': 'Type a message. Enter to send, Shift+Enter for newline',
  'chat.send': 'Send',
  'chat.sendFailed': 'Failed to send',
  'chat.original': 'Original',
  'chat.attach': 'Send image / video / file',
  'chat.mediaDownloading': 'downloading…',
  'chat.knownContact': 'Known from another account',
  'chat.settings': 'Conversation settings',
  'chat.customerLang': 'Customer language',
  'chat.langAuto': 'Auto',
  'chat.detected': 'Detected',
  'chat.notDetected': 'Not detected, using default',
  'chat.translatedAs': 'Sent as',
  'chat.previewLabel': 'Preview',
  'chat.confirmSend': 'Confirm & send',
  'channel.whatsapp': 'WhatsApp',
  'channel.telegram': 'Telegram (coming soon)',
  'channel.line': 'LINE (coming soon)',
  'rail.allChats': 'All chats',
  'rail.accounts': 'Accounts',
  'rail.addAccount': 'Add WhatsApp account',
  'rail.searchAccounts': 'Search accounts…',
  'rail.noMatch': 'No matching account',
  'account.settings': 'Account settings',
  'account.label': 'Nickname',
  'account.notLoggedIn': 'Not logged in',
  'account.device': 'Device name',
  'account.deviceAuto': 'Auto (unique per account)',
  'account.deviceHint': 'Name shown in Linked Devices; isolated per account. Re-login to apply changes.',
  'status.stopped': 'Stopped. Click the icon to connect',
  'status.connecting': 'Connecting…',
  'status.waiting_qr': 'Waiting for QR scan',
  'status.connected': 'Connected',
  'status.logged_out': 'Logged out. Click the icon to reconnect',
  'status.error': 'Connection error',
  'qr.title': 'Link WhatsApp',
  'qr.step1': '1. Open WhatsApp on your phone',
  'qr.step2': '2. Go to Settings → Linked Devices → Link a Device',
  'qr.step3': '3. Scan the QR code below',
  'qr.waiting': 'Generating QR code…',
  'qr.hint': 'The connection runs entirely on this machine; credentials stay local.',
  'connected.empty': 'Connected. Waiting for new messages.',
  'settings.title': 'Settings',
  'settings.general': 'General',
  'settings.locale': 'Language',
  'settings.translation': 'Chat translation',
  'settings.engine': 'Engine',
  'settings.engine.hint': 'Free engine by default; you can plug in your own API',
  'settings.inbound': 'Auto-translate incoming messages',
  'settings.outbound': 'Auto-translate outgoing messages into customer language',
  'settings.confirmBeforeSend': 'Preview translation before sending (off = send directly)',
  'settings.sync': 'Backend sync',
  'settings.syncEnabled': 'Sync chat history to backend (for query & AI intent analysis)',
  'settings.syncUrl': 'Backend URL',
  'settings.syncToken': 'Sync token',
  'settings.syncMedia': 'Also upload media (images / audio / video)',
  'settings.syncHint': 'Batched periodic upload with translations; aggregated per customer for on-demand AI intent analysis',
  'settings.displayLang': 'My language (incoming translated into)',
  'settings.targetLangDefault': 'Global default customer language (fallback)',
  'settings.accountLang': 'Account default customer language (overrides global)',
  'settings.followGlobal': 'Follow global',
  'settings.deeplKey': 'DeepL API Key (ends with :fx for free tier)',
  'settings.gcKey': 'Google Cloud API Key',
  'settings.llmBaseUrl': 'Base URL (OpenAI-compatible)',
  'settings.llmKey': 'API Key',
  'settings.llmModel': 'Model',
  'settings.customUrl': 'Custom endpoint URL',
  'settings.customKey': 'API Key (optional)',
  'settings.customHint': 'Contract: POST JSON {"text","target_lang"} → {"text","source_lang"?}',
  'settings.account': 'Accounts',
  'settings.proxy': 'WhatsApp proxy (socks5:// or http://, empty = direct)',
  'settings.proxyHint': 'Applies on next reconnect',
  'settings.logout': 'Log out',
  'settings.logoutConfirm': 'Log out? Local credentials will be removed.',
  'settings.removeAccount': 'Remove account',
  'settings.removeConfirm': 'Remove this account? It will be logged out and removed (history kept).',
  'settings.save': 'Save',
  'settings.cancel': 'Cancel',
  'time.yesterday': 'Yesterday'
}

export const dictionaries = { 'zh-CN': zhCN, en } as const
export type Locale = keyof typeof dictionaries
export type MessageKey = keyof typeof zhCN

export function isLocale(v: string): v is Locale {
  return v in dictionaries
}

interface I18n {
  locale: Locale
  t: (key: MessageKey) => string
}

const I18nContext = createContext<I18n>({ locale: 'zh-CN', t: (k) => zhCN[k] })

export function I18nProvider({
  locale,
  children
}: {
  locale: Locale
  children: ReactNode
}): React.JSX.Element {
  const dict = dictionaries[locale]
  return (
    <I18nContext.Provider value={{ locale, t: (key) => dict[key] ?? zhCN[key] }}>
      {children}
    </I18nContext.Provider>
  )
}

export function useI18n(): I18n {
  return useContext(I18nContext)
}
