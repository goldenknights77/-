// 시간 관련 헬퍼 (Asia/Seoul 표기용)

export function nowISO(): string {
  return new Date().toISOString()
}

export function isoMinusHours(hours: number, fromISO?: string): string {
  const base = fromISO ? new Date(fromISO) : new Date()
  return new Date(base.getTime() - hours * 60 * 60 * 1000).toISOString()
}

// Asia/Seoul 기준 YYYY-MM-DD 문자열
export function seoulDateString(dateISO?: string): string {
  const d = dateISO ? new Date(dateISO) : new Date()
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
  return fmt.format(d) // en-CA locale gives YYYY-MM-DD
}

// Asia/Seoul 기준 표시용 (YYYY-MM-DD HH:mm)
export function seoulDateTimeString(dateISO?: string): string {
  const d = dateISO ? new Date(dateISO) : new Date()
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
  return fmt.format(d).replace(',', '')
}
