import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Tabs, Button, message } from 'antd'
import { ArrowLeftOutlined } from '@ant-design/icons'
import { api } from '../api/client'
import SettingsTplTab from '../components/SettingsTplTab'
import GlobalKeysTab from '../components/GlobalKeysTab'
import GlobalRetryLogsTab from '../components/GlobalRetryLogsTab'
import A2AConfigTab from '../components/A2AConfigTab'
import { IRemoteConsole } from '../types'

export default function RemoteGlobalConfig() {
  const { remoteUrl: encodedUrl } = useParams()
  const remoteUrl = encodedUrl ? decodeURIComponent(encodedUrl) : ''
  const navigate = useNavigate()
  const [tab, setTab] = useState('console')

  const [hostname, setHostname] = useState<string>(remoteUrl)

  useEffect(() => {
    if (remoteUrl) {
      const token = localStorage.getItem('ccding_token')
      fetch('/api/global/config', {
        headers: { 'Authorization': token ? `Bearer ${token}` : '' }
      })
        .then(res => res.json())
        .then((data: any) => {
          const consoles: IRemoteConsole[] = data.config?.console?.remoteConsoles || data.config?.remoteConsoles || []
          const normalizedRemoteUrl = remoteUrl.replace(/\/$/, '')
          const rc = consoles.find(c => c.url.replace(/\/$/, '') === normalizedRemoteUrl)
          if (rc && rc.hostname) {
            setHostname(rc.hostname)
          } else {
            try {
              const url = new URL(remoteUrl)
              setHostname(url.hostname)
            } catch {
              setHostname(remoteUrl)
            }
          }
        })
        .catch(() => {
          try {
            const url = new URL(remoteUrl)
            setHostname(url.hostname)
          } catch {
            setHostname(remoteUrl)
          }
        })
    }
  }, [remoteUrl])

  return (
    <div className="page-container">
      <div className="client-detail-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 8 }}>
        <div style={{ flex: '0 0 auto' }}>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/')}>返回</Button>
        </div>
        <div style={{ flex: '1 1 auto', textAlign: 'center' }}>
          <span style={{ fontSize: 16, fontWeight: 600 }}>🌐 远程全局配置 — {hostname}</span>
        </div>
        <div style={{ flex: '0 0 auto' }}></div>
      </div>

      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'console',
            label: '️ 基础配置',
            children: <RemoteConsoleConfigTab remoteUrl={remoteUrl || ''} />,
          },
          {
            key: 'a2a',
            label: '🤖 A2A 配置',
            children: <A2AConfigTab remoteUrl={remoteUrl} />,
          },
          {
            key: 'settings',
            label: '📝 settings-tpl',
            children: <SettingsTplTab remoteUrl={remoteUrl} />,
          },
          {
            key: 'apikeys',
            label: '🔑 全局 API Keys',
            children: <GlobalKeysTab remoteUrl={remoteUrl} />,
          },
          {
            key: 'retrylogs',
            label: '🔄 重试日志',
            children: <GlobalRetryLogsTab remoteUrl={remoteUrl} />,
          },
          {
            key: 'raw',
            label: '📝 原始JSON',
            children: <RemoteRawConfigTab remoteUrl={remoteUrl} />,
          },
        ]}
      />
    </div>
  )
}

/** 远程 Console 基础配置 Tab */
function RemoteConsoleConfigTab({ remoteUrl }: { remoteUrl: string }) {
  const [config, setConfig] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!remoteUrl) return
    api.getRemoteGlobalConfig(remoteUrl)
      .then((data: any) => {
        setConfig(data.config?.console || data.config || {})
      })
      .catch((e: any) => message.error(e.message))
      .finally(() => setLoading(false))
  }, [remoteUrl])

  if (loading) return <div style={{ padding: 24, textAlign: 'center' }}>加载中...</div>
  if (!config) return <div style={{ padding: 24 }}>配置加载失败</div>

  return (
    <div>
      <div style={{ fontSize: 13, color: '#999', marginBottom: 16 }}>
        远程 Console 基础配置为只读模式。修改端口/Host 需登录远程机器直接编辑 config.json。
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(300px, 100%), 1fr))', gap: 16 }}>
        <div style={{ background: '#151b23', borderRadius: 8, padding: 16, border: '1px solid #2d3d4f' }}>
          <div style={{ fontSize: 12, color: '#999', marginBottom: 4 }}>端口</div>
          <div style={{ fontSize: 20, fontWeight: 600 }}>{config.port || '-'}</div>
        </div>
        <div style={{ background: '#151b23', borderRadius: 8, padding: 16, border: '1px solid #2d3d4f' }}>
          <div style={{ fontSize: 12, color: '#999', marginBottom: 4 }}>Host</div>
          <div style={{ fontSize: 20, fontWeight: 600 }}>{config.host || '-'}</div>
        </div>
      </div>
    </div>
  )
}

/** 远程原始 JSON 配置 Tab */
function RemoteRawConfigTab({ remoteUrl }: { remoteUrl: string }) {
  const [content, setContent] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const fetchRaw = () => {
    if (!remoteUrl) return
    setLoading(true)
    const token = localStorage.getItem('ccding_token')
    fetch(`/api/remote/global/config?url=${encodeURIComponent(remoteUrl)}`, {
      headers: { 'Authorization': token ? `Bearer ${token}` : '' }
    })
      .then(res => res.json())
      .then((data: any) => {
        const config = data.config || data
        setContent(JSON.stringify(config, null, 2))
      })
      .catch((e: any) => message.error(e.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => { fetchRaw() }, [remoteUrl])

  const handleSave = async () => {
    setSaving(true)
    try {
      const parsed = JSON.parse(content)
      const token = localStorage.getItem('ccding_token')
      const res = await fetch(`/api/remote/global/config?url=${encodeURIComponent(remoteUrl)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': token ? `Bearer ${token}` : ''
        },
        body: JSON.stringify(parsed)
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || '保存失败')
      }
      message.success('远程配置已保存')
    } catch (e: any) {
      message.error(e.message || 'JSON 格式错误')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div style={{ padding: 24, textAlign: 'center' }}>加载中...</div>

  return (
    <div>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        style={{
          width: '100%',
          minHeight: 500,
          background: '#0d1117',
          color: '#c9d1d9',
          border: '1px solid #30363d',
          borderRadius: 8,
          padding: 16,
          fontFamily: 'SF Mono, Monaco, monospace',
          fontSize: 13,
          lineHeight: 1.5,
          resize: 'vertical',
        }}
      />
      <div style={{ marginTop: 16, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <Button onClick={fetchRaw}>重新加载</Button>
        <Button type="primary" onClick={handleSave} loading={saving}>保存</Button>
      </div>
    </div>
  )
}
