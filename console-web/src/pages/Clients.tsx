import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Button, Space, Tag, Typography, Row, Col, Card, message,
  Dropdown, Modal, Form, Input, Popconfirm, Select, Tabs,
} from 'antd'
import type { MenuProps } from 'antd'
import {
  PlusOutlined, ReloadOutlined, SettingOutlined, DownOutlined,
  ThunderboltOutlined, RedoOutlined, ToolOutlined,
} from '@ant-design/icons'
import { api } from '../api/client'
import { IClient, IStatus, IRemoteConsole } from '../types'
import ClientCard from '../components/ClientCard'
import ConsoleConfigTab from '../components/ConsoleConfigTab'
import SettingsTplTab from '../components/SettingsTplTab'
import GlobalKeysTab from '../components/GlobalKeysTab'
import GlobalRetryLogsTab from '../components/GlobalRetryLogsTab'
import { homeCache } from '../utils/cache'

export default function Clients() {
  const navigate = useNavigate()
  const [clients, setClients] = useState<IClient[]>([])
  const [status, setStatus] = useState<IStatus | null>(null)
  const [remoteConsoles, setRemoteConsoles] = useState<IRemoteConsole[]>([])
  const [remoteStatuses, setRemoteStatuses] = useState<Record<string, IStatus>>({})
  const [loading, setLoading] = useState(true)
  const [batchLoading, setBatchLoading] = useState(false)
  const [machineLoading, setMachineLoading] = useState(false)
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [createForm] = Form.useForm()
  const [createLoading, setCreateLoading] = useState(false)
  const [createTarget, setCreateTarget] = useState<string>('local')

  // Remote config modal
  const [remoteConfigUrl, setRemoteConfigUrl] = useState<string | null>(null)
  const [remoteConfigModalOpen, setRemoteConfigModalOpen] = useState(false)
  const [remoteConfigTab, setRemoteConfigTab] = useState('console')

  const loadData = async (forceRefresh = false) => {
    // Try cache first
    const cached = homeCache.get()
    if (!forceRefresh && cached) {
      setClients(cached.clients)
      setStatus(cached.status)
      if (cached.remoteConsoles) setRemoteConsoles(cached.remoteConsoles)
      if (cached.remoteStatuses) setRemoteStatuses(cached.remoteStatuses)
    }

    try {
      // Always load global config for remote consoles
      const globalConfigData = await api.getGlobalConfig()
      const configData: any = globalConfigData
      const consoles = configData.config?.console?.remoteConsoles || configData.config?.remoteConsoles || []
      setRemoteConsoles(consoles)

      // Load remote statuses with short timeout to avoid blocking UI
      // Use cached remote statuses as fallback
      const statusPromises = consoles.map(async (rc: IRemoteConsole) => {
        try {
          // Use AbortController for 3s timeout
          const controller = new AbortController()
          const timeoutId = setTimeout(() => controller.abort(), 3000)
          const remoteStatus = await api.getRemoteStatus(rc.url)
          clearTimeout(timeoutId)
          return { url: rc.url, status: remoteStatus }
        } catch {
          // Fallback to cached status
          return { url: rc.url, status: cached?.remoteStatuses?.[rc.url] || null }
        }
      })
      const statusResults = await Promise.all(statusPromises)
      const statusMap: Record<string, IStatus> = {}
      statusResults.forEach(({ url, status }) => {
        if (status) statusMap[url] = status
      })
      setRemoteStatuses(statusMap)

      // Load clients and status if not from cache
      if (!cached || forceRefresh) {
        const [clientsData, statusData] = await Promise.all([
          api.getClients(),
          api.getStatus(),
        ])
        const newClients = clientsData.clients || []
        setClients(newClients)
        setStatus(statusData)

        // Update cache (including remote data)
        homeCache.set({
          clients: newClients,
          status: statusData,
          remoteConsoles: consoles,
          remoteStatuses: statusMap,
        })
      } else {
        // Update cache with latest remote data only
        homeCache.set({
          clients: cached.clients,
          status: cached.status,
          remoteConsoles: consoles,
          remoteStatuses: statusMap,
        })
      }
    } catch (e: any) {
      message.error(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadData() }, [])

  const localClients = clients.filter(c => !c.remote)

  // Get all configured remote URLs
  const configuredRemoteUrls = new Set(remoteConsoles.map(rc => rc.url))

  // Merge remote clients with configured remote consoles
  const remoteGroups: Record<string, { clients: IClient[], config?: IRemoteConsole }> = {}

  // Add clients from API
  clients.filter(c => c.remote).forEach(c => {
    const url = c.remoteUrl || 'unknown'
    if (!remoteGroups[url]) remoteGroups[url] = { clients: [] }
    remoteGroups[url].clients.push(c)
  })

  // Add configured remote consoles that don't have connected clients
  remoteConsoles.forEach(rc => {
    if (!remoteGroups[rc.url]) {
      remoteGroups[rc.url] = { clients: [], config: rc }
    } else if (!remoteGroups[rc.url].config) {
      remoteGroups[rc.url].config = rc
    }
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
      // Refresh data after operation
      setTimeout(() => loadData(true), 2000)
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
      // Refresh data after operation
      setTimeout(() => loadData(true), 2000)
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
      // Refresh data after operation
      setTimeout(() => loadData(true), 2000)
    } catch (e: any) {
      message.error(e.message || '操作失败')
    } finally {
      setMachineLoading(false)
    }
  }

  // ── Create client ──
  const handleCreateClient = async () => {
    try {
      const values = await createForm.validateFields()
      setCreateLoading(true)
      const data: any = {
        clientId: values.clientId,
        clientName: values.clientName,
      }
      if (createTarget !== 'local') data.remoteUrl = createTarget
      await api.createClient(data)
      message.success('Client 已创建')
      setCreateModalOpen(false)
      createForm.resetFields()
      setCreateTarget('local')
      loadData(true)
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
        <Typography.Title level={4} style={{ margin: 0 }} className="page-title">🖥️ CC-DING</Typography.Title>
        <Space className="header-actions">
          <Dropdown menu={{ items: batchMenuItems, onClick: handleBatchClick }} disabled={batchLoading}>
            <Button size="small" loading={batchLoading}>
              批量 <DownOutlined />
            </Button>
          </Dropdown>
          <Button size="small" icon={<ReloadOutlined />} onClick={() => loadData(true)}>刷新</Button>
          <Button size="small" onClick={() => { localStorage.clear(); navigate('/login') }}>退出</Button>
        </Space>
      </div>

      {/* Local machines */}
      <Card styles={{ body: { padding: '12px 16px' } }}>
        {/* Custom header with title and buttons */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>
            MB.LOCAL ({localClients.length})
          </div>
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
        </div>
        {status && (
          <div className="status-bar">
            <Tag color="green">● 在线: {localClients.filter(c => c.online).length}</Tag>
            {status.ccDingVersion && <span>📦 {status.ccDingVersion}</span>}
            {status.nodeVersion && <span>⚙️ Node {status.nodeVersion}</span>}
            {status.platform && <span>💻 {status.platform}</span>}
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
      {Object.entries(remoteGroups).map(([url, group]) => {
        const hasClients = group.clients.length > 0
        const onlineCount = group.clients.filter(c => c.online).length
        const isOffline = !hasClients
        const displayName = group.config?.hostname || url
        const remoteStatus = remoteStatuses[url]

        return (
          <Card
            key={url}
            style={{ marginTop: 16, opacity: isOffline ? 0.7 : 1 }}
            styles={{ body: { padding: '12px 16px' } }}
          >
            {/* Custom header with title and buttons */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              <div className="remote-title" style={{ fontSize: 15, fontWeight: 600 }}>
                 {displayName} ({hasClients ? `${onlineCount} 在线 / ${group.clients.length} 总计` : '离线'})
                {isOffline && <Tag color="default" style={{ marginLeft: 8 }}>未连接</Tag>}
              </div>
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
                <Button size="small" icon={<SettingOutlined />} onClick={() => { setRemoteConfigUrl(url); setRemoteConfigTab('console'); setRemoteConfigModalOpen(true) }}>全局配置</Button>
                <Button
                  type="primary"
                  size="small"
                  icon={<PlusOutlined />}
                  onClick={() => setCreateModalOpen(true)}
                >
                  新建 Client
                </Button>
              </Space>
            </div>
            {hasClients ? (
              <>
                <div className="status-bar">
                  <Tag color="green">● 在线: {onlineCount}</Tag>
                  {group.clients.length > onlineCount && <Tag color="default">○ 离线: {group.clients.length - onlineCount}</Tag>}
                  {remoteStatus ? (
                    <>
                      {remoteStatus.ccDingVersion && <span>📦 {remoteStatus.ccDingVersion}</span>}
                      {remoteStatus.nodeVersion && <span>⚙️ Node {remoteStatus.nodeVersion}</span>}
                      {remoteStatus.platform && <span>💻 {remoteStatus.platform}</span>}
                    </>
                  ) : (
                    <Tag color="default" style={{ fontSize: 11 }}>状态获取失败</Tag>
                  )}
                </div>
                <Row gutter={[16, 16]}>
                  {group.clients.map(c => (
                    <Col xs={24} sm={12} lg={8} key={c.clientId}>
                      <ClientCard client={c} />
                    </Col>
                  ))}
                </Row>
              </>
            ) : remoteStatus ? (
              <>
                <div className="status-bar">
                  <Tag color="orange">● 离线</Tag>
                  {remoteStatus.ccDingVersion && <span> {remoteStatus.ccDingVersion}</span>}
                  {remoteStatus.nodeVersion && <span>️ Node {remoteStatus.nodeVersion}</span>}
                  {remoteStatus.platform && <span>💻 {remoteStatus.platform}</span>}
                </div>
                <div style={{ textAlign: 'center', padding: '20px 0', color: '#999' }}>
                  <div style={{ fontSize: 32, marginBottom: 8 }}>🔌</div>
                  <div>该远程主机当前未连接</div>
                  <div style={{ fontSize: 12, marginTop: 4 }}>请检查远程 Console 是否正常运行</div>
                </div>
              </>
            ) : (
              <div style={{ textAlign: 'center', padding: '40px 0', color: '#999' }}>
                <div style={{ fontSize: 48, marginBottom: 16 }}>🔌</div>
                <div>该远程主机当前未连接</div>
                <div style={{ fontSize: 12, marginTop: 8 }}>请检查远程 Console 是否正常运行</div>
              </div>
            )}
          </Card>
        )
      })}

      {/* Create Client Modal */}
      <Modal
        title="新建 Client"
        open={createModalOpen}
        onCancel={() => { setCreateModalOpen(false); createForm.resetFields(); setCreateTarget('local') }}
        onOk={() => handleCreateClient()}
        confirmLoading={createLoading}
        destroyOnClose
      >
        <Form form={createForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="target" label="目标机器" initialValue="local">
            <Select onChange={setCreateTarget}>
              <Select.Option value="local">本机 (MB.LOCAL)</Select.Option>
              {remoteConsoles.map(rc => (
                <Select.Option key={rc.url} value={rc.url}>
                   {rc.hostname || rc.url}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item name="clientId" label="Client ID" rules={[{ required: true, message: '请输入 Client ID' }]}>
            <Input placeholder="唯一标识符" />
          </Form.Item>
          <Form.Item name="clientName" label="Client 名称">
            <Input placeholder="显示名称" />
          </Form.Item>
        </Form>
      </Modal>

      {/* Remote Config Modal */}
      <Modal
        title={`管理全局配置 — ${remoteConsoles.find(rc => rc.url === remoteConfigUrl)?.hostname || remoteConfigUrl}`}
        open={remoteConfigModalOpen}
        onCancel={() => { setRemoteConfigModalOpen(false); setRemoteConfigUrl(null) }}
        footer={null}
        width={900}
        style={{ top: 20 }}
      >
        <Tabs
          activeKey={remoteConfigTab}
          onChange={setRemoteConfigTab}
          items={[
            {
              key: 'console',
              label: '️ Console 配置',
              children: <ConsoleConfigTab remoteUrl={remoteConfigUrl || undefined} />,
            },
            {
              key: 'settings',
              label: '📝 settings-tpl',
              children: <SettingsTplTab remoteUrl={remoteConfigUrl || undefined} />,
            },
            {
              key: 'apikeys',
              label: '🔑 API Keys',
              children: <GlobalKeysTab remoteUrl={remoteConfigUrl || undefined} />,
            },
            {
              key: 'retrylogs',
              label: '🔄 重试日志',
              children: <GlobalRetryLogsTab remoteUrl={remoteConfigUrl || undefined} />,
            },
          ]}
        />
      </Modal>
    </div>
  )
}
