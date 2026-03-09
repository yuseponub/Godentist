import { createServer } from './api/server.js'

const PORT = parseInt(process.env.PORT || '8080', 10)
const app = createServer()

app.listen(PORT, () => {
  console.log(`[Robot GoDentist] Server running on port ${PORT}`)
  console.log(`[Robot GoDentist] Health check: http://localhost:${PORT}/api/health`)
})

// Graceful shutdown
const shutdown = () => {
  console.log('[Robot GoDentist] Shutting down...')
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
