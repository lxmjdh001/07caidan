import nodemailer from 'nodemailer'
import type { ServerConfig } from './config.ts'

export interface EmailSender {
  send(to: string, subject: string, text: string): Promise<void>
}

/** 开发模式：不真正发信，把内容打到日志（验证码会出现在服务端日志里） */
export class ConsoleEmailSender implements EmailSender {
  async send(to: string, subject: string, text: string): Promise<void> {
    console.log(`[email:dev] to=${to} subject="${subject}"\n${text}`)
  }
}

/** SMTP 发信 */
export class SmtpEmailSender implements EmailSender {
  private readonly transport: nodemailer.Transporter
  private readonly from: string

  constructor(opts: { host: string; port: number; user: string; pass: string; from: string }) {
    this.transport = nodemailer.createTransport({
      host: opts.host,
      port: opts.port,
      secure: opts.port === 465,
      auth: opts.user ? { user: opts.user, pass: opts.pass } : undefined
    })
    this.from = opts.from || opts.user
  }

  async send(to: string, subject: string, text: string): Promise<void> {
    await this.transport.sendMail({ from: this.from, to, subject, text })
  }
}

/** 按配置选择发信实现：配了 SMTP 用 SMTP，否则开发模式打日志 */
export function createEmailSender(config: ServerConfig): EmailSender {
  if (config.smtp) {
    return new SmtpEmailSender(config.smtp)
  }
  return new ConsoleEmailSender()
}
