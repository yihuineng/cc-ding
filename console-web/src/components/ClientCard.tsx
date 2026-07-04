import { Card, Tag, Button, Space, Tooltip } from 'antd'
import { StopOutlined } from '@ant-design/icons'
import { Link } from 'react-router-dom'
import { IClient } from '../types'

interface Props {
  client: IClient
}

export default function ClientCard({ client }: Props) {
  return (
    <Link to={`/client/${client.clientId}`} style={{ textDecoration: 'none', color: 'inherit' }}>
      <Card size="small" hoverable style={{ height: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontWeight: 600 }}>{client.clientName || client.clientId}</div>
            <div style={{ fontSize: 12, color: '#666' }}>{client.clientId}</div>
          </div>
          <Space>
            <Tag color={client.online ? 'green' : 'default'}>{client.online ? '在线' : '离线'}</Tag>
            <Tooltip title="停止">
              <Button size="small" danger icon={<StopOutlined />} onClick={(e) => e.stopPropagation()} />
            </Tooltip>
          </Space>
        </div>
        <div style={{ marginTop: 8, fontSize: 12, color: '#999', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {client.pid != null && <span>🆔 PID: {client.pid}</span>}
          <span>💬 {client.conversationCount} 会话</span>
          <span>🔑 {client.apiKeysValid}/{client.apiKeyCount} Key</span>
        </div>
      </Card>
    </Link>
  )
}
