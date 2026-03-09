// ── Credentials ──
export interface Credentials {
  username: string
  password: string
}

// ── Appointment data scraped from the portal ──
export interface Appointment {
  nombre: string
  telefono: string
  hora: string
  sucursal: string
}

// ── Request / Response contracts ──
export interface ScrapeAppointmentsRequest {
  workspaceId: string
  credentials: Credentials
}

export interface ScrapeAppointmentsResponse {
  success: boolean
  date: string            // YYYY-MM-DD of the scraped day
  totalAppointments: number
  appointments: Appointment[]
  errors?: string[]
}

export interface HealthResponse {
  status: 'ok'
  uptime: number
  timestamp: string
}
