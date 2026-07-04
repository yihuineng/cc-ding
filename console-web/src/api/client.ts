import { IClient, IConfig, IApiKey, IConversation, IGlobalConfig, IStatus } from '../types'

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

function enc(id: string) {
  return encodeURIComponent(id)
}

export const api = {
  // ── Auth ──
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

  // ── Status ──
  getStatus: () => request<IStatus>('/api/status'),

  // ── Clients ──
  getClients: () => request<{ clients: IClient[] }>('/api/clients'),

  createClient: (data: any) =>
    request('/api/clients', { method: 'POST', body: JSON.stringify(data) }),

  getClientInfo: (clientId: string) =>
    request<{ clientId: string; online: boolean; pid?: number }>(`/api/clients/${enc(clientId)}`),

  startClient: (clientId: string) =>
    request(`/api/clients/${enc(clientId)}/start`, { method: 'POST' }),

  stopClient: (clientId: string) =>
    request(`/api/clients/${enc(clientId)}/stop`, { method: 'POST' }),

  // ── Client Config ──
  getClientConfig: (clientId: string) =>
    request<IConfig>(`/api/clients/${enc(clientId)}/config`),

  patchClientConfig: (clientId: string, patches: any) =>
    request(`/api/clients/${enc(clientId)}/config`, {
      method: 'PATCH',
      body: JSON.stringify(patches),
    }),

  getRawConfig: (clientId: string) =>
    request<any>(`/api/clients/${enc(clientId)}/config/raw`),

  putRawConfig: (clientId: string, config: any) =>
    request(`/api/clients/${enc(clientId)}/config/raw`, {
      method: 'PUT',
      body: JSON.stringify(config),
    }),

  reloadConfig: (clientId: string) =>
    request(`/api/clients/${enc(clientId)}/config/reload`, { method: 'POST' }),

  // ── Conversations ──
  addConversation: (clientId: string, conv: Partial<IConversation>) =>
    request(`/api/clients/${enc(clientId)}/conversations`, {
      method: 'POST',
      body: JSON.stringify(conv),
    }),

  updateConversation: (clientId: string, convId: string, conv: Partial<IConversation>) =>
    request(`/api/clients/${enc(clientId)}/conversations/${enc(convId)}`, {
      method: 'PUT',
      body: JSON.stringify(conv),
    }),

  deleteConversation: (clientId: string, convId: string) =>
    request(`/api/clients/${enc(clientId)}/conversations/${enc(convId)}`, {
      method: 'DELETE',
    }),

  // ── API Keys ──
  getApiKeys: (clientId: string) =>
    request<{ keys: IApiKey[] }>(`/api/clients/${enc(clientId)}/apikeys`),

  addApiKey: (clientId: string, key: Partial<IApiKey>) =>
    request(`/api/clients/${enc(clientId)}/apikeys`, {
      method: 'POST',
      body: JSON.stringify(key),
    }),

  updateApiKey: (clientId: string, index: number, key: Partial<IApiKey>) =>
    request(`/api/clients/${enc(clientId)}/apikeys/${index}`, {
      method: 'PUT',
      body: JSON.stringify(key),
    }),

  deleteApiKey: (clientId: string, index: number) =>
    request(`/api/clients/${enc(clientId)}/apikeys/${index}`, {
      method: 'DELETE',
    }),

  resetApiKeys: (clientId: string) =>
    request(`/api/clients/${enc(clientId)}/apikeys/reset`, { method: 'POST' }),

  // ── Files (auxiliary JSON) ──
  getFile: (clientId: string, name: string) =>
    request<any>(`/api/clients/${enc(clientId)}/files?name=${encodeURIComponent(name)}`),

  putFile: (clientId: string, name: string, content: any) =>
    request(`/api/clients/${enc(clientId)}/files?name=${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify(content),
    }),

  // ── PM2 ──
  getPm2Status: (clientId: string) =>
    request<any>(`/api/clients/${enc(clientId)}/pm2`),

  restartPm2: (clientId: string) =>
    request(`/api/clients/${enc(clientId)}/pm2/restart`, { method: 'POST' }),

  // ── Global Config ──
  getGlobalConfig: () => request<IGlobalConfig>('/api/global/config'),

  putGlobalConfig: (config: any) =>
    request('/api/global/config', {
      method: 'PUT',
      body: JSON.stringify(config),
    }),

  getSettingsTpl: () => request<any>('/api/global/settings-tpl'),

  putSettingsTpl: (content: any) =>
    request('/api/global/settings-tpl', {
      method: 'PUT',
      body: JSON.stringify(content),
    }),

  // ── Batch Operations ──
  batchUpdate: () =>
    request('/api/batch/update', { method: 'POST' }),

  batchRestart: () =>
    request('/api/batch/restart', { method: 'POST' }),

  batchConsoleRestart: () =>
    request('/api/batch/console-restart', { method: 'POST' }),

  // ── Machine Operations ──
  machineRestart: (url?: string) =>
    request(`/api/machine/restart${url ? `?url=${encodeURIComponent(url)}` : ''}`, { method: 'POST' }),

  consoleRestart: () =>
    request('/api/console/restart', { method: 'POST' }),

  remoteConsoleRestart: (url: string) =>
    request(`/api/remote/console/restart?url=${encodeURIComponent(url)}`, { method: 'POST' }),

  updateLocal: () =>
    request('/api/update', { method: 'POST' }),

  updateRemote: (url: string) =>
    request(`/api/remote/update?url=${encodeURIComponent(url)}`, { method: 'POST' }),
}
