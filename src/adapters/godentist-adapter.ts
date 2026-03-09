import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import * as fs from 'fs'
import * as path from 'path'
import type { Credentials, Appointment } from '../types/index.js'

const STORAGE_DIR = path.resolve('storage')
const ARTIFACTS_DIR = path.join(STORAGE_DIR, 'artifacts')

const BASE_URL = 'https://godentist.dentos.co'
const APPOINTMENTS_URL = `${BASE_URL}/citas/index/listcitassimple`

interface Sucursal {
  value: string
  label: string
}

export class GoDentistAdapter {
  private browser: Browser | null = null
  private credentials: Credentials
  private workspaceId: string

  constructor(credentials: Credentials, workspaceId: string) {
    this.credentials = credentials
    this.workspaceId = workspaceId
  }

  // ── Lifecycle ──

  async init(): Promise<void> {
    console.log('[GoDentist] Launching browser...')
    this.browser = await chromium.launch({
      headless: true,
      args: ['--disable-dev-shm-usage', '--no-sandbox', '--disable-gpu'],
    })
    console.log('[GoDentist] Browser ready')
  }

  async close(): Promise<void> {
    try {
      if (this.browser) await this.browser.close()
    } catch (err) {
      console.error('[GoDentist] Error closing browser:', err)
    }
    this.browser = null
    console.log('[GoDentist] Browser closed')
  }

  private async newPage(): Promise<{ context: BrowserContext; page: Page }> {
    if (!this.browser) throw new Error('Browser not initialized')
    const context = await this.browser.newContext({
      viewport: { width: 1280, height: 720 },
    })
    const page = await context.newPage()
    return { context, page }
  }

  // ── Discover Sucursales from Login Page ──

  async discoverSucursales(): Promise<Sucursal[]> {
    const { context, page } = await this.newPage()
    try {
      await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30000 })
      await page.waitForTimeout(2000)

      const sucursalSelect = await page.$('#login-form select') || await page.$('select')
      if (!sucursalSelect) {
        console.error('[GoDentist] No sucursal dropdown found on login page')
        await this.takeScreenshotPage(page, 'no-sucursal-select')
        return []
      }

      const options = await sucursalSelect.$$('option')
      const sucursales: Sucursal[] = []
      for (const opt of options) {
        const val = await opt.getAttribute('value')
        const text = (await opt.textContent())?.trim() || ''
        if (val && val !== '' && val !== '0' && !text.toLowerCase().includes('seleccione')) {
          sucursales.push({ value: val, label: text })
        }
      }

