import { useEffect, useState } from 'react'
import { Card, Badge } from 'antd'
import { RobotOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'

export default function A2AStatusCard() {
  const navigate = useNavigate()
  const [online, setOnline] = useState(false)
  const [agentCount, setAgentCount] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchStats()
  }, [])

  const fetchStats = async () => {
    try {
      const config = await api.getGlobalConfig()
      const configObj = (config as any)?.config || config
      const a2aCfg = configObj?.a2aCfg
      if (!a2aCfg?.hubUrl) {
        setLoading(false)
        return
      }

      const hubUrl = a2aCfg.hubUrl.replace(/\/$/, '')
      const res = await fetch(`${hubUrl}/hub/stats`, { signal: AbortSignal.timeout(3000) })
      if (res.ok) {
        const data = await res.json()
        setOnline(true)
        setAgentCount(data.onlineAgents || 0)
      }
    } catch {
      // Ignore errors
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card
      size="small"
      hoverable
      className="a2a-status-card"
      onClick={() => navigate('/a2a')}
      style={{ cursor: 'pointer' }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <RobotOutlined style={{ color: '#1890ff', fontSize: 16 }} />
          <span style={{ fontWeight: 600, fontSize: 14 }}>A2A</span>
        </div>
        {loading ? (
          <span style={{ fontSize: 12, color: '#999' }}>检查中...</span>
        ) : online ? (
          <Badge status="success" text={<span style={{ fontSize: 13 }}>{agentCount} 在线</span>} />
        ) : (
          <span style={{ fontSize: 12, color: '#999' }}>未连接</span>
        )}
      </div>
    </Card>
  )
}
