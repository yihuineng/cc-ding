import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Tabs, Button, Space, Tag, message } from 'antd'
import { ArrowLeftOutlined, StopOutlined, ReloadOutlined } from '@ant-design/icons'
import { api } from '../api/client'
import { IConfig } from '../types'
import ConfigTab from '../components/ConfigTab'

export default function ClientDetail() {
  const { clientId, tab } = useParams()
  const navigate = useNavigate()
  const [config, setConfig] = useState<IConfig | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!clientId) return
    api.getClientConfig(clientId)
      .then(setConfig)
      .catch(e => message.error(e.message))
      .finally(() => setLoading(false))
  }, [clientId])

  if (loading) return <div style={{ padding: 24, textAlign: 'center' }}>加载中...</div>
  if (!config) return <div style={{ padding: 24 }}>配置加载失败</div>

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16, alignItems: 'center' }}>
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/')}>返回</Button>
          <span style={{ fontWeight: 600, fontSize: 16 }}>{config.clientName || clientId}</span>
          <Tag color="green">在线</Tag>
        </Space>
        <Space>
          <Button danger icon={<StopOutlined />}>停止</Button>
          <Button icon={<ReloadOutlined />}>重启</Button>
        </Space>
      </div>

      <Tabs
        activeKey={tab || 'config'}
        onChange={key => navigate(`/client/${clientId}/${key}`, { replace: true })}
        items={[
          { key: 'config', label: '⚙️ 配置', children: <ConfigTab clientId={clientId!} config={config} /> },
          { key: 'conversations', label: '💬 会话管理', children: <div>会话管理（开发中）</div> },
          { key: 'keys', label: '🔑 API Key', children: <div>API Key（开发中）</div> },
          { key: 'files', label: '📁 文件', children: <div>文件（开发中）</div> },
          { key: 'env', label: '🌍 环境变量', children: <div>环境变量（开发中）</div> },
          { key: 'raw', label: ' 原始JSON', children: <div>原始JSON（开发中）</div> },
        ]}
      />
    </div>
  )
}
