import { randomUUID } from 'node:crypto'
import { access, copyFile, mkdir, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'

/**
 * 本地媒体文件存储：所有收发的媒体统一以 `<uuid><ext>` 平铺保存，
 * mediaId 即文件名。resolve 做目录穿越防护，供 omni-media:// 协议使用。
 */
export class MediaStore {
  constructor(private readonly baseDir: string) {}

  async init(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true })
  }

  async save(data: Buffer, ext: string): Promise<string> {
    // 容忍带点或不带点的扩展名（'ogg' 与 '.ogg' 都认）——语音发送传的是 'ogg'，
    // 之前因缺前导点被判非法一律落成 .bin，语音文件丢了真实扩展名。非法/缺失才回落 .bin。
    const dotted = ext.startsWith('.') ? ext : `.${ext}`
    const safeExt = /^\.[a-z0-9]{1,8}$/i.test(dotted) ? dotted.toLowerCase() : '.bin'
    const mediaId = `${randomUUID()}${safeExt}`
    await writeFile(join(this.baseDir, mediaId), data)
    return mediaId
  }

  /** 服务端恢复时沿用原 mediaId，保证不同电脑引用同一个媒体对象。 */
  async saveAs(mediaId: string, data: Buffer): Promise<void> {
    const path = this.resolvePath(mediaId)
    if (!path || !/^[\w.-]+$/.test(mediaId)) throw new Error('非法 mediaId')
    await writeFile(path, data)
  }

  async has(mediaId: string): Promise<boolean> {
    const path = this.resolvePath(mediaId)
    if (!path) return false
    try {
      await access(path)
      return true
    } catch {
      return false
    }
  }

  /** 导入外部文件（发送前复制进库，保证消息记录里的媒体不随原文件移动失效） */
  async importFile(srcPath: string): Promise<string> {
    const mediaId = `${randomUUID()}${extname(srcPath).toLowerCase() || '.bin'}`
    await copyFile(srcPath, join(this.baseDir, mediaId))
    return mediaId
  }

  /** mediaId → 绝对路径；非法 ID（穿越/子目录）返回 null */
  resolvePath(mediaId: string): string | null {
    if (!mediaId || mediaId !== basename(mediaId)) return null
    const abs = resolve(this.baseDir, mediaId)
    if (!abs.startsWith(resolve(this.baseDir) + '/')) return null
    return abs
  }
}
