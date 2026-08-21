import { extname } from 'node:path'
import type { MediaType } from '@shared/domain'

/** 常见媒体类型映射（不求全，识别不了的按 document / octet-stream 兜底） */
const EXT_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.3gp': 'video/3gpp',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip',
  '.txt': 'text/plain'
}

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/3gpp': '.3gp',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'application/pdf': '.pdf'
}

export function mimeFromPath(filePath: string): string {
  return EXT_TO_MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

/** mime 可能带参数（如 audio/ogg; codecs=opus） */
function baseMime(mime: string): string {
  return (mime.split(';')[0] ?? mime).trim().toLowerCase()
}

export function extFromMime(mime: string | undefined): string {
  if (!mime) return '.bin'
  return MIME_TO_EXT[baseMime(mime)] ?? '.bin'
}

export function mediaTypeFromMime(mime: string): MediaType {
  const base = baseMime(mime)
  if (base.startsWith('image/')) return 'image'
  if (base.startsWith('video/')) return 'video'
  if (base.startsWith('audio/')) return 'audio'
  return 'document'
}
