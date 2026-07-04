import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Button, Space, Tag, Typography, Row, Col, Card, message,
  Dropdown, Modal, Form, Input, Popconfirm,
} from 'antd'
import type { MenuProps } from 'antd'
import {
  PlusOutlined, ReloadOutlined, SettingOutlined, DownOutlined,
  ThunderboltOutlined, RedoOutlined, ToolOutlined,
} from '@ant-design/icons'
import { api } from '../api/client'
import { IClient, IStatus } from '../types'
import ClientCard from '../components/ClientCard'

export default function Clients() {
  const navigate = useNavigate()
  const [clients, setClients] = useState<IClient[]>([])
  const [status, setStatus] = useState<IStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [batchLoading, setBatchLoading] = useState(false)
  const [machineLoading, setMachineLoading] = useState(false)
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [createForm] = Form.useForm()
  const [createLoading, setCreateLoading] = useState(false)

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

  // ── Batch operations ──
  const batchMenuItems: MenuProps['items'] = [
    { key: 'restart-all', icon: <RedoOutlined />, label: '重启全部 Client' },
    { key: 'update-all', icon: <ThunderboltOutlined />, label: '更新全部机器' },
    { key: 'restart-consoles', icon: <ToolOutlined />, label: '重启全部 Console' },
  ]

  const handleBatchClick: MenuProps['onClick'] = async ({ key }) => {
    setBatchLoading(true)
    try {
      if (key === 'restart-all') {
        await api.batchRestart()
        message.success('正在重启全部 Client...')
      } else if (key === 'update-all') {
        await api.batchUpdate()
        message.success('正在更新全部机器...')
      } else if (key === 'restart-consoles') {
        await api.batchConsoleRestart()
        message.success('正在重启全部 Console...')
      }
    } catch (e: any) {
      message.error(e.message || '操作失败')
    } finally {
      setBatchLoading(false)
    }
  }

  // ── Machine operations (per remote group) ──
  const getMachineMenuItems = (url: string): MenuProps['items'] => [
    { key: `restart-machine-${url}`, icon: <RedoOutlined />, label: '重启机器 Client' },
    { key: `update-machine-${url}`, icon: <ThunderboltOutlined />, label: '更新机器' },
    { key: `restart-console-${url}`, icon: <ToolOutlined />, label: '重启 Console' },
  ]

  const handleMachineClick = async (url: string, key: string) => {
    setMachineLoading(true)
    try {
      if (key.startsWith('restart-machine-')) {
        await api.machineRestart(url)
        message.success(`正在重启 ${url} 的 Client...`)
      } else if (key.startsWith('update-machine-')) {
        await api.updateRemote(url)
        message.success(`正在更新 ${url}...`)
      } else if (key.startsWith('restart-console-')) {
        await api.remoteConsoleRestart(url)
        message.success(`正在重启 ${url} 的 Console...`)
      }
    } catch (e: any) {
      message.error(e.message || '操作失败')
    } finally {
      setMachineLoading(false)
    }
  }

  // ── Local machine operations ──
  const localMachineMenuItems: MenuProps['items'] = [
    { key: 'restart-local', icon: <RedoOutlined />, label: '重启全部 Client' },
    { key: 'update-local', icon: <ThunderboltOutlined />, label: '更新 cc-ding' },
    { key: 'restart-local-console', icon: <ToolOutlined />, label: '重启 Console' },
  ]

  const handleLocalMachineClick: MenuProps['onClick'] = async ({ key }) => {
    setMachineLoading(true)
    try {
      if (key === 'restart-local') {
        await api.machineRestart()
        message.success('正在重启本地 Client...')
      } else if (key === 'update-local') {
        await api.updateLocal()
        message.success('正在更新 cc-ding...')
      } else if (key === 'restart-local-console') {
        await api.consoleRestart()
        message.success('正在重启 Console...')
      }
    } catch (e: any) {
      message.error(e.message || '操作失败')
    } finally {
      setMachineLoading(false)
    }
  }

  // ── Create client ──
  const handleCreateClient = async (remoteUrl?: string) => {
    try {
      const values = await createForm.validateFields()
      setCreateLoading(true)
      const data: any = {
        clientId: values.clientId,
        clientName: values.clientName,
      }
      if (remoteUrl) data.remoteUrl = remoteUrl
      await api.createClient(data)
      message.success('Client 已创建')
      setCreateModalOpen(false)
      createForm.resetFields()
      loadData()
    } catch (e: any) {
      if (e.errorFields) return
      message.error(e.message || '创建失败')
    } finally {
      setCreateLoading(false)
    }
  }

  if (loading) return <div style={{ padding: 24, textAlign: 'center' }}>加载中...</div>

  return (
    <div className="page-container">
      <div className="page-header">
        <Typography.Title level={4} style={{ margin: 0 }}>🖥️ CC-DING Console</Typography.Title>
        <Space>
          <Dropdown menu={{ items: batchMenuItems, onClick: handleBatchClick }} disabled={batchLoading}>
            <Button loading={batchLoading}>
              批量操作 <DownOutlined />
            </Button>
          </Dropdown>
          <Button icon={<ReloadOutlined />} onClick={loadData}>刷新</Button>
          <Button onClick={() => { localStorage.clear(); navigate('/login') }}>退出</Button>
        </Space>
      </div>

      {/* Local machines */}
      <Card title={`MB.LOCAL (${localClients.length})`} extra={
        <Space wrap>
          <Dropdown menu={{ items: localMachineMenuItems, onClick: handleLocalMachineClick }} disabled={machineLoading}>
            <Button size="small" loading={machineLoading}>
              机器操作 <DownOutlined />
            </Button>
          </Dropdown>
          <Button size="small" icon={<SettingOutlined />} onClick={() => navigate('/global')}>全局配置</Button>
          <Button
            type="primary"
            size="small"
            icon={<PlusOutlined />}
            onClick={() => setCreateModalOpen(true)}
          >
            新建 Client
          </Button>
        </Space>
      }>
        {status && (
          <div className="status-bar">
            <Tag color="green">● 在线: {localClients.filter(c => c.online).length}</Tag>
            <span>cc-ding: {status.ccDingVersion}</span>
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
            <Space wrap>
              <Dropdown
                menu={{
                  items: getMachineMenuItems(url),
                  onClick: ({ key }) => handleMachineClick(url, key),
                }}
                disabled={machineLoading}
              >
                <Button size="small" loading={machineLoading}>
                  机器操作 <DownOutlined />
                </Button>
              </Dropdown>
              <Button size="small" icon={<ReloadOutlined />} onClick={loadData}>刷新</Button>
              <Button
                type="primary"
                size="small"
                icon={<PlusOutlined />}
                onClick={() => setCreateModalOpen(true)}
              >
                新建 Client
              </Button>
            </Space>
          }
          style={{ marginTop: 16 }}
        >
          <div className="status-bar">
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

      {/* Create Client Modal */}
      <Modal
        title="新建 Client"
        open={createModalOpen}
        onCancel={() => { setCreateModalOpen(false); createForm.resetFields() }}
        onOk={() => handleCreateClient()}
        confirmLoading={createLoading}
        destroyOnClose
      >
        <Form form={createForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="clientId" label="Client ID" rules={[{ required: true, message: '请输入 Client ID' }]}>
            <Input placeholder="唯一标识符" />
          </Form.Item>
          <Form.Item name="clientName" label="Client 名称">
            <Input placeholder="显示名称" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
