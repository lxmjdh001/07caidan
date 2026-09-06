import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

/** AES-256-GCM 字符串密封盒；数据库只保存带随机 IV 与认证标签的密文。 */
export class SecretBox {
  private readonly key?: Buffer

  constructor(secret: string | undefined) {
    this.key = secret && secret.length >= 32
      ? createHash('sha256').update(secret, 'utf8').digest()
      : undefined
  }

  get available(): boolean {
    return this.key !== undefined
  }

  seal(value: string): string {
    if (!this.key) throw new Error('账号环境加密密钥未配置')
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      encrypted.toString('base64url')
    ].join(':')
  }

  open(value: string): string {
    if (!this.key) throw new Error('账号环境加密密钥未配置')
    const [version, iv, tag, encrypted] = value.split(':')
    if (version !== 'v1' || !iv || !tag || !encrypted) throw new Error('账号环境密文格式无效')
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted, 'base64url')),
      decipher.final()
    ]).toString('utf8')
  }
}
