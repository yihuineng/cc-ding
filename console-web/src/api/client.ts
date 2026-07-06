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

  // ─ Status ──
  getStatus: () => request<{ status: IStatus }>('/api/status').then(d => d.status),

  getRemoteStatus: (url: string) =>
    request<{ status: IStatus }>(`/api/remote/status?url=${encodeURIComponent(url)}`).then(d => d.status),

  scanRemoteConsoles: (subnet: string, port?: number, timeout?: number) =>
    request<{ discovered: Array<{ url: string; hostname: string; ccDingVersion: string }>; count: number }>(
      '/api/remote/scan',
      { method: 'POST', body: JSON.stringify({ subnet, port, timeout }) }
    ),

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

  getGlobalRawConfig: () => request<{ content: string }>('/api/global/raw-config'),

  putGlobalRawConfig: (content: string) =>
    request('/api/global/raw-config', {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),

  // ── Remote Global Config ──
  getRemoteGlobalConfig: (url: string) =>
    request<IGlobalConfig>(`/api/remote/global/config?url=${encodeURIComponent(url)}`),

  putRemoteGlobalConfig: (url: string, config: any) =>
    request(`/api/remote/global/config?url=${encodeURIComponent(url)}`, {
      method: 'PUT',
      body: JSON.stringify(config),
    }),

  getRemoteSettingsTpl: (url: string) =>
    request<any>(`/api/remote/global/settings-tpl?url=${encodeURIComponent(url)}`),

  putRemoteSettingsTpl: (url: string, content: any) =>
    request(`/api/remote/global/settings-tpl?url=${encodeURIComponent(url)}`, {
      method: 'PUT',
      body: JSON.stringify(content),
    }),

  // ─ Global API Keys ──
  getGlobalApiKeys: () => request<{ apiKeys: IApiKey[] }>('/api/global/apikeys'),

  addGlobalApiKey: (key: Partial<IApiKey>) =>
    request('/api/global/apikeys', {
      method: 'POST',
      body: JSON.stringify(key),
    }),

  updateGlobalApiKey: (index: number, key: Partial<IApiKey>) =>
    request(`/api/global/apikeys/${index}`, {
      method: 'PUT',
      body: JSON.stringify(key),
    }),

  deleteGlobalApiKey: (index: number) =>
    request(`/api/global/apikeys/${index}`, {
      method: 'DELETE',
    }),

  // ── Global RetryLogs ──
  getGlobalRetryLogs: () => request<{ retryLogs: Record<string, string[]> }>('/api/global/retrylogs'),

  putGlobalRetryLogs: (retryLogs: Record<string, string[]>) =>
    request('/api/global/retrylogs', {
      method: 'PUT',
      body: JSON.stringify({ retryLogs }),
    }),

  // ── Remote Global API Keys ──
  getRemoteGlobalApiKeys: (url: string) =>
    request<{ apiKeys: IApiKey[] }>(`/api/remote/global/apikeys?url=${encodeURIComponent(url)}`),

  addRemoteGlobalApiKey: (url: string, key: Partial<IApiKey>) =>
    request(`/api/remote/global/apikeys?url=${encodeURIComponent(url)}`, {
      method: 'POST',
      body: JSON.stringify(key),
    }),

  updateRemoteGlobalApiKey: (url: string, index: number, key: Partial<IApiKey>) =>
    request(`/api/remote/global/apikeys/${index}?url=${encodeURIComponent(url)}`, {
      method: 'PUT',
      body: JSON.stringify(key),
    }),

  deleteRemoteGlobalApiKey: (url: string, index: number) =>
    request(`/api/remote/global/apikeys/${index}?url=${encodeURIComponent(url)}`, {
      method: 'DELETE',
    }),

  // ── Remote Global RetryLogs ──
  getRemoteGlobalRetryLogs: (url: string) =>
    request<{ retryLogs: Record<string, string[]> }>(`/api/remote/global/retrylogs?url=${encodeURIComponent(url)}`),

  putRemoteGlobalRetryLogs: (url: string, retryLogs: Record<string, string[]>) =>
    request(`/api/remote/global/retrylogs?url=${encodeURIComponent(url)}`, {
      method: 'PUT',
      body: JSON.stringify({ retryLogs }),
    }),

  // ── Batch Operations ──
  batchUpdate: () =>
    request('/api/batch/update', { method: 'POST' }),

  batchRestart: () =>
    request('/api/batch/restart', { method: 'POST' }),

  batchConsoleRestart: () =>
    request('/api/batch/console-restart', { method: 'POST' }),

  batchReloadConfig: () =>
    request('/api/batch/reload-config', { method: 'POST' }),

  // ── Machine Operations ──
  machineRestart: (url?: string) =>
    request(`/api/machine/restart${url ? `?url=${encodeURIComponent(url)}` : ''}`, { method: 'POST' }),

  machineReloadConfig: (url?: string) =>
    request(`/api/machine/reload-config${url ? `?url=${encodeURIComponent(url)}` : ''}`, { method: 'POST' }),

  consoleRestart: () =>
    request('/api/console/restart', { method: 'POST' }),

  remoteConsoleRestart: (url: string) =>
    request(`/api/remote/console/restart?url=${encodeURIComponent(url)}`, { method: 'POST' }),

  updateLocal: () =>
    request('/api/update', { method: 'POST' }),

  updateRemote: (url: string) =>
    request(`/api/remote/update?url=${encodeURIComponent(url)}`, { method: 'POST' }),
}
