import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Tabs, Button, Card, Form, Input, Space, message } from 'antd'
import { ArrowLeftOutlined, SaveOutlined } from '@ant-design/icons'
import { api } from '../api/client'
import SettingsTplTab from '../components/SettingsTplTab'
import GlobalKeysTab from '../components/GlobalKeysTab'
import GlobalRetryLogsTab from '../components/GlobalRetryLogsTab'
import { IRemoteConsole } from '../types'

export default function RemoteGlobalConfig() {
  const { remoteUrl: encodedUrl } = useParams()
  const remoteUrl = encodedUrl ? decodeURIComponent(encodedUrl) : ''
  const navigate = useNavigate()
  const [tab, setTab] = useState('console')

  // Get hostname from remote consoles list
  const [hostname, setHostname] = useState<string>(remoteUrl)

  useEffect(() => {
    // Fetch remote console info to get hostname
    if (remoteUrl) {
      console.log('[RemoteGlobalConfig] Fetching hostname for:', remoteUrl)
      // Try to get from global config
      const token = localStorage.getItem('ccding_token')
      fetch('/api/global/config', {
        headers: { 'Authorization': token ? `Bearer ${token}` : '' }
      })
        .then(res => {
          console.log('[RemoteGlobalConfig] Response status:', res.status)
          return res.json()
        })
        .then((data: any) => {
          console.log('[RemoteGlobalConfig] Response data:', data)
          const consoles: IRemoteConsole[] = data.config?.console?.remoteConsoles || data.config?.remoteConsoles || []
          console.log('[RemoteGlobalConfig] Consoles:', consoles)
          // Normalize URLs for comparison (remove trailing slashes)
          const normalizedRemoteUrl = remoteUrl.replace(/\/$/, '')
          const rc = consoles.find(c => c.url.replace(/\/$/, '') === normalizedRemoteUrl)
          console.log('[RemoteGlobalConfig] Found console:', rc)
          if (rc && rc.hostname) {
            console.log('[RemoteGlobalConfig] Setting hostname:', rc.hostname)
            setHostname(rc.hostname)
          } else {
            // Extract IP from URL for cleaner display
            try {
              const url = new URL(remoteUrl)
              setHostname(url.hostname)
            } catch {
              setHostname(remoteUrl)
            }
          }
        })
        .catch((err) => {
          console.error('[RemoteGlobalConfig] Fetch error:', err)
          // Fallback: extract IP from URL
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
            label: '⚙️ 基础配置',
            children: <RemoteConsoleConfigTab remoteUrl={remoteUrl || ''} />,
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
        ]}
      />
    </div>
  )
}

/** 远程 Console 配置 Tab */
function RemoteConsoleConfigTab({ remoteUrl }: { remoteUrl: string }) {
  const [config, setConfig] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!remoteUrl) return
    api.getRemoteGlobalConfig(remoteUrl)
      .then((data: any) => {
        setConfig(data.config?.console || data.config || {})
      })
      .catch((e: any) => message.error(e.message))
      .finally(() => setLoading(false))
  }, [remoteUrl])

  const handleSaveUpdatePkgUrl = async (value: string) => {
    setSaving(true)
    try {
      await api.putRemoteGlobalConfig(remoteUrl, { ...config, updatePkgUrl: value || undefined })
      message.success('更新包地址已保存')
    } catch (e: any) {
      message.error(e.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div style={{ padding: 24, textAlign: 'center' }}>加载中...</div>
  if (!config) return <div style={{ padding: 24 }}>配置加载失败</div>

  return (
    <div>
      {/* 服务配置 */}
      <Card title="服务配置" style={{ marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(300px, 100%), 1fr))', gap: 12 }}>
          <div>
            <div style={{ fontSize: 12, color: '#999', marginBottom: 4 }}>端口</div>
            <div style={{ fontSize: 18, fontWeight: 600 }}>{config.port || '-'}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: '#999', marginBottom: 4 }}>Host</div>
            <div style={{ fontSize: 18, fontWeight: 600 }}>{config.host || '-'}</div>
          </div>
        </div>
      </Card>

      {/* 更新配置 */}
      <Card title="更新配置">
        <Form layout="vertical">
          <Form.Item label="更新包下载地址 (updatePkgUrl)">
            <Input
              placeholder="http://192.168.3.2:39000/cc-ding/releases/cc-ding-latest.tgz"
              defaultValue={(config as any)?.updatePkgUrl || ''}
              style={{ maxWidth: 600 }}
              onBlur={(e) => handleSaveUpdatePkgUrl(e.target.value.trim())}
              onPressEnter={(e) => handleSaveUpdatePkgUrl((e.target as HTMLInputElement).value.trim())}
            />
          </Form.Item>
          <div style={{ fontSize: 12, color: '#999' }}>
            远程客户端执行 <code>/reboot --update</code> 时优先从此地址下载安装包
          </div>
        </Form>
      </Card>
    </div>
  )
}
