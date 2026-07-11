import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Tabs, Button, Card, Form, Input, Space, message } from 'antd'
import { ArrowLeftOutlined, SaveOutlined, PlusOutlined, MinusOutlined } from '@ant-design/icons'
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
          {
            key: 'a2a',
            label: ' A2A 配置',
            children: <RemoteA2AConfigTab remoteUrl={remoteUrl || ''} />,
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

/** 远程 A2A 配置 Tab */
function RemoteA2AConfigTab({ remoteUrl }: { remoteUrl: string }) {
  const [a2aHubUrl, setA2aHubUrl] = useState<string>('')
  const [a2aApiKey, setA2aApiKey] = useState<string>('')
  const [a2aRemoteAgents, setA2aRemoteAgents] = useState<Array<{id: string; name: string; baseUrl: string; apiKey?: string; defaultSkill?: string}>>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!remoteUrl) return
    api.getRemoteGlobalConfig(remoteUrl)
      .then((data: any) => {
        const a2aCfg = (data as any)?.a2aCfg || {}
        setA2aHubUrl(a2aCfg.hubUrl || '')
        setA2aApiKey(a2aCfg.apiKey || '')
        setA2aRemoteAgents(a2aCfg.remoteAgents || [])
      })
      .catch((e: any) => message.error(e.message))
      .finally(() => setLoading(false))
  }, [remoteUrl])

  const handleSave = async () => {
    setSaving(true)
    try {
      const a2aCfg: any = {}
      if (a2aHubUrl.trim()) a2aCfg.hubUrl = a2aHubUrl.trim()
      if (a2aApiKey.trim()) a2aCfg.apiKey = a2aApiKey.trim()
      if (a2aRemoteAgents.length > 0) {
        a2aCfg.remoteAgents = a2aRemoteAgents.filter(a => a.id && a.baseUrl)
      }
      await api.putRemoteGlobalConfig(remoteUrl, { a2aCfg: Object.keys(a2aCfg).length > 0 ? a2aCfg : undefined })
      message.success('A2A 配置已保存')
    } catch (e: any) {
      message.error(e.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleAddRemoteAgent = () => {
    setA2aRemoteAgents([...a2aRemoteAgents, { id: '', name: '', baseUrl: '', apiKey: '', defaultSkill: '' }])
  }

  const handleRemoveRemoteAgent = (index: number) => {
    setA2aRemoteAgents(a2aRemoteAgents.filter((_, i) => i !== index))
  }

  const handleUpdateRemoteAgent = (index: number, field: string, value: string) => {
    const updated = [...a2aRemoteAgents]
    updated[index] = { ...updated[index], [field]: value }
    setA2aRemoteAgents(updated)
  }

  if (loading) return <div style={{ padding: 24, textAlign: 'center' }}>加载中...</div>

  return (
    <div>
      {/* Hub 配置 */}
      <Card title="Hub 配置" style={{ marginBottom: 16 }}>
        <Form layout="vertical">
          <Form.Item label="Hub URL">
            <Input
              placeholder="https://hub.example.com"
              value={a2aHubUrl}
              onChange={(e) => setA2aHubUrl(e.target.value)}
              style={{ maxWidth: 600 }}
            />
          </Form.Item>
          <Form.Item label="API Key">
            <Input.Password
              placeholder="Hub 认证密钥"
              value={a2aApiKey}
              onChange={(e) => setA2aApiKey(e.target.value)}
              style={{ maxWidth: 600 }}
            />
          </Form.Item>
          <div style={{ fontSize: 12, color: '#999' }}>
            配置后自动向 Hub 注册并保持心跳，发现其他 Agent
          </div>
        </Form>
      </Card>

      {/* 远端 Agent 列表 */}
      <Card title="远端 Agent 列表（备用）">
        <div style={{ marginBottom: 12 }}>
          <Button type="dashed" icon={<PlusOutlined />} onClick={handleAddRemoteAgent}>添加 Agent</Button>
        </div>
        {a2aRemoteAgents.map((agent, index) => (
          <Card key={index} size="small" style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <Form.Item label="ID" style={{ marginBottom: 0, minWidth: 150 }}>
                <Input
                  placeholder="agent-id"
                  value={agent.id}
                  onChange={(e) => handleUpdateRemoteAgent(index, 'id', e.target.value)}
                />
              </Form.Item>
              <Form.Item label="名称" style={{ marginBottom: 0, minWidth: 150 }}>
                <Input
                  placeholder="Agent 名称"
                  value={agent.name}
                  onChange={(e) => handleUpdateRemoteAgent(index, 'name', e.target.value)}
                />
              </Form.Item>
              <Form.Item label="Base URL" style={{ marginBottom: 0, minWidth: 250 }}>
                <Input
                  placeholder="https://agent.example.com"
                  value={agent.baseUrl}
                  onChange={(e) => handleUpdateRemoteAgent(index, 'baseUrl', e.target.value)}
                />
              </Form.Item>
              <Form.Item label="API Key" style={{ marginBottom: 0, minWidth: 200 }}>
                <Input.Password
                  placeholder="认证密钥"
                  value={agent.apiKey}
                  onChange={(e) => handleUpdateRemoteAgent(index, 'apiKey', e.target.value)}
                />
              </Form.Item>
              <Form.Item label="默认技能" style={{ marginBottom: 0, minWidth: 150 }}>
                <Input
                  placeholder="skill-name"
                  value={agent.defaultSkill}
                  onChange={(e) => handleUpdateRemoteAgent(index, 'defaultSkill', e.target.value)}
                />
              </Form.Item>
              <Button
                type="text"
                danger
                icon={<MinusOutlined />}
                onClick={() => handleRemoveRemoteAgent(index)}
                style={{ marginTop: 4 }}
              />
            </div>
          </Card>
        ))}
        {a2aRemoteAgents.length === 0 && (
          <div style={{ color: '#999', fontSize: 13 }}>
            暂无远端 Agent 配置。Hub 不可用时，可通过此处配置直连 Agent。
          </div>
        )}
      </Card>

      <div style={{ marginTop: 16 }}>
        <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} loading={saving}>保存 A2A 配置</Button>
      </div>
    </div>
  )
}
