import { useEffect, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Tabs, Button, Space, Tag, message, Popconfirm } from 'antd'
import { ArrowLeftOutlined, StopOutlined, ReloadOutlined } from '@ant-design/icons'
import { api } from '../api/client'
import { IConfig } from '../types'
import ConfigTab from '../components/ConfigTab'
import ConversationsTab from '../components/ConversationsTab'
import KeysTab from '../components/KeysTab'
import FilesTab from '../components/FilesTab'
import EnvTab from '../components/EnvTab'
import RawTab from '../components/RawTab'

export default function ClientDetail() {
  const { clientId, tab } = useParams()
  const navigate = useNavigate()
  const [config, setConfig] = useState<IConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState(false)

  const loadConfig = useCallback(async () => {
    if (!clientId) return
    try {
      const data = await api.getClientConfig(clientId)
      setConfig((data as any).config || data)
    } catch (e: any) {
      message.error(e.message)
    } finally {
      setLoading(false)
    }
  }, [clientId])

  useEffect(() => { loadConfig() }, [loadConfig])

  const handleStop = async () => {
    if (!clientId) return
    setActionLoading(true)
    try {
      await api.stopClient(clientId)
      message.success('客户端已停止')
    } catch (e: any) {
      message.error(e.message || '停止失败')
    } finally {
      setActionLoading(false)
    }
  }

  const handleRestart = async () => {
    if (!clientId) return
    setActionLoading(true)
    try {
      await api.restartPm2(clientId)
      message.success('客户端重启中...')
    } catch (e: any) {
      message.error(e.message || '重启失败')
    } finally {
      setActionLoading(false)
    }
  }

  if (loading) return <div style={{ padding: 24, textAlign: 'center' }}>加载中...</div>
  if (!config) return <div style={{ padding: 24 }}>配置加载失败</div>

  return (
    <div className="page-container">
      <div className="page-header">
        <Space wrap>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/')}>返回</Button>
          <span style={{ fontWeight: 600, fontSize: 16 }}>{config.clientName || clientId}</span>
          <Tag color="green">在线</Tag>
        </Space>
        <Space>
          <Popconfirm title="确定停止此客户端?" onConfirm={handleStop}>
            <Button danger icon={<StopOutlined />} loading={actionLoading}>停止</Button>
          </Popconfirm>
          <Popconfirm title="确定重启此客户端?" onConfirm={handleRestart}>
            <Button icon={<ReloadOutlined />} loading={actionLoading}>重启</Button>
          </Popconfirm>
        </Space>
      </div>

      <Tabs
        activeKey={tab || 'config'}
        onChange={key => navigate(`/client/${clientId}/${key}`, { replace: true })}
        items={[
          { key: 'config', label: '⚙️ 配置', children: <ConfigTab clientId={clientId!} config={config} /> },
          {
            key: 'conversations',
            label: '💬 会话',
            children: (
              <ConversationsTab
                clientId={clientId!}
                conversations={config.conversations || []}
                onRefresh={loadConfig}
              />
            ),
          },
          { key: 'keys', label: '🔑 API Key', children: <KeysTab clientId={clientId!} /> },
          { key: 'files', label: '📁 文件', children: <FilesTab clientId={clientId!} /> },
          {
            key: 'env',
            label: '🌍 环境变量',
            children: <EnvTab clientId={clientId!} config={config} onRefresh={loadConfig} />,
          },
          { key: 'raw', label: '📝 原始JSON', children: <RawTab clientId={clientId!} /> },
        ]}
      />
    </div>
  )
}
