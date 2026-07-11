import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, Table, Tag, Badge, Button, Space, message } from 'antd'
import { ArrowLeftOutlined, ReloadOutlined, RobotOutlined, CheckCircleOutlined, ClockCircleOutlined, CloseCircleOutlined } from '@ant-design/icons'
import { api } from '../api/client'

export default function A2ADetail() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [agents, setAgents] = useState<any[]>([])
  const [tasks, setTasks] = useState<any[]>([])
  const [hubUrl, setHubUrl] = useState<string>('')
  const [error, setError] = useState<string>('')

  const fetchData = async () => {
    setLoading(true)
    setError('')
    try {
      const config = await api.getGlobalConfig()
      const configObj = (config as any)?.config || config
      const a2aCfg = configObj?.a2aCfg
      if (!a2aCfg?.hubUrl) {
        setError('未配置 A2A Hub URL')
        return
      }

      const url = a2aCfg.hubUrl.replace(/\/$/, '')
      setHubUrl(url)

      const fetchWithTimeout = (path: string) =>
        fetch(`${url}${path}`, { signal: AbortSignal.timeout(5000) }).then(r => {
          if (!r.ok) throw new Error('请求失败')
          return r.json()
        })

      const [agentsData, tasksData] = await Promise.all([
        fetchWithTimeout('/hub/agents').catch(() => ({ agents: [] })),
        fetchWithTimeout('/hub/tasks').catch(() => ({ tasks: [] })),
      ])

      setAgents(agentsData.agents || [])
      setTasks(tasksData.tasks || [])
    } catch (e: any) {
      setError(e.message || '连接失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchData() }, [])

  const agentColumns = [
    {
      title: 'Agent',
      key: 'agent',
      render: (_, record: any) => (
        <div>
          <div style={{ fontWeight: 500 }}>{record.name || record.id}</div>
          <div style={{ fontSize: 11, color: '#999' }}>{record.clientId}</div>
        </div>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status: string) => (
        <Badge status={status === 'online' ? 'success' : 'default'} text={status === 'online' ? '在线' : '离线'} />
      ),
    },
  ]

  const taskColumns = [
    {
      title: '任务',
      key: 'task',
      render: (_, record: any) => (
        <div>
          <div style={{ fontWeight: 500 }}>{record.targetAgentName || record.taskId?.slice(0, 12)}</div>
          <div style={{ fontSize: 11, color: '#999' }}>{record.method}</div>
        </div>
      ),
    },
    {
      title: '状态',
      dataIndex: 'state',
      key: 'state',
      width: 100,
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
          <span style={{ fontSize: 16, fontWeight: 600 }}> A2A 服务</span>
          {hubUrl && <Tag color="blue" style={{ marginLeft: 8 }}>{hubUrl}</Tag>}
        </Space>
        <Button icon={<ReloadOutlined />} onClick={fetchData} loading={loading}>刷新</Button>
      </div>

      {error && (
        <Card>
          <div style={{ textAlign: 'center', padding: '40px 0', color: '#999' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
            <div>{error}</div>
            <div style={{ fontSize: 12, marginTop: 8 }}>请前往「全局配置 → A2A 配置」设置</div>
          </div>
        </Card>
      )}

      {!error && (
        <>
          {/* 统计 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 }}>
            <Card size="small">
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 24, fontWeight: 600 }}>{clients.filter(c => c.online).length}</div>
                <div style={{ color: '#666', fontSize: 12 }}>在线 Client</div>
              </div>
            </Card>
            <Card size="small">
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 24, fontWeight: 600 }}>{clients.length}</div>
                <div style={{ color: '#666', fontSize: 12 }}>总 Client</div>
              </div>
            </Card>
            <Card size="small">
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 24, fontWeight: 600 }}>{agents.length}</div>
                <div style={{ color: '#666', fontSize: 12 }}>总 Agent</div>
              </div>
            </Card>
            <Card size="small">
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 24, fontWeight: 600 }}>{tasks.filter(t => t.state === 'working').length}</div>
                <div style={{ color: '#666', fontSize: 12 }}>进行中任务</div>
              </div>
            </Card>
          </div>

          {/* Clients 列表 */}
          <Card title="Client 列表" style={{ marginBottom: 16 }}>
            <Table
              columns={[
                {
                  title: 'Client ID',
                  dataIndex: 'clientId',
                  key: 'clientId',
                  render: (text: string) => <code>{text}</code>,
                },
                {
                  title: 'Agent 数',
                  key: 'agentCount',
                  width: 100,
                  render: (_, record) => record.agents.length,
                },
                {
                  title: '状态',
                  key: 'status',
                  width: 100,
                  render: (_, record) => (
                    <Badge status={record.online ? 'success' : 'default'} text={record.online ? '在线' : '离线'} />
                  ),
                },
              ]}
              dataSource={clients}
              rowKey="clientId"
              size="small"
              pagination={false}
              locale={{ emptyText: '暂无 Client' }}
            />
          </Card>

          {/* Agents 列表 */}
          <Card title="Agent 列表" style={{ marginBottom: 16 }}>
            <Table
              columns={agentColumns}
              dataSource={agents}
              rowKey="id"
              size="small"
              pagination={false}
              locale={{ emptyText: '暂无 Agent' }}
            />
          </Card>

          {/* Tasks */}
          <Card title="任务记录">
            <Table
              columns={taskColumns}
              dataSource={tasks}
              rowKey="taskId"
              size="small"
              pagination={{ pageSize: 10 }}
              locale={{ emptyText: '暂无任务' }}
            />
          </Card>
        </>
      )}
    </div>
  )
}
