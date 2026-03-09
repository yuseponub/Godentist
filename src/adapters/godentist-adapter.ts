import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import * as fs from 'fs'
import * as path from 'path'
import type { Credentials, Appointment } from '../types/index.js'

const STORAGE_DIR = path.resolve('storage')
const SESSIONS_DIR = path.join(STORAGE_DIR, 'sessions')
const ARTIFACTS_DIR = path.join(STORAGE_DIR, 'artifacts')

const BASE_URL = 'https://godentist.dentos.co'
const APPOINTMENTS_URL = `${BASE_URL}/citas/index/listcitassimple`

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

    // Check if already logged in (redirected to dashboard or has session)
    const currentUrl = this.page.url()
    if (currentUrl.includes('/dashboard') || currentUrl.includes('/inicio')) {
      console.log('[GoDentist] Already logged in')
      await this.saveCookies()
      return true
    }

    await this.takeScreenshot('login-page')

    try {
      // Wait for login form fields
      await this.page.waitForSelector('input[name="username"], input[name="usuario"], input[type="text"]', { timeout: 10000 })

      // Try to find username/password fields
      const usernameField = await this.page.$('input[name="username"]')
        || await this.page.$('input[name="usuario"]')
        || await this.page.$('input[type="text"]')

      const passwordField = await this.page.$('input[name="password"]')
        || await this.page.$('input[name="clave"]')
        || await this.page.$('input[type="password"]')

      if (!usernameField || !passwordField) {
        console.error('[GoDentist] Could not find login form fields')
        await this.takeScreenshot('login-fields-missing')
        return false
      }

      await usernameField.fill(this.credentials.username)
      await passwordField.fill(this.credentials.password)
      await this.takeScreenshot('login-filled')

      // Find and click submit button
      const submitBtn = await this.page.$('button[type="submit"]')
        || await this.page.$('input[type="submit"]')
        || await this.page.$('button:has-text("Ingresar")')
        || await this.page.$('button:has-text("Entrar")')
        || await this.page.$('button:has-text("Login")')

      if (submitBtn) {
        await submitBtn.click()
      } else {
        // Try pressing Enter on the password field
        await passwordField.press('Enter')
      }

      await this.page.waitForTimeout(5000)
      await this.takeScreenshot('after-login')

      // Verify login success - check we're no longer on login page
      const postLoginUrl = this.page.url()
      const loginSuccess = postLoginUrl !== currentUrl
        || postLoginUrl.includes('/dashboard')
        || postLoginUrl.includes('/inicio')
        || postLoginUrl.includes('/citas')

      if (loginSuccess) {
        console.log('[GoDentist] Login successful')
        await this.saveCookies()
        return true
      }

      console.error('[GoDentist] Login failed - still on login page')
      await this.takeScreenshot('login-failed')
      return false
    } catch (err) {
      console.error('[GoDentist] Login error:', err)
      await this.takeScreenshot('login-error')
      return false
    }
  }

  // ── Scrape Appointments ──

  async scrapeAppointments(): Promise<{ date: string; appointments: Appointment[]; errors: string[] }> {
    if (!this.page) throw new Error('Browser not initialized')

    const targetDate = this.getNextWorkingDay()
    const dateStr = this.formatDateForInput(targetDate)
    const dateLabel = targetDate.toISOString().split('T')[0]

    console.log(`[GoDentist] Scraping appointments for ${dateLabel}...`)

    const allAppointments: Appointment[] = []
    const errors: string[] = []

    // Navigate to appointments page
    await this.page.goto(APPOINTMENTS_URL, { waitUntil: 'networkidle', timeout: 30000 })
    await this.page.waitForTimeout(2000)
    await this.takeScreenshot('appointments-page')

    // Discover available branches (sucursales)
    const branches = await this.discoverBranches()
    console.log(`[GoDentist] Found ${branches.length} branches: ${branches.map(b => b.label).join(', ')}`)

    if (branches.length === 0) {
      errors.push('No se encontraron sucursales en el dropdown')
      return { date: dateLabel, appointments: allAppointments, errors }
    }

    // Iterate through each branch
    for (const branch of branches) {
      try {
        console.log(`[GoDentist] Scraping branch: ${branch.label}...`)
        const branchAppointments = await this.scrapeBranch(branch, dateStr, dateLabel)
        allAppointments.push(...branchAppointments)
        console.log(`[GoDentist] Branch ${branch.label}: ${branchAppointments.length} appointments`)
      } catch (err) {
        const errorMsg = `Error scraping branch ${branch.label}: ${err instanceof Error ? err.message : String(err)}`
        console.error(`[GoDentist] ${errorMsg}`)
        errors.push(errorMsg)
        await this.takeScreenshot(`error-branch-${branch.value}`)
      }
    }

    return { date: dateLabel, appointments: allAppointments, errors }
  }

  // ── Branch Discovery ──

  private async discoverBranches(): Promise<Array<{ value: string; label: string }>> {
    if (!this.page) return []

    try {
      // Look for branch/sucursal dropdown
      const selectLocator = this.page.locator('select[name*="sucursal"], select[name*="sede"], select[name*="branch"], select[id*="sucursal"], select[id*="sede"]')
      const selectCount = await selectLocator.count()

      if (selectCount === 0) {
        // Try to find any select element and check its options
        const allSelects = this.page.locator('select')
        const count = await allSelects.count()
        console.log(`[GoDentist] No branch select found by name, checking ${count} selects...`)

        for (let i = 0; i < count; i++) {
          const select = allSelects.nth(i)
          const options = await select.locator('option').allTextContents()
          console.log(`[GoDentist] Select ${i}: ${options.join(', ')}`)
        }

        await this.takeScreenshot('no-branch-select')
        return []
      }

      const select = selectLocator.first()
      const options = await select.locator('option').all()
      const branches: Array<{ value: string; label: string }> = []

      for (const option of options) {
        const value = await option.getAttribute('value')
        const label = (await option.textContent())?.trim() || ''
        // Skip empty/placeholder options
        if (value && value !== '' && value !== '0' && label && !label.toLowerCase().includes('seleccione') && !label.toLowerCase().includes('todos')) {
          branches.push({ value, label })
        }
      }

      return branches
    } catch (err) {
      console.error('[GoDentist] Error discovering branches:', err)
      await this.takeScreenshot('branch-discovery-error')
      return []
    }
  }

  // ── Scrape Single Branch ──

  private async scrapeBranch(
    branch: { value: string; label: string },
    dateStr: string,
    dateLabel: string
  ): Promise<Appointment[]> {
    if (!this.page) return []

    // Navigate fresh to appointments page for each branch
    await this.page.goto(APPOINTMENTS_URL, { waitUntil: 'networkidle', timeout: 30000 })
    await this.page.waitForTimeout(1500)

    // 1. Select branch
    const branchSelect = this.page.locator('select[name*="sucursal"], select[name*="sede"], select[name*="branch"], select[id*="sucursal"], select[id*="sede"]').first()
    await branchSelect.selectOption(branch.value)
    await this.page.waitForTimeout(500)

    // 2. Set date to next working day
    await this.setDateField(dateStr)

    // 3. Set time to minimum (5:00 AM)
    await this.setTimeField('05:00')

    await this.takeScreenshot(`branch-${branch.value}-configured`)

    // 4. Submit/search
    await this.clickSearch()
    await this.page.waitForTimeout(3000)
    await this.takeScreenshot(`branch-${branch.value}-results`)

    // 5. Extract appointments from results table
    const appointments = await this.extractAppointments(branch.label)

    return appointments
  }

  // ── Form Helpers ──

  private async setDateField(dateStr: string): Promise<void> {
    if (!this.page) return

    // Try various date input selectors
    const dateInput = this.page.locator('input[type="date"], input[name*="fecha"], input[id*="fecha"]').first()
    const exists = await dateInput.count()

    if (exists > 0) {
      await dateInput.fill(dateStr)
      console.log(`[GoDentist] Date set to: ${dateStr}`)
    } else {
      console.warn('[GoDentist] Date input not found, trying text input...')
      // Some systems use text inputs for dates
      const textInputs = this.page.locator('input[type="text"]')
      const count = await textInputs.count()
      for (let i = 0; i < count; i++) {
        const placeholder = await textInputs.nth(i).getAttribute('placeholder')
        if (placeholder && (placeholder.includes('fecha') || placeholder.includes('date') || placeholder.includes('dd/mm'))) {
          await textInputs.nth(i).fill(dateStr)
          break
        }
      }
    }
  }

  private async setTimeField(time: string): Promise<void> {
    if (!this.page) return

    // Try time input or hour dropdown
    const timeInput = this.page.locator('input[type="time"], input[name*="hora"], select[name*="hora"], select[id*="hora"]').first()
    const exists = await timeInput.count()

    if (exists > 0) {
      const tagName = await timeInput.evaluate(el => el.tagName.toLowerCase())
      if (tagName === 'select') {
        // Find the earliest option
        const options = await timeInput.locator('option').all()
        if (options.length > 0) {
          const firstValue = await options[0].getAttribute('value')
          if (firstValue) {
            await timeInput.selectOption(firstValue)
            console.log(`[GoDentist] Time set to first option: ${firstValue}`)
          }
        }
      } else {
        await timeInput.fill(time)
        console.log(`[GoDentist] Time set to: ${time}`)
      }
    } else {
      console.warn('[GoDentist] Time input not found')
    }
  }

  private async clickSearch(): Promise<void> {
    if (!this.page) return

    // Try various search/filter buttons
    const searchBtn = await this.page.$('button:has-text("Buscar")')
      || await this.page.$('button:has-text("Filtrar")')
      || await this.page.$('button:has-text("Consultar")')
      || await this.page.$('button[type="submit"]')
      || await this.page.$('input[type="submit"]')

    if (searchBtn) {
      await searchBtn.click()
      console.log('[GoDentist] Search clicked')
    } else {
      console.warn('[GoDentist] Search button not found, trying Enter...')
      await this.page.keyboard.press('Enter')
    }
  }

  // ── Data Extraction ──

  private async extractAppointments(sucursal: string): Promise<Appointment[]> {
    if (!this.page) return []

    const appointments: Appointment[] = []

    try {
      // Wait for results table to appear
      await this.page.waitForSelector('table, .table, [role="grid"], .data-table', { timeout: 10000 })

      // Try standard HTML table first
      const rows = this.page.locator('table tbody tr, .table tbody tr')
      const rowCount = await rows.count()
      console.log(`[GoDentist] Found ${rowCount} table rows`)

      if (rowCount === 0) {
        // Try alternative: div-based tables or lists
        const altRows = this.page.locator('[role="row"], .appointment-row, .cita-row')
        const altCount = await altRows.count()
        console.log(`[GoDentist] Alternative rows: ${altCount}`)

        if (altCount === 0) {
          await this.takeScreenshot(`no-results-${sucursal}`)
          return []
        }

        for (let i = 0; i < altCount; i++) {
          const row = altRows.nth(i)
          const cells = await row.locator('[role="cell"], td, .cell').allTextContents()
          const appointment = this.parseAppointmentFromCells(cells, sucursal)
          if (appointment) appointments.push(appointment)
        }
        return appointments
      }

      // Parse standard table rows
      for (let i = 0; i < rowCount; i++) {
        const row = rows.nth(i)
        const cells = await row.locator('td').allTextContents()

        if (cells.length < 2) continue // Skip empty or header-like rows

        const appointment = this.parseAppointmentFromCells(cells, sucursal)
        if (appointment) {
          appointments.push(appointment)
        }
      }
    } catch (err) {
      console.error(`[GoDentist] Error extracting appointments for ${sucursal}:`, err)
      await this.takeScreenshot(`extraction-error-${sucursal}`)
    }

    return appointments
  }

  private parseAppointmentFromCells(cells: string[], sucursal: string): Appointment | null {
    // Clean cell values
    const cleanCells = cells.map(c => c.trim()).filter(c => c.length > 0)

    if (cleanCells.length < 2) return null

    // We need to discover column positions from the data
    // Look for phone-like patterns (10+ digits) and time-like patterns (HH:MM)
    let nombre = ''
    let telefono = ''
    let hora = ''

    for (const cell of cleanCells) {
      // Phone: 10+ digits, or starts with +57, or 3XX pattern
      const phoneMatch = cell.match(/(\+?\d{10,}|\b3\d{9}\b)/)
      if (phoneMatch && !telefono) {
        telefono = phoneMatch[1].replace(/\D/g, '')
        // Ensure Colombian format
        if (telefono.length === 10 && telefono.startsWith('3')) {
          telefono = '57' + telefono
        }
        continue
      }

      // Time: HH:MM pattern
      const timeMatch = cell.match(/\b(\d{1,2}:\d{2})\b/)
      if (timeMatch && !hora) {
        hora = timeMatch[1]
        continue
      }

      // Name: text with letters, no digits, reasonable length
      if (!nombre && cell.length > 2 && /[a-zA-ZáéíóúñÁÉÍÓÚÑ]/.test(cell) && !/^\d+$/.test(cell)) {
        nombre = cell
      }
    }

    // Only return if we have at least a name and phone
    if (nombre && telefono) {
      return { nombre, telefono, hora, sucursal }
    }

    return null
  }

  // ── Date Helpers ──

  private getNextWorkingDay(): Date {
    const now = new Date()
    // Use Colombia timezone
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

  // ── Storage Helpers ──

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
