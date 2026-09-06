import { loadConfig, productionConfigErrors } from './config.ts'
import { buildServer } from './server.ts'
import { brand } from './branding.ts'

const config = loadConfig()
if (config.production) {
  const errors = productionConfigErrors(config)
  if (errors.length) {
    throw new Error(`生产配置不安全：\n- ${errors.join('\n- ')}`)
  }
}
const app = buildServer(config)

app
  .listen({ port: config.port, host: config.host })
  .then((addr) => app.log.info(`${brand.appName} server listening on ${addr}`))
  .catch((err) => {
    app.log.error(err)
    process.exit(1)
  })
