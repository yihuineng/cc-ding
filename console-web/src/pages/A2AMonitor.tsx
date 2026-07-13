import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, Table, Tag, Button, Space, Badge } from 'antd'
import { ArrowLeftOutlined, ReloadOutlined, CheckCircleOutlined, ClockCircleOutlined, CloseCircleOutlined } from '@ant-design/icons'
import { api } from '../api/client'

export default function A2AMonitor() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [agents, setAgents] = useState<any[]>([])
  const [tasks, setTasks] = useState<any[]>([])
  const [stats, setStats] = useState<any>(null)
  const [error, setError] = useState<string>('')

  const fetchData = async () => {
    setLoading(true)
    setError('')
    try {
      const config = await api.getGlobalConfig()
      const configObj = (config as any)?.config || config
      const a2aCfg = configObj?.a2aCfg
      if (!a2aCfg?.hubUrl) {
        setError('未配置 A2A Hub URL，请前往「全局配置 → A2A 配置」设置')
        setLoading(false)
        return
      }

      const hubUrl = a2aCfg.hubUrl.replace(/\/$/, '')

      const [agentsRes, tasksRes, statsRes] = await Promise.allSettled([
        fetch(`${hubUrl}/hub/agents`).then(r => r.json()),
        fetch(`${hubUrl}/hub/tasks`).then(r => r.json()),
        fetch(`${hubUrl}/hub/stats`).then(r => r.json()),
      ])

      if (agentsRes.status === 'fulfilled') setAgents(agentsRes.value.agents || [])
      if (tasksRes.status === 'fulfilled') setTasks(tasksRes.value.records || [])
      if (statsRes.status === 'fulfilled') setStats(statsRes.value)
    } catch (e: any) {
      setError(e.message || '获取 A2A 数据失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
    const timer = setInterval(fetchData, 5000)
    return () => clearInterval(timer)
  }, [])

  const clientColumns = [
    { title: 'Client ID', dataIndex: 'clientId', key: 'clientId', render: (text: string) => <code>{text}</code> },
    { title: 'Agent 数', key: 'agentCount', width: 100, render: (_, record) => record.agents.length },
    { title: '状态', key: 'status', width: 100, render: (_, record) => <Badge status={record.online ? 'success' : 'default'} text={record.online ? '在线' : '离线'} /> },
  ]

  const taskColumns = [
    {
      title: '任务',
      key: 'task',
      render: (_: any, record: any) => (
        <div>
          <div style={{ fontWeight: 500 }}>{record.targetAgentName || record.taskId?.slice(0, 12)}</div>
          <div style={{ fontSize: 11, color: '#888' }}>{record.method}</div>
        </div>
      ),
    },
    {
      title: '状态',
      dataIndex: 'state',
      key: 'state',
      width: 90,
      render: (state: string) => {
        const config: Record<string, { color: string; icon: any }> = {
          'completed': { color: 'green', icon: <CheckCircleOutlined /> },
          'working': { color: 'orange', icon: <ClockCircleOutlined /> },
          'failed': { color: 'red', icon: <CloseCircleOutlined /> },
        }
        const cfg = config[state] || { color: 'default', icon: null }
        return <Tag color={cfg.color} icon={cfg.icon}>{state}</Tag>
      },
    },
    {
      title: '耗时',
      dataIndex: 'durationMs',
      key: 'durationMs',
      width: 80,
      render: (ms: number) => ms ? `${(ms / 1000).toFixed(1)}s` : '-',
    },
  ]

  // 按 Client 分组
  const clientsMap = new Map<string, any[]>()
  agents.forEach(agent => {
    const clientId = agent.clientId || 'unknown'
    if (!clientsMap.has(clientId)) clientsMap.set(clientId, [])
    clientsMap.get(clientId)!.push(agent)
  })
  const clients = Array.from(clientsMap.entries()).map(([clientId, agents]) => ({
    clientId,
    agents,
    online: agents.some(a => a.status === 'online'),
  }))

  return (
    <div className="page-container">
      <div className="page-header">
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/')}>返回</Button>
          <span style={{ fontSize: 16, fontWeight: 600 }}>A2A 监控</span>
          {stats && <Tag color="blue">{stats.agents || 0} Agents · {stats.clients || 0} Clients</Tag>}
        </Space>
        <Button icon={<ReloadOutlined />} onClick={fetchData} loading={loading}>刷新</Button>
      </div>

      {error && (
        <Card>
          <div style={{ textAlign: 'center', padding: '40px 0', color: '#999' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
            <div>{error}</div>
          </div>
        </Card>
      )}

      {!error && (
        <>
          {/* 统计 */}
          <div className="a2a-stats-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12, marginBottom: 24 }}>
            <Card size="small">
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 24, fontWeight: 600, color: '#1890ff' }}>{stats?.agents || 0}</div>
                <div style={{ color: '#888', fontSize: 12 }}>Agents</div>
              </div>
            </Card>
            <Card size="small">
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 24, fontWeight: 600, color: '#52c41a' }}>{stats?.onlineAgents || 0}</div>
                <div style={{ color: '#888', fontSize: 12 }}>在线</div>
              </div>
            </Card>
            <Card size="small">
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 24, fontWeight: 600, color: '#faad14' }}>{clients.length}</div>
                <div style={{ color: '#888', fontSize: 12 }}>客户端</div>
              </div>
            </Card>
            <Card size="small">
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 24, fontWeight: 600, color: '#722ed1' }}>{stats?.totalRouted || 0}</div>
                <div style={{ color: '#888', fontSize: 12 }}>已路由</div>
              </div>
            </Card>
            <Card size="small">
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 24, fontWeight: 600, color: '#ff4d4f' }}>{stats?.totalErrors || 0}</div>
                <div style={{ color: '#888', fontSize: 12 }}>错误</div>
              </div>
            </Card>
          </div>

          {/* Client 列表 */}
          <Card title="Client 列表">
            <Table
              columns={clientColumns}
              dataSource={clients}
              rowKey="clientId"
              size="small"
              pagination={false}
              locale={{ emptyText: '暂无 Client' }}
            />
          </Card>

          {/* 任务 */}
          <Card title="任务记录">
            <Table columns={taskColumns} dataSource={tasks} rowKey="taskId" size="small" pagination={{ pageSize: 10 }} loading={loading} locale={{ emptyText: '暂无任务' }} />
          </Card>
        </>
      )}
    </div>
  )
}
