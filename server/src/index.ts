import { loadConfig } from './config.ts'
import { buildServer } from './server.ts'
import { brand } from './branding.ts'

const config = loadConfig()
const app = buildServer(config)

app
  .listen({ port: config.port, host: config.host })
  .then((addr) => app.log.info(`${brand.appName} server listening on ${addr}`))
  .catch((err) => {
    app.log.error(err)
    process.exit(1)
  })
