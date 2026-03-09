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

      // Select first sucursal (required by login validation)
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

  // ── Scrape All Sucursales ──

  async scrapeAppointments(): Promise<{ date: string; appointments: Appointment[]; errors: string[] }> {
    if (!this.page) throw new Error('Browser not initialized')

    const targetDate = this.getNextWorkingDay()
    const dateStr = this.formatDateDD_MM_YYYY(targetDate)
    const dateLabel = this.formatDateYYYY_MM_DD(targetDate)

    console.log(`[GoDentist] Target date: ${dateLabel} (${dateStr})`)

    const allAppointments: Appointment[] = []
    const errors: string[] = []

    // Navigate to appointments page
    await this.page.goto(APPOINTMENTS_URL, { waitUntil: 'networkidle', timeout: 30000 })
    await this.page.waitForTimeout(2000)

    // Step 1: Set date filter (DD-MM-YYYY format for ExtJS)
    await this.setDate(dateStr)

    // Step 2: Set hour to 6:00 am (earliest)
    await this.setHour('6:00 am')

    // Step 3: Discover sucursales from the ExtJS combo
    const sucursales = await this.discoverSucursales()
    console.log(`[GoDentist] Found ${sucursales.length} sucursales: ${sucursales.map(s => s.label).join(', ')}`)

    if (sucursales.length === 0) {
      // If we can't discover, just scrape current view
      console.log('[GoDentist] No sucursales discovered, scraping current view...')
      await this.clickBuscar()
      await this.page.waitForTimeout(3000)
      const currentSucursal = await this.page.$eval('#ext-comp-1051', el => (el as HTMLInputElement).value).catch(() => 'Desconocida')
      const appointments = await this.extractAppointments(currentSucursal)
      allAppointments.push(...appointments)
      if (appointments.length === 0) {
        errors.push('No se pudieron descubrir sucursales ni extraer citas')
      }
      return { date: dateLabel, appointments: allAppointments, errors }
    }

    // Step 4: Iterate each sucursal
    for (const sucursal of sucursales) {
      try {
        console.log(`[GoDentist] ── Sucursal: ${sucursal.label} ──`)
        await this.selectSucursal(sucursal)
        await this.clickBuscar()
        await this.page.waitForTimeout(3000)
        await this.takeScreenshot(`citas-${sucursal.label.replace(/\s+/g, '-').toLowerCase()}`)

        const appointments = await this.extractAppointments(sucursal.label)
        allAppointments.push(...appointments)
        console.log(`[GoDentist] ${sucursal.label}: ${appointments.length} citas`)
      } catch (err) {
        const msg = `Error en ${sucursal.label}: ${err instanceof Error ? err.message : String(err)}`
        console.error(`[GoDentist] ${msg}`)
        errors.push(msg)
      }
    }

    return { date: dateLabel, appointments: allAppointments, errors }
  }

  // ── ExtJS Form Controls ──

  private async setDate(dateStr: string): Promise<void> {
    if (!this.page) return
    // #df_fecha is a text input with DD-MM-YYYY format
    const dateInput = this.page.locator('#df_fecha')
    await dateInput.click({ clickCount: 3 }) // select all
    await dateInput.fill(dateStr)
    await dateInput.press('Tab') // trigger ExtJS change event
    console.log(`[GoDentist] Date set: ${dateStr}`)
  }

  private async setHour(hour: string): Promise<void> {
    if (!this.page) return
    // Set both the hidden field and the visible combo
    await this.page.evaluate((h) => {
      const hidden = document.getElementById('idhoras') as HTMLInputElement
      if (hidden) hidden.value = h
    }, hour)

    // Click and type in the visible hour field
    const hourInput = this.page.locator('#ext-comp-1089')
    const exists = await hourInput.count()
    if (exists > 0) {
      await hourInput.click({ clickCount: 3 })
      await hourInput.fill(hour)
      await hourInput.press('Tab')
      console.log(`[GoDentist] Hour set: ${hour}`)
    }
  }

  private async discoverSucursales(): Promise<Sucursal[]> {
    if (!this.page) return []

    try {
      // The sucursal combo is #ext-comp-1051 — it's an ExtJS ComboBox
      // Click the trigger arrow to open the dropdown list
      const comboInput = this.page.locator('#ext-comp-1051')
      const exists = await comboInput.count()
      if (exists === 0) {
        console.error('[GoDentist] Sucursal combo #ext-comp-1051 not found')
        return []
      }

      // Click the trigger button (arrow) next to the combo to open dropdown
      // ExtJS combos have a sibling trigger element
      const trigger = this.page.locator('#ext-comp-1051').locator('..').locator('.x-form-trigger')
      const triggerExists = await trigger.count()

      if (triggerExists > 0) {
        await trigger.click()
      } else {
        // Fallback: click the input itself
        await comboInput.click()
      }

      await this.page.waitForTimeout(1000)
      await this.takeScreenshot('sucursal-dropdown-open')

      // ExtJS dropdown items appear in a floating div with class x-combo-list or x-layer
      // Items are usually in div.x-combo-list-item
      const items = this.page.locator('.x-combo-list-item')
      const count = await items.count()
      console.log(`[GoDentist] Dropdown items found: ${count}`)

      if (count === 0) {
        // Try alternative selectors for ExtJS dropdown
        const altItems = this.page.locator('.x-combo-list .x-combo-list-inner div')
        const altCount = await altItems.count()
        console.log(`[GoDentist] Alt dropdown items: ${altCount}`)

        if (altCount === 0) {
          // Log what's visible for debugging
          const floatingDivs = await this.page.evaluate(() => {
            const divs = document.querySelectorAll('.x-layer, .x-combo-list, [style*="visibility: visible"]')
            return Array.from(divs).map(d => ({
              tag: d.tagName,
              className: d.className,
              childCount: d.children.length,
              text: d.textContent?.substring(0, 200),
            }))
          })
          console.log(`[GoDentist] Floating divs: ${JSON.stringify(floatingDivs)}`)
          return []
        }

        const sucursales: Sucursal[] = []
        for (let i = 0; i < altCount; i++) {
          const text = (await altItems.nth(i).textContent())?.trim() || ''
          if (text && !text.toLowerCase().includes('seleccione')) {
            sucursales.push({ value: text, label: text })
          }
        }
        // Close dropdown
        await this.page.keyboard.press('Escape')
        return sucursales
      }

      const sucursales: Sucursal[] = []
      for (let i = 0; i < count; i++) {
        const text = (await items.nth(i).textContent())?.trim() || ''
        if (text && !text.toLowerCase().includes('seleccione')) {
          sucursales.push({ value: text, label: text })
        }
      }

      // Close dropdown by pressing Escape
      await this.page.keyboard.press('Escape')
      await this.page.waitForTimeout(300)

      return sucursales
    } catch (err) {
      console.error('[GoDentist] Error discovering sucursales:', err)
      return []
    }
  }

  private async selectSucursal(sucursal: Sucursal): Promise<void> {
    if (!this.page) return

    // Open the dropdown
    const trigger = this.page.locator('#ext-comp-1051').locator('..').locator('.x-form-trigger')
    const triggerExists = await trigger.count()

    if (triggerExists > 0) {
      await trigger.click()
    } else {
      await this.page.locator('#ext-comp-1051').click()
    }

    await this.page.waitForTimeout(800)

    // Click the matching item
    const item = this.page.locator(`.x-combo-list-item:has-text("${sucursal.label}")`)
    const exists = await item.count()
    if (exists > 0) {
      await item.click()
      console.log(`[GoDentist] Sucursal selected: ${sucursal.label}`)
    } else {
      // Fallback: set value directly
      await this.page.evaluate((label) => {
        const input = document.getElementById('ext-comp-1051') as HTMLInputElement
        if (input) input.value = label
      }, sucursal.label)
      await this.page.keyboard.press('Escape')
      console.log(`[GoDentist] Sucursal set via JS: ${sucursal.label}`)
    }

    await this.page.waitForTimeout(500)
  }

  private async clickBuscar(): Promise<void> {
    if (!this.page) return

    // Look for search/filter button
    const searchBtn = await this.page.$('button:has-text("Buscar")')
      || await this.page.$('button:has-text("Filtrar")')
      || await this.page.$('button:has-text("Consultar")')
      || await this.page.$('button[type="submit"]')

    if (searchBtn) {
      await searchBtn.click()
      console.log('[GoDentist] Buscar clicked')
    } else {
      // ExtJS may use a toolbar button — try pressing Enter on the date field
      await this.page.locator('#df_fecha').press('Enter')
      console.log('[GoDentist] Enter pressed on date field')
    }
  }

  // ── Data Extraction ──

  private async extractAppointments(sucursal: string): Promise<Appointment[]> {
    if (!this.page) return []
    const appointments: Appointment[] = []

    try {
      await this.page.waitForSelector('table', { timeout: 10000 })

      // Get all table rows
      const rows = this.page.locator('table tbody tr')
      const rowCount = await rows.count()
      console.log(`[GoDentist] Table rows: ${rowCount}`)

      for (let i = 0; i < rowCount; i++) {
        const row = rows.nth(i)
        const cells = await row.locator('td').allTextContents()
        const cleanCells = cells.map(c => c.trim()).filter(c => c.length > 0)

        if (cleanCells.length < 3) continue // Skip separator/empty rows

        // Table headers: Hora | Paciente | Estado | Teléfono | Doctor | Tipo | E | C | Comentarios
        // Parse based on known column structure
        let hora = ''
        let nombre = ''
        let telefono = ''

        for (const cell of cleanCells) {
          // Time pattern: H:MM AM/PM or HH:MM
          const timeMatch = cell.match(/\b(\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)?)\b/)
          if (timeMatch && !hora) {
            hora = timeMatch[1].trim()
            continue
          }

          // Phone: 10+ digits or 3XX Colombian mobile
          const phoneMatch = cell.match(/(\+?\d{10,}|\b3\d{9}\b)/)
          if (phoneMatch && !telefono) {
            telefono = phoneMatch[1].replace(/\D/g, '')
            if (telefono.length === 10 && telefono.startsWith('3')) {
              telefono = '57' + telefono
            }
            continue
          }

          // Name: alphabetic, > 3 chars, has spaces (full names)
          if (!nombre && cell.length > 3 && /[a-zA-ZáéíóúñÁÉÍÓÚÑ]/.test(cell) && cell.includes(' ') && !/^\d+$/.test(cell)) {
            nombre = cell
          }
        }

        if (nombre && telefono) {
          appointments.push({ nombre, telefono, hora, sucursal })
        }
      }
    } catch (err) {
      console.error(`[GoDentist] Extraction error (${sucursal}):`, err)
      await this.takeScreenshot(`extraction-error`)
    }

    return appointments
  }

  // ── Date Helpers ──

  private getNextWorkingDay(): Date {
    const now = new Date()
    const colombiaTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Bogota' }))
    const next = new Date(colombiaTime)
    next.setDate(next.getDate() + 1)

    // Skip Sunday (0). If Saturday (6), skip to Monday
    if (next.getDay() === 0) {
      next.setDate(next.getDate() + 1)
    } else if (next.getDay() === 6) {
      next.setDate(next.getDate() + 2)
    }

    return next
  }

  /** DD-MM-YYYY format for the ExtJS date input */
  private formatDateDD_MM_YYYY(date: Date): string {
    const day = String(date.getDate()).padStart(2, '0')
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const year = date.getFullYear()
    return `${day}-${month}-${year}`
  }

  /** YYYY-MM-DD for the API response */
  private formatDateYYYY_MM_DD(date: Date): string {
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
