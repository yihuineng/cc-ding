import { Card, Tag } from 'antd'
import { Link } from 'react-router-dom'
import { IClient } from '../types'

interface Props {
  client: IClient
}

export default function ClientCard({ client }: Props) {
  return (
    <Link to={`/client/${client.clientId}`} style={{ textDecoration: 'none', color: 'inherit' }}>
      <Card size="small" hoverable className="client-card" style={{ height: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {client.clientName || client.clientId}
            </div>
            <div style={{ fontSize: 11, color: '#888', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {client.clientId}
            </div>
          </div>
          <Tag color={client.online ? 'green' : 'default'} style={{ flexShrink: 0, marginLeft: 8 }}>
            {client.online ? '在线' : '离线'}
          </Tag>
        </div>
        <div className="client-info" style={{ marginTop: 8, fontSize: 12, color: '#999', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {client.pid != null && <span>🆔 PID: {client.pid}</span>}
          <span>💬 {client.conversationCount} 会话</span>
          <span>🔑 {client.apiKeyCount > 0 ? `${client.apiKeysValid}/${client.apiKeyCount} Key` : '全局'}</span>
        </div>
      </Card>
    </Link>
  )
}
