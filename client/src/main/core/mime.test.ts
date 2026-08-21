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

  // omni-media:// 协议按 mediaId(=<uuid><ext>) 文件名补 Content-Type，否则 <video> 黑屏。
  // 这些视频扩展必须命中真实 video/* 类型，尤其 .3gp（旧版 WhatsApp 视频/短视频常见）。
  it('视频扩展命中 video/* 而非 octet-stream（防黑屏）', () => {
    expect(mimeFromPath('c1f2.mp4')).toBe('video/mp4')
    expect(mimeFromPath('c1f2.m4v')).toBe('video/mp4')
    expect(mimeFromPath('c1f2.3gp')).toBe('video/3gpp')
    expect(mimeFromPath('c1f2.webm')).toBe('video/webm')
    expect(mimeFromPath('c1f2.mkv')).toBe('video/x-matroska')
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

  // 入站保存用 extFromMime(mimeType) 决定落盘扩展；video/3gpp 之前漏映射会存成 .bin，
  // 之后既嗅探不出类型又黑屏。补上后 3gp 视频落盘为 .3gp，全链路可播。
  it('video/3gpp 落盘为 .3gp（含带 codecs 参数）', () => {
    expect(extFromMime('video/3gpp')).toBe('.3gp')
    expect(extFromMime('video/3gpp; codecs="mp4v.20.8"')).toBe('.3gp')
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
