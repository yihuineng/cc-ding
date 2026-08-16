import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, Tag, Button, Space, Empty, Badge } from 'antd'
import { api } from '../api/client'
import { IConversation } from '../types'

interface Props {
  clientId: string
  conversations: IConversation[]
  onRefresh: () => void
}

const typeLabel = (t: string) => (t === '2' ? '群聊' : '单聊')
const typeColor = (t: string) => (t === '2' ? 'blue' : 'green')

export default function StarredTab({ clientId, conversations, onRefresh }: Props) {
  const navigate = useNavigate()

  const starredConvs = useMemo(() => {
    return conversations.filter(c => c.starred)
  }, [conversations])

  const handleUnstar = async (convId: string) => {
    try {
      await api.starConversation(clientId, convId, false)
      onRefresh()
    } catch (e: any) {
      console.error('取消收藏失败:', e)
    }
  }

  if (starredConvs.length === 0) {
    return <Empty description="暂无收藏的会话" />
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {starredConvs.map(conv => (
        <Card
          key={conv.conversationId}
          size="small"
          className="conv-card"
          styles={{ body: { padding: '8px 16px' } }}
        >
          <div className="conv-header" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
              <Space size={4}>
                <Tag color={typeColor(conv.conversationType)} style={{ margin: 0 }}>
                  {typeLabel(conv.conversationType)}
                </Tag>
                <span style={{ fontSize: 16 }}>⭐</span>
                {conv.streaming && (
                  <Badge status="processing" text={<span style={{ fontSize: 12 }}>streaming</span>} />
                )}
              </Space>
              <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {conv.conversationTitle || conv.conversationId}
              </span>
              <code style={{ fontSize: 11, color: '#999', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {conv.conversationId}
              </code>
            </div>
            <Space size={4} style={{ flexShrink: 0 }}>
              <Button
                size="small"
                onClick={() => handleUnstar(conv.conversationId)}
              >
                取消收藏
              </Button>
              <Button
                size="small"
                onClick={() => navigate(`/client/${clientId}/chat/${encodeURIComponent(conv.conversationId)}`)}
              >
                💬 打开对话
              </Button>
            </Space>
          </div>
        </Card>
      ))}
    </div>
  )
}
