import { createServer, connect, type Server, type Socket } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openKakaoProxySocket } from './loco-client'

let target: Server
let targetPort = 0
let socks: Server
let socksPort = 0
let httpProxy: Server
let httpProxyPort = 0
let socksConnections = 0
let httpConnections = 0

beforeAll(async () => {
  target = createServer((socket) => {
    socket.on('data', (data) => socket.write(Buffer.concat([Buffer.from('reply:'), data])))
  })
  await listen(target)
  targetPort = addressPort(target)

  socks = createServer(handleSocks)
  await listen(socks)
  socksPort = addressPort(socks)

  httpProxy = createServer(handleHttpConnect)
  await listen(httpProxy)
  httpProxyPort = addressPort(httpProxy)
})

afterAll(async () => {
  await Promise.all([close(target), close(socks), close(httpProxy)])
})

describe('KakaoTalk 原始长连接代理', () => {
  it('SOCKS5 代理承载双向字节流', async () => {
    const before = socksConnections
    const socket = await openKakaoProxySocket(
      `socks5://127.0.0.1:${socksPort}`,
      '127.0.0.1',
      targetPort
    )
    await expect(roundTrip(socket, 'socks')).resolves.toBe('reply:socks')
    expect(socksConnections).toBe(before + 1)
    socket.destroy()
  })

  it('HTTP CONNECT 代理承载双向字节流', async () => {
    const before = httpConnections
    const socket = await openKakaoProxySocket(
      `http://127.0.0.1:${httpProxyPort}`,
      '127.0.0.1',
      targetPort
    )
    await expect(roundTrip(socket, 'http')).resolves.toBe('reply:http')
    expect(httpConnections).toBe(before + 1)
    socket.destroy()
  })
})

function handleSocks(client: Socket): void {
  client.once('data', () => {
    client.write(Buffer.from([0x05, 0x00]))
    client.once('data', (request: Buffer) => {
      const atyp = request[3]
      let host: string
      let port: number
      if (atyp === 0x01) {
        host = `${request[4]}.${request[5]}.${request[6]}.${request[7]}`
        port = request.readUInt16BE(8)
      } else if (atyp === 0x03) {
        const length = request[4]!
        host = request.subarray(5, 5 + length).toString()
        port = request.readUInt16BE(5 + length)
      } else {
        client.destroy()
        return
      }
      const upstream = connect(port, host, () => {
        socksConnections += 1
        client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
        client.pipe(upstream)
        upstream.pipe(client)
      })
      upstream.on('error', () => client.destroy())
    })
  })
  client.on('error', () => undefined)
}

function handleHttpConnect(client: Socket): void {
  client.once('data', (request: Buffer) => {
    const firstLine = request.toString('latin1').split('\r\n', 1)[0] ?? ''
    const match = /^CONNECT\s+([^:]+):(\d+)\s+HTTP\//i.exec(firstLine)
    if (!match) {
      client.destroy()
      return
    }
    const upstream = connect(Number(match[2]), match[1], () => {
      httpConnections += 1
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      client.pipe(upstream)
      upstream.pipe(client)
    })
    upstream.on('error', () => client.destroy())
  })
  client.on('error', () => undefined)
}

function roundTrip(socket: Socket, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once('data', (data) => resolve(data.toString()))
    socket.once('error', reject)
    socket.write(payload)
  })
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

function addressPort(server: Server): number {
  return (server.address() as { port: number }).port
}