      console.log(`[GoDentist] Sucursales: ${sucursales.map(s => s.label).join(', ')}`)
      return sucursales
    } finally {
      await context.close()
    }
  }

  // ── Login selecting a specific sucursal ──

  async loginWithSucursal(page: Page, sucursalValue: string): Promise<boolean> {
    console.log(`[GoDentist] Logging in with sucursal ${sucursalValue}...`)
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30000 })
    await page.waitForTimeout(2000)

    // Check if already past login
    const currentUrl = page.url()
    if (currentUrl.includes('/dashboard') || currentUrl.includes('/inicio') || currentUrl.includes('/citas')) {
      console.log('[GoDentist] Already logged in')
      return true
    }

    try {
      await page.waitForSelector('#login-form, input.username, input[type="text"]', { timeout: 10000 })

      const usernameField = await page.$('input.username')
        || await page.$('#login-form input[type="text"]')
        || await page.$('input[type="text"]')

      const passwordField = await page.$('input.password')
        || await page.$('#login-form input[type="password"]')
        || await page.$('input[type="password"]')

      if (!usernameField || !passwordField) {
        console.error('[GoDentist] Could not find login form fields')
        await this.takeScreenshotPage(page, 'login-fields-missing')
        return false
      }

      // Fill credentials
      await usernameField.click()
      await usernameField.fill(this.credentials.username)
      await passwordField.click()
      await passwordField.fill(this.credentials.password)

      // Select the target sucursal
      const sucursalSelect = await page.$('#login-form select') || await page.$('select')
      if (sucursalSelect) {
        await sucursalSelect.selectOption(sucursalValue)
      }

      await this.takeScreenshotPage(page, `login-filled-${sucursalValue}`)

      // Submit
      const submitBtn = await page.$('#login-form button[type="submit"]')
        || await page.$('button[type="submit"]')
        || await page.$('input[type="submit"]')
        || await page.$('#login-form button')
        || await page.$('button:has-text("Ingresar")')

      if (submitBtn) {
        await submitBtn.click()
      } else if (passwordField) {
        await passwordField.press('Enter')
      }

      await page.waitForTimeout(5000)
      await this.takeScreenshotPage(page, `after-login-${sucursalValue}`)

      // Verify login — check URL changed or login form gone
      const postLoginUrl = page.url()
      const pageContent = await page.content()
      const success = postLoginUrl !== currentUrl
        || postLoginUrl.includes('/dashboard')
        || postLoginUrl.includes('/inicio')
        || postLoginUrl.includes('/citas')
        || !pageContent.includes('login-form')

      if (success) {
        console.log(`[GoDentist] Login OK for sucursal ${sucursalValue} — URL: ${postLoginUrl}`)
        return true
      }

      console.error(`[GoDentist] Login failed for sucursal ${sucursalValue}`)
      await this.takeScreenshotPage(page, `login-failed-${sucursalValue}`)
      return false
    } catch (err) {
      console.error('[GoDentist] Login error:', err)
      await this.takeScreenshotPage(page, 'login-error')
      return false
    }
  }

  // ── Main: Scrape All Sucursales ──

  async scrapeAppointments(): Promise<{ date: string; appointments: Appointment[]; errors: string[] }> {
    const targetDate = this.getNextWorkingDay()
    const dateStr = this.formatDateForInput(targetDate)
    const dateLabel = targetDate.toISOString().split('T')[0]

    console.log(`[GoDentist] Target date: ${dateLabel}`)

    const allAppointments: Appointment[] = []
    const errors: string[] = []

    // Step 1: Discover sucursales from login dropdown
    const sucursales = await this.discoverSucursales()
    if (sucursales.length === 0) {
      errors.push('No se encontraron sucursales en el login')
      return { date: dateLabel, appointments: allAppointments, errors }
    }

    // Step 2: For each sucursal, login → navigate to citas → scrape
    for (const sucursal of sucursales) {
      const { context, page } = await this.newPage()
      try {
        console.log(`[GoDentist] ── Sucursal: ${sucursal.label} ──`)

        const loggedIn = await this.loginWithSucursal(page, sucursal.value)
        if (!loggedIn) {
          errors.push(`Login fallido para sucursal ${sucursal.label}`)
          continue
        }

        // Navigate to appointments
        await page.goto(APPOINTMENTS_URL, { waitUntil: 'networkidle', timeout: 30000 })
        await page.waitForTimeout(2000)
        await this.takeScreenshotPage(page, `citas-${sucursal.value}`)

        // Set date filter if available
        await this.setDateFilter(page, dateStr)

        // Extract appointments from the table
        const appointments = await this.extractAppointments(page, sucursal.label)
        allAppointments.push(...appointments)
        console.log(`[GoDentist] ${sucursal.label}: ${appointments.length} citas`)

      } catch (err) {
        const msg = `Error en sucursal ${sucursal.label}: ${err instanceof Error ? err.message : String(err)}`
        console.error(`[GoDentist] ${msg}`)
        errors.push(msg)
        await this.takeScreenshotPage(page, `error-${sucursal.value}`)
      } finally {
        await context.close()
      }
    }

    return { date: dateLabel, appointments: allAppointments, errors }
  }

  // ── Date Filter on Appointments Page ──

  private async setDateFilter(page: Page, dateStr: string): Promise<void> {
    // Look for date input on the citas page
    const dateInput = page.locator('input[type="date"], input[name*="fecha"], input[id*="fecha"]').first()
    const exists = await dateInput.count()

    if (exists > 0) {
      await dateInput.fill(dateStr)
      console.log(`[GoDentist] Date filter set to: ${dateStr}`)

      // Look for a search/filter button to apply
      const searchBtn = await page.$('button:has-text("Buscar")')
        || await page.$('button:has-text("Filtrar")')
        || await page.$('button:has-text("Consultar")')
        || await page.$('button[type="submit"]')
        || await page.$('input[type="submit"]')

      if (searchBtn) {
        await searchBtn.click()
        await page.waitForTimeout(3000)
        console.log('[GoDentist] Search/filter applied')
      }

      await this.takeScreenshotPage(page, 'date-filtered')
    } else {
      console.log('[GoDentist] No date input found — using default date shown on page')
    }
  }

  // ── Data Extraction ──

  private async extractAppointments(page: Page, sucursal: string): Promise<Appointment[]> {
    const appointments: Appointment[] = []

    try {
      // Wait for table
      await page.waitForSelector('table, .table, [role="grid"]', { timeout: 10000 })

      // First, log the table headers so we know column positions
      const headers = await page.locator('table thead th, table thead td').allTextContents()
      console.log(`[GoDentist] Table headers: ${headers.map(h => h.trim()).join(' | ')}`)

      const rows = page.locator('table tbody tr')
      const rowCount = await rows.count()
      console.log(`[GoDentist] Table rows: ${rowCount}`)

      if (rowCount === 0) {
        await this.takeScreenshotPage(page, `no-rows-${sucursal}`)
        return []
      }

      // Log first row cells for debugging column mapping
      if (rowCount > 0) {
        const firstRowCells = await rows.first().locator('td').allTextContents()
        console.log(`[GoDentist] First row cells (${firstRowCells.length}): ${firstRowCells.map((c, i) => `[${i}]="${c.trim()}"`).join(', ')}`)
      }

      for (let i = 0; i < rowCount; i++) {
        const row = rows.nth(i)
        const cells = await row.locator('td').allTextContents()
        const cleanCells = cells.map(c => c.trim())

        if (cleanCells.length < 2) continue

        const appointment = this.parseAppointmentFromCells(cleanCells, sucursal)
        if (appointment) {
          appointments.push(appointment)
        }
      }
    } catch (err) {
      console.error(`[GoDentist] Extraction error (${sucursal}):`, err)
      await this.takeScreenshotPage(page, `extraction-error-${sucursal}`)
    }

    return appointments
  }

  private parseAppointmentFromCells(cells: string[], sucursal: string): Appointment | null {
    const cleanCells = cells.filter(c => c.length > 0)
    if (cleanCells.length < 2) return null

    let nombre = ''
    let telefono = ''
    let hora = ''

    for (const cell of cleanCells) {
      // Phone: 10+ digits, or 3XX pattern (Colombian mobile)
      const phoneMatch = cell.match(/(\+?\d{10,}|\b3\d{9}\b)/)
      if (phoneMatch && !telefono) {
        telefono = phoneMatch[1].replace(/\D/g, '')
        if (telefono.length === 10 && telefono.startsWith('3')) {
          telefono = '57' + telefono
        }
        continue
      }

      // Time: HH:MM or H:MM AM/PM
      const timeMatch = cell.match(/\b(\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)?)\b/)
      if (timeMatch && !hora) {
        hora = timeMatch[1].trim()
        continue
      }

      // Name: letters, reasonable length, not a number
      if (!nombre && cell.length > 2 && /[a-zA-ZáéíóúñÁÉÍÓÚÑ]/.test(cell) && !/^\d+$/.test(cell)) {
        nombre = cell
      }
    }

    if (nombre && telefono) {
      return { nombre, telefono, hora, sucursal }
    }

    return null
  }

  // ── Date Helpers ──

  private getNextWorkingDay(): Date {
    const now = new Date()
    const colombiaTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Bogota' }))

    const next = new Date(colombiaTime)
    next.setDate(next.getDate() + 1)

    // Skip Sunday (0)
    while (next.getDay() === 0) {
      next.setDate(next.getDate() + 1)
    }

    return next
  }

  private formatDateForInput(date: Date): string {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  // ── Screenshot Helper ──

  async takeScreenshot(name: string): Promise<void> {
    // No-op if no active page — used by server.ts error handler
    console.log(`[GoDentist] takeScreenshot(${name}) — no active page in new architecture`)
  }

  private async takeScreenshotPage(page: Page, name: string): Promise<void> {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const filePath = path.join(ARTIFACTS_DIR, `${name}-${timestamp}.png`)
      await page.screenshot({ path: filePath, fullPage: true })
      console.log(`[GoDentist] Screenshot: ${filePath}`)
    } catch (err) {
      console.error(`[GoDentist] Screenshot error:`, err)
    }
  }
}
