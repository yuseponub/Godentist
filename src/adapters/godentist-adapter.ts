import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import * as fs from 'fs'
import * as path from 'path'
import type { Credentials, Appointment } from '../types/index.js'

const STORAGE_DIR = path.resolve('storage')
const SESSIONS_DIR = path.join(STORAGE_DIR, 'sessions')
const ARTIFACTS_DIR = path.join(STORAGE_DIR, 'artifacts')

const BASE_URL = 'https://godentist.dentos.co'
const APPOINTMENTS_URL = `${BASE_URL}/citas/index/listcitassimple`

interface Sucursal {
  value: string
  label: string
}

export class GoDentistAdapter {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private page: Page | null = null
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
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 720 },
    })
    this.page = await this.context.newPage()
    await this.loadCookies()
    console.log('[GoDentist] Browser ready')
  }

  async close(): Promise<void> {
    try {
      if (this.page) await this.page.close()
      if (this.context) await this.context.close()
      if (this.browser) await this.browser.close()
    } catch (err) {
      console.error('[GoDentist] Error closing browser:', err)
    }
    this.page = null
    this.context = null
    this.browser = null
    console.log('[GoDentist] Browser closed')
  }

  // ── Login ──

  async login(): Promise<boolean> {
    if (!this.page) throw new Error('Browser not initialized')

    console.log('[GoDentist] Navigating to login...')
    await this.page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30000 })
    await this.page.waitForTimeout(2000)

    const currentUrl = this.page.url()
    if (currentUrl.includes('/dashboard') || currentUrl.includes('/inicio') || currentUrl.includes('/citas')) {
      console.log('[GoDentist] Already logged in')
      await this.saveCookies()
      return true
    }

    await this.takeScreenshot('login-page')

    try {
      await this.page.waitForSelector('#login-form, input.username, input[type="text"]', { timeout: 10000 })

      const usernameField = await this.page.$('input.username')
        || await this.page.$('#login-form input[type="text"]')
        || await this.page.$('input[type="text"]')

      const passwordField = await this.page.$('input.password')
        || await this.page.$('#login-form input[type="password"]')
        || await this.page.$('input[type="password"]')

      if (!usernameField || !passwordField) {
        console.error('[GoDentist] Could not find login form fields')
        await this.takeScreenshot('login-fields-missing')
        return false
      }

      await usernameField.click()
      await usernameField.fill(this.credentials.username)
      await passwordField.click()
      await passwordField.fill(this.credentials.password)

      // Select first sucursal (required by validation)
      const sucursalSelect = await this.page.$('#login-form select') || await this.page.$('select')
      if (sucursalSelect) {
        const options = await sucursalSelect.$$('option')
        for (const opt of options) {
          const val = await opt.getAttribute('value')
          const text = (await opt.textContent())?.trim() || ''
          if (val && val !== '' && val !== '0' && !text.toLowerCase().includes('seleccione')) {
            await sucursalSelect.selectOption(val)
            console.log(`[GoDentist] Login sucursal: ${text}`)
            break
          }
        }
      }

      await this.takeScreenshot('login-filled')

      const submitBtn = await this.page.$('#login-form button[type="submit"]')
        || await this.page.$('button[type="submit"]')
        || await this.page.$('input[type="submit"]')
        || await this.page.$('#login-form button')
        || await this.page.$('button:has-text("Ingresar")')

      if (submitBtn) {
        await submitBtn.click()
      } else {
        await passwordField.press('Enter')
      }

      await this.page.waitForTimeout(5000)
      await this.takeScreenshot('after-login')

      const postLoginUrl = this.page.url()
      const pageContent = await this.page.content()
      const success = postLoginUrl !== currentUrl
        || postLoginUrl.includes('/dashboard')
        || postLoginUrl.includes('/inicio')
        || postLoginUrl.includes('/citas')
        || !pageContent.includes('login-form')

      if (success) {
        console.log(`[GoDentist] Login OK — URL: ${postLoginUrl}`)
        await this.saveCookies()
        return true
      }

      console.error('[GoDentist] Login failed')
      await this.takeScreenshot('login-failed')
      return false
    } catch (err) {
      console.error('[GoDentist] Login error:', err)
      await this.takeScreenshot('login-error')
      return false
    }
  }

  // ── Scrape: diagnostic version to discover page controls ──

  async scrapeAppointments(): Promise<{ date: string; appointments: Appointment[]; errors: string[] }> {
    if (!this.page) throw new Error('Browser not initialized')

    const targetDate = this.getNextWorkingDay()
    const dateStr = this.formatDateForInput(targetDate)
    const dateLabel = targetDate.toISOString().split('T')[0]

    console.log(`[GoDentist] Target date: ${dateLabel}`)

    const allAppointments: Appointment[] = []
    const errors: string[] = []

    // Navigate to appointments page
    await this.page.goto(APPOINTMENTS_URL, { waitUntil: 'networkidle', timeout: 30000 })
    await this.page.waitForTimeout(2000)
    await this.takeScreenshot('citas-page')

    // ── DIAGNOSTIC: Log ALL selects, inputs, and buttons on the page ──
    const diagnostics = await this.page.evaluate(() => {
      const result: Record<string, unknown[]> = { selects: [], inputs: [], buttons: [] }

      document.querySelectorAll('select').forEach((sel, i) => {
        const opts = Array.from(sel.options).map(o => ({ value: o.value, text: o.text.trim() }))
        result.selects.push({
          index: i,
          id: sel.id,
          name: sel.name,
          className: sel.className,
          optionCount: opts.length,
          options: opts.slice(0, 15), // first 15 options
        })
      })

      document.querySelectorAll('input').forEach((inp, i) => {
        result.inputs.push({
          index: i,
          type: inp.type,
          id: inp.id,
          name: inp.name,
          className: inp.className,
          placeholder: inp.placeholder,
          value: inp.value,
        })
      })

      document.querySelectorAll('button, input[type="submit"]').forEach((btn, i) => {
        result.buttons.push({
          index: i,
          tag: btn.tagName,
          type: (btn as HTMLButtonElement).type,
          id: btn.id,
          className: btn.className,
          text: btn.textContent?.trim().substring(0, 50),
        })
      })

      return result
    })

    console.log('[GoDentist] ── PAGE DIAGNOSTICS ──')
    console.log(`[GoDentist] SELECTS (${(diagnostics.selects as unknown[]).length}):`)
    for (const sel of diagnostics.selects as Array<Record<string, unknown>>) {
      console.log(`  [${sel.index}] id="${sel.id}" name="${sel.name}" class="${sel.className}" options=${sel.optionCount}`)
      const opts = sel.options as Array<{ value: string; text: string }>
      for (const opt of opts) {
        console.log(`    - value="${opt.value}" text="${opt.text}"`)
      }
    }
    console.log(`[GoDentist] INPUTS (${(diagnostics.inputs as unknown[]).length}):`)
    for (const inp of diagnostics.inputs as Array<Record<string, unknown>>) {
      console.log(`  [${inp.index}] type="${inp.type}" id="${inp.id}" name="${inp.name}" class="${inp.className}" placeholder="${inp.placeholder}" value="${inp.value}"`)
    }
    console.log(`[GoDentist] BUTTONS (${(diagnostics.buttons as unknown[]).length}):`)
    for (const btn of diagnostics.buttons as Array<Record<string, unknown>>) {
      console.log(`  [${btn.index}] <${btn.tag}> type="${btn.type}" id="${btn.id}" text="${btn.text}"`)
    }

    // Also log table headers
    const headers = await this.page.locator('table thead th, table thead td').allTextContents()
    console.log(`[GoDentist] TABLE HEADERS: ${headers.map(h => h.trim()).join(' | ')}`)

    const rowCount = await this.page.locator('table tbody tr').count()
    console.log(`[GoDentist] TABLE ROWS: ${rowCount}`)

    if (rowCount > 0) {
      const firstRowCells = await this.page.locator('table tbody tr').first().locator('td').allTextContents()
      console.log(`[GoDentist] FIRST ROW: ${firstRowCells.map((c, i) => `[${i}]="${c.trim()}"`).join(', ')}`)
    }

    // Return diagnostic info as errors so we can see it in the response
    errors.push(`DIAGNOSTIC: ${(diagnostics.selects as unknown[]).length} selects, ${(diagnostics.inputs as unknown[]).length} inputs, ${(diagnostics.buttons as unknown[]).length} buttons, ${rowCount} table rows`)
    errors.push(`SELECTS: ${JSON.stringify(diagnostics.selects)}`)
    errors.push(`INPUTS: ${JSON.stringify(diagnostics.inputs)}`)
    errors.push(`HEADERS: ${headers.map(h => h.trim()).join(' | ')}`)

    if (rowCount > 0) {
      const firstRowCells = await this.page.locator('table tbody tr').first().locator('td').allTextContents()
      errors.push(`FIRST_ROW: ${firstRowCells.map((c, i) => `[${i}]="${c.trim()}"`).join(', ')}`)
    }

    return { date: dateLabel, appointments: allAppointments, errors }
  }

  // ── Date Helpers ──

  private getNextWorkingDay(): Date {
    const now = new Date()
    const colombiaTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Bogota' }))
    const next = new Date(colombiaTime)
    next.setDate(next.getDate() + 1)
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

  // ── Screenshot / Cookies ──

  async takeScreenshot(name: string): Promise<void> {
    if (!this.page) return
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const filePath = path.join(ARTIFACTS_DIR, `${name}-${timestamp}.png`)
      await this.page.screenshot({ path: filePath, fullPage: true })
      console.log(`[GoDentist] Screenshot: ${filePath}`)
    } catch (err) {
      console.error(`[GoDentist] Screenshot error:`, err)
    }
  }

  private async saveCookies(): Promise<void> {
    if (!this.context) return
    try {
      const cookies = await this.context.cookies()
      const filePath = path.join(SESSIONS_DIR, `${this.workspaceId}-cookies.json`)
      fs.writeFileSync(filePath, JSON.stringify(cookies, null, 2))
    } catch (err) {
      console.error('[GoDentist] Error saving cookies:', err)
    }
  }

  private async loadCookies(): Promise<void> {
    if (!this.context) return
    try {
      const filePath = path.join(SESSIONS_DIR, `${this.workspaceId}-cookies.json`)
      if (fs.existsSync(filePath)) {
        const cookies = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
        await this.context.addCookies(cookies)
        console.log('[GoDentist] Cookies loaded')
      }
    } catch (err) {
      console.error('[GoDentist] Error loading cookies:', err)
    }
  }
}
