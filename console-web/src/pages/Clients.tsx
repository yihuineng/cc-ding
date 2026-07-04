import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Space, Tag, Typography, Row, Col, Card, message } from 'antd'
import { PlusOutlined, ReloadOutlined, SettingOutlined } from '@ant-design/icons'
import { api } from '../api/client'
import { IClient, IStatus } from '../types'
import ClientCard from '../components/ClientCard'

export default function Clients() {
  const navigate = useNavigate()
  const [clients, setClients] = useState<IClient[]>([])
  const [status, setStatus] = useState<IStatus | null>(null)
  const [loading, setLoading] = useState(true)

  const loadData = async () => {
    try {
      const [clientsData, statusData] = await Promise.all([
        api.getClients(),
        api.getStatus(),
      ])
      setClients(clientsData.clients || [])
      setStatus(statusData)
    } catch (e: any) {
      message.error(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadData() }, [])

  const localClients = clients.filter(c => !c.remote)
  const remoteGroups: Record<string, IClient[]> = {}
  clients.filter(c => c.remote).forEach(c => {
    const url = c.remoteUrl || 'unknown'
    if (!remoteGroups[url]) remoteGroups[url] = []
    remoteGroups[url].push(c)
  })

  if (loading) return <div style={{ padding: 24, textAlign: 'center' }}>加载中...</div>

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 24, alignItems: 'center' }}>
        <Typography.Title level={4} style={{ margin: 0 }}>🖥️ CC-DING Console</Typography.Title>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={loadData}>刷新</Button>
          <Button onClick={() => { localStorage.clear(); navigate('/login') }}>退出</Button>
        </Space>
      </div>

      {/* Local machines */}
      <Card title={`MB.LOCAL (${localClients.length})`} extra={
        <Space>
          <Button size="small" icon={<SettingOutlined />} onClick={() => navigate('/global')}>全局配置</Button>
          <Button type="primary" size="small" icon={<PlusOutlined />}>新建 Client</Button>
        </Space>
      }>
        {status && (
          <div style={{ marginBottom: 16, fontSize: 12, color: '#666', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <Tag color="green">● 在线: {localClients.filter(c => c.online).length}</Tag>
            <span> cc-ding: {status.ccDingVersion}</span>
            <span>⚙️ Node: {status.nodeVersion}</span>
            <span>💻 平台: {status.platform}</span>
          </div>
        )}
        <Row gutter={[16, 16]}>
          {localClients.map(c => (
            <Col xs={24} sm={12} lg={8} key={c.clientId}>
              <ClientCard client={c} />
            </Col>
          ))}
        </Row>
      </Card>

      {/* Remote machines */}
      {Object.entries(remoteGroups).map(([url, groupClients]) => (
        <Card
          key={url}
          title={`🌐 ${url} (${groupClients.length})`}
          extra={
            <Space>
              <Button size="small">机器操作</Button>
              <Button size="small" icon={<SettingOutlined />}>全局配置</Button>
              <Button size="small" icon={<ReloadOutlined />}>刷新</Button>
              <Button type="primary" size="small" icon={<PlusOutlined />}>新建 Client</Button>
            </Space>
          }
          style={{ marginTop: 16 }}
        >
          <div style={{ marginBottom: 16, fontSize: 12, color: '#666', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <Tag color="green">● 在线: {groupClients.filter(c => c.online).length}</Tag>
          </div>
          <Row gutter={[16, 16]}>
            {groupClients.map(c => (
              <Col xs={24} sm={12} lg={8} key={c.clientId}>
                <ClientCard client={c} />
              </Col>
            ))}
          </Row>
        </Card>
      ))}
    </div>
  )
}
