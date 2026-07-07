import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Tabs, Button, Card, message } from 'antd'
import { ArrowLeftOutlined } from '@ant-design/icons'
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
      // Try to get from global config
      fetch('/api/global/config', {
        headers: { 'Authorization': localStorage.getItem('token') || '' }
      })
        .then(res => res.json())
        .then((data: any) => {
          const consoles: IRemoteConsole[] = data.config?.console?.remoteConsoles || data.config?.remoteConsoles || []
          const rc = consoles.find(c => c.url === remoteUrl)
          if (rc) setHostname(rc.hostname || remoteUrl)
        })
        .catch(() => setHostname(remoteUrl))
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
            label: '⚙️ Console 配置',
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

/** 远程 Console 配置 Tab（简化版，只显示基本信息） */
function RemoteConsoleConfigTab({ remoteUrl }: { remoteUrl: string }) {
  const [config, setConfig] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!remoteUrl) return
    const api = require('../api/client').api
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
      <div style={{ marginBottom: 16, fontSize: 13, color: '#999' }}>
        远程 Console 基本配置信息
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(300px, 100%), 1fr))', gap: 12 }}>
        <Card size="small" title="端口">
          <div style={{ fontSize: 18, fontWeight: 600 }}>{config.port || '-'}</div>
        </Card>
        <Card size="small" title="Host">
          <div style={{ fontSize: 18, fontWeight: 600 }}>{config.host || '-'}</div>
        </Card>
      </div>
    </div>
  )
}
