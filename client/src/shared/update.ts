/** 自动更新状态（主进程 → 渲染进程） */
export interface UpdateStateInfo {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error' | 'uptodate'
  version?: string
  percent?: number
  error?: string
}
