import { describe, expect, it } from 'vitest'
import { extFromMime, mediaTypeFromMime, mimeFromPath } from './mime'

describe('mimeFromPath', () => {
  it('常见扩展名', () => {
    expect(mimeFromPath('/a/b/photo.JPG')).toBe('image/jpeg')
    expect(mimeFromPath('video.mp4')).toBe('video/mp4')
    expect(mimeFromPath('voice.ogg')).toBe('audio/ogg')
    expect(mimeFromPath('report.pdf')).toBe('application/pdf')
  })

  it('未知扩展名兜底 octet-stream', () => {
    expect(mimeFromPath('file.xyz')).toBe('application/octet-stream')
    expect(mimeFromPath('noext')).toBe('application/octet-stream')
  })
})

describe('extFromMime', () => {
  it('常见 mime 与带参数的 mime', () => {
    expect(extFromMime('image/jpeg')).toBe('.jpg')
    expect(extFromMime('audio/ogg; codecs=opus')).toBe('.ogg')
  })

  it('未知/空 mime 兜底 .bin', () => {
    expect(extFromMime('application/x-unknown')).toBe('.bin')
    expect(extFromMime(undefined)).toBe('.bin')
  })
})

describe('mediaTypeFromMime', () => {
  it('按主类型归类，其余归 document', () => {
    expect(mediaTypeFromMime('image/png')).toBe('image')
    expect(mediaTypeFromMime('video/quicktime')).toBe('video')
    expect(mediaTypeFromMime('audio/mpeg')).toBe('audio')
    expect(mediaTypeFromMime('application/pdf')).toBe('document')
    expect(mediaTypeFromMime('text/plain')).toBe('document')
  })
})
