import { createServer, type Server, connect as netConnect, type Socket } from 'node:net'
import { createServer as httpServer, type Server as HttpServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDispatcher, withDispatcher } from './proxy'

/**
 * 真实回路：本地起一个 HTTP 目标 + 一个极简 SOCKS5 代理，
 * 用 createDispatcher('socks5://...') 让 fetch 走代理访问目标，
 * 验证 socks 拨号 + undici connect 回调 + 字节流全程打通（不是只测工厂返回类型）。
 */

let target: HttpServer
let targetPort = 0
let socks: Server
let socksPort = 0
let proxied = 0

/** 极简 SOCKS5 服务器：无鉴权，仅 CONNECT，支持 IPv4/域名，直接管道到目标 */
function startSocks5(): Server {
  return createServer((client: Socket) => {
    client.once('data', () => {
      // 握手：回复「无需鉴权」
      client.write(Buffer.from([0x05, 0x00]))
      client.once('data', (req: Buffer) => {
        const atyp = req[3]
        let host = ''
        let port = 0
        if (atyp === 0x01) {
          host = `${req[4]}.${req[5]}.${req[6]}.${req[7]}`
          port = req.readUInt16BE(8)
        } else if (atyp === 0x03) {
          const len = req[4]!
          host = req.subarray(5, 5 + len).toString()
          port = req.readUInt16BE(5 + len)
        } else {
          client.end()
          return
        }
        const upstream = netConnect(port, host, () => {
          proxied++
          // 成功应答：05 00 00 01 0.0.0.0:0
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
          client.pipe(upstream)
          upstream.pipe(client)
        })
        upstream.on('error', () => client.end())
      })
    })
    client.on('error', () => {})
  })
}

beforeAll(async () => {
  target = httpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('through-proxy-ok')
  })
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r))
  targetPort = (target.address() as { port: number }).port

  socks = startSocks5()
  await new Promise<void>((r) => socks.listen(0, '127.0.0.1', r))
  socksPort = (socks.address() as { port: number }).port
})

afterAll(async () => {
  await new Promise<void>((r) => target.close(() => r()))
  await new Promise<void>((r) => socks.close(() => r()))
})

describe('SOCKS5 代理真实回路', () => {
  it('fetch 经 createDispatcher(socks5) 访问目标，流量确实过代理', async () => {
    const before = proxied
    const res = await fetch(
      `http://127.0.0.1:${targetPort}/`,
      withDispatcher({}, createDispatcher(`socks5://127.0.0.1:${socksPort}`))
    )
    const body = await res.text()
    expect(res.status).toBe(200)
    expect(body).toBe('through-proxy-ok')
    // 代理确实中转了这次连接（而不是直连）
    expect(proxied).toBe(before + 1)
  })
})
