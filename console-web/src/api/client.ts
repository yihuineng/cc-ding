import { IClient, IConfig, IGlobalConfig, IStatus } from '../types'

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem('ccding_token')
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(path, { ...options, headers })
  if (res.status === 401) {
    localStorage.removeItem('ccding_token')
    localStorage.removeItem('ccding_account')
    window.location.href = '/login'
    throw new Error('未认证')
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || '请求失败')
  }
  return res.json()
}

export const api = {
  login: (account: string, password: string) =>
    request<{ token: string }>('/api/login', {
      method: 'POST',
      body: JSON.stringify({ account, password }),
    }),

  changePassword: (oldPassword: string, newPassword: string) =>
    request('/api/change-password', {
      method: 'POST',
      body: JSON.stringify({ oldPassword, newPassword }),
    }),

  getStatus: () => request<IStatus>('/api/status'),

  getClients: () => request<{ clients: IClient[] }>('/api/clients'),

  createClient: (data: any) =>
    request('/api/clients', { method: 'POST', body: JSON.stringify(data) }),

  getClientConfig: (clientId: string) =>
    request<IConfig>(`/api/clients/${encodeURIComponent(clientId)}/config`),

  patchClientConfig: (clientId: string, patches: any) =>
    request(`/api/clients/${encodeURIComponent(clientId)}/config`, {
      method: 'PATCH',
      body: JSON.stringify(patches),
    }),

  getGlobalConfig: () => request<IGlobalConfig>('/api/global/config'),

  putGlobalConfig: (config: any) =>
    request('/api/global/config', {
      method: 'PUT',
      body: JSON.stringify(config),
    }),
}
