import express from 'express'
import * as fs from 'fs'
import * as path from 'path'
import { GoDentistAdapter } from '../adapters/godentist-adapter.js'
import type { ScrapeAppointmentsRequest, ScrapeAppointmentsResponse, HealthResponse } from '../types/index.js'

const ARTIFACTS_DIR = path.resolve('storage/artifacts')

// Track active jobs to prevent concurrent scraping
let activeJob: string | null = null

export function createServer() {
  const app = express()
  app.use(express.json())

  // ── Health Check ──
  app.get('/api/health', (_req, res) => {
    const response: HealthResponse = {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    }
    res.json(response)
  })

  // ── Scrape Appointments ──
  app.post('/api/scrape-appointments', async (req, res) => {
    const body = req.body as ScrapeAppointmentsRequest

    // Validate request
    if (!body.workspaceId) {
      res.status(400).json({ success: false, error: 'workspaceId is required' })
      return
    }
    if (!body.credentials?.username || !body.credentials?.password) {
      res.status(400).json({ success: false, error: 'credentials (username, password) are required' })
      return
    }

    // Prevent concurrent scraping
    if (activeJob) {
      res.status(409).json({ success: false, error: 'Another scraping job is in progress' })
      return
    }

    activeJob = body.workspaceId

    const adapter = new GoDentistAdapter(body.credentials, body.workspaceId)

    try {
      await adapter.init()

      const loginOk = await adapter.login()
      if (!loginOk) {
        res.status(401).json({ success: false, error: 'Login failed. Check credentials.' })
        return
      }

      const result = await adapter.scrapeAppointments()

      const response: ScrapeAppointmentsResponse = {
        success: true,
        date: result.date,
        totalAppointments: result.appointments.length,
        appointments: result.appointments,
        errors: result.errors.length > 0 ? result.errors : undefined,
      }

      res.json(response)
    } catch (err) {
      console.error('[Server] Scrape error:', err)
      await adapter.takeScreenshot('server-error')
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      await adapter.close()
      activeJob = null
    }
  })

  // ── Debug Screenshots ──
  app.get('/api/screenshots', (_req, res) => {
    try {
      if (!fs.existsSync(ARTIFACTS_DIR)) {
        res.json({ files: [] })
        return
      }
      const files = fs.readdirSync(ARTIFACTS_DIR)
        .filter(f => f.endsWith('.png'))
        .sort((a, b) => b.localeCompare(a))
        .slice(0, 20)
      res.json({ files })
    } catch (err) {
      res.status(500).json({ error: 'Failed to list screenshots' })
    }
  })

  app.get('/api/screenshots/:name', (req, res) => {
    const filePath = path.join(ARTIFACTS_DIR, req.params.name)
    if (!filePath.startsWith(ARTIFACTS_DIR)) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'Screenshot not found' })
      return
    }
    res.sendFile(filePath)
  })

  return app
}
