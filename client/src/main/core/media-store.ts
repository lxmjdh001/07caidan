import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
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
    const safeExt = /^\.[a-z0-9]{1,8}$/i.test(ext) ? ext.toLowerCase() : '.bin'
    const mediaId = `${randomUUID()}${safeExt}`
    await writeFile(join(this.baseDir, mediaId), data)
    return mediaId
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
