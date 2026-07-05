// Simple data cache for homepage
const CACHE_KEY = 'ccding_home_cache'
const CACHE_EXPIRY_KEY = 'ccding_home_cache_expiry'
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

interface CacheData {
  clients: any[]
  status: any
  timestamp: number
}

export const homeCache = {
  get(): CacheData | null {
    try {
      const cached = localStorage.getItem(CACHE_KEY)
      const expiry = localStorage.getItem(CACHE_EXPIRY_KEY)

      if (!cached || !expiry) return null

      // Check if cache is expired
      if (Date.now() > parseInt(expiry)) {
        homeCache.clear()
        return null
      }

      return JSON.parse(cached)
    } catch {
      return null
    }
  },

  set(data: { clients: any[]; status: any }): void {
    try {
      const cacheData: CacheData = {
        ...data,
        timestamp: Date.now(),
      }
      localStorage.setItem(CACHE_KEY, JSON.stringify(cacheData))
      localStorage.setItem(CACHE_EXPIRY_KEY, String(Date.now() + CACHE_TTL))
    } catch {
      // Ignore storage errors
    }
  },

  clear(): void {
    localStorage.removeItem(CACHE_KEY)
    localStorage.removeItem(CACHE_EXPIRY_KEY)
  },

  // Force refresh - clear cache and return null
  invalidate(): void {
    homeCache.clear()
  },
}
