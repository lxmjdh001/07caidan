import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MediaStore } from './media-store'

let dir: string
let store: MediaStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'omnichat-media-'))
  store = new MediaStore(dir)
  await store.init()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('MediaStore', () => {
  it('save 后可通过 resolvePath 读回', async () => {
    const mediaId = await store.save(Buffer.from('img-bytes'), '.jpg')
    expect(mediaId).toMatch(/\.jpg$/)
    const abs = store.resolvePath(mediaId)
    expect(abs).toBeTruthy()
    expect((await readFile(abs!)).toString()).toBe('img-bytes')
  })

  it('非法扩展名兜底为 .bin', async () => {
    expect(await store.save(Buffer.from('x'), '../../etc')).toMatch(/\.bin$/)
    expect(await store.save(Buffer.from('x'), '.j p g')).toMatch(/\.bin$/)
  })

  it('importFile 复制外部文件并保留扩展名', async () => {
    const src = join(dir, 'source.PNG')
    await writeFile(src, 'png-bytes')
    const mediaId = await store.importFile(src)
    expect(mediaId).toMatch(/\.png$/)
    expect((await readFile(store.resolvePath(mediaId)!)).toString()).toBe('png-bytes')
  })

  it('resolvePath 阻断目录穿越', () => {
    expect(store.resolvePath('../settings.json')).toBeNull()
    expect(store.resolvePath('a/b.jpg')).toBeNull()
    expect(store.resolvePath('/etc/passwd')).toBeNull()
    expect(store.resolvePath('')).toBeNull()
  })
})
