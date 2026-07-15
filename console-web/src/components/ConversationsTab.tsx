import { useState, useMemo, useEffect } from 'react'
import {
  Tabs, Card, Tag, Button, Space, Form, Input, InputNumber, Switch, Select,
  Collapse, Row, Col, Popconfirm, message, Empty, Badge,
} from 'antd'
import {
  SaveOutlined, DeleteOutlined, DownOutlined, UpOutlined,
} from '@ant-design/icons'
import { api } from '../api/client'
import { IConversation } from '../types'

interface Props {
  clientId: string
  conversations: IConversation[]
  onRefresh: () => void
}

const typeLabel = (t: string) => (t === '2' ? '群聊' : '单聊')
const typeColor = (t: string) => (t === '2' ? 'blue' : 'green')

export default function ConversationsTab({ clientId, conversations, onRefresh }: Props) {
  const [expandedKeys, setExpandedKeys] = useState<string[]>([])
  const [editForms, setEditForms] = useState<Record<string, IConversation>>({})
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [filterType, setFilterType] = useState<string>('all')
  const [teamAgentOptions, setTeamAgentOptions] = useState<Array<{ value: string; label: string }>>([])

  // 获取 A2A Agent 列表作为 teamAgents 选项
  useEffect(() => {
    api.getA2AAgents().then((data: any) => {
      const agents = data.agents || []
      const options = agents.map((a: any) => ({
        value: a.id,
        label: `${a.name || a.id} (${a.clientId || ''})`,
      }))
      setTeamAgentOptions(options)
    }).catch(() => {
      // A2A 未配置或获取失败，忽略
    })
  }, [])

  const filtered = useMemo(() => {
    if (filterType === 'all') return conversations
    return conversations.filter(c => c.conversationType === filterType)
  }, [conversations, filterType])

  const toggleExpand = (key: string) => {
    setExpandedKeys(prev => {
      if (prev.includes(key)) return prev.filter(k => k !== key)
      // Initialize edit form from current data
      const conv = conversations.find(c => c.conversationId === key)
      if (conv) setEditForms(prev2 => ({ ...prev2, [key]: { ...conv } }))
      return [...prev, key]
    })
  }

  const updateField = (convId: string, field: string, value: any) => {
    setEditForms(prev => ({
      ...prev,
      [convId]: { ...prev[convId], [field]: value },
    }))
  }

  const handleSave = async (convId: string) => {
    setSaving(prev => ({ ...prev, [convId]: true }))
    try {
      const data = editForms[convId]
      if (!data) return
      await api.updateConversation(clientId, convId, data)
      message.success('会话已保存')
      onRefresh()
    } catch (e: any) {
      message.error(e.message || '保存失败')
    } finally {
      setSaving(prev => ({ ...prev, [convId]: false }))
    }
  }

  const handleDelete = async (convId: string) => {
    try {
      await api.deleteConversation(clientId, convId)
      message.success('会话已删除')
      setExpandedKeys(prev => prev.filter(k => k !== convId))
      onRefresh()
    } catch (e: any) {
      message.error(e.message || '删除失败')
    }
  }

  const convCounts = useMemo(() => ({
    all: conversations.length,
    '2': conversations.filter(c => c.conversationType === '2').length,
    '1': conversations.filter(c => c.conversationType === '1').length,
  }), [conversations])

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <Tabs
          activeKey={filterType}
          onChange={setFilterType}
          size="small"
          style={{ marginBottom: 0 }}
          items={[
            { key: 'all', label: `全部 (${convCounts.all})` },
            { key: '2', label: `群聊 (${convCounts['2']})` },
            { key: '1', label: `单聊 (${convCounts['1']})` },
          ]}
        />
      </div>

      {filtered.length === 0 ? (
        <Empty description="暂无会话" />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {filtered.map(conv => {
            const isExpanded = expandedKeys.includes(conv.conversationId)
            const edit = editForms[conv.conversationId]
            return (
              <Card
                key={conv.conversationId}
                size="small"
                className="conv-card"
                styles={{ body: { padding: isExpanded ? '12px 16px' : '8px 16px' } }}
              >
                {/* Header row */}
                <div
                  className="conv-header"
                  onClick={() => toggleExpand(conv.conversationId)}
                  style={{ cursor: 'pointer', userSelect: 'none' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
                    <Space size={4}>
                      <Tag color={typeColor(conv.conversationType)} style={{ margin: 0 }}>
                        {typeLabel(conv.conversationType)}
                      </Tag>
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
                  <span style={{ color: '#999', fontSize: 12, flexShrink: 0 }}>
                    {isExpanded ? <UpOutlined /> : <DownOutlined />}
                  </span>
                </div>

                {/* Expanded edit form */}
                {isExpanded && edit && (
                  <div style={{ marginTop: 12 }}>
                    <Row gutter={[12, 8]}>
                      <Col xs={24} sm={12} md={8}>
                        <label className="field-label">会话类型</label>
                        <Select
                          value={edit.conversationType}
                          onChange={v => updateField(conv.conversationId, 'conversationType', v)}
                          style={{ width: '100%' }}
                          options={[{ value: '2', label: '群聊' }, { value: '1', label: '单聊' }]}
                        />
                      </Col>
                      <Col xs={24} sm={12} md={8}>
                        <label className="field-label">标题</label>
                        <Input
                          value={edit.conversationTitle}
                          onChange={e => updateField(conv.conversationId, 'conversationTitle', e.target.value)}
                        />
                      </Col>
                      <Col xs={24} sm={12} md={8}>
                        <label className="field-label">模型</label>
                        <Input
                          value={edit.model || ''}
                          onChange={e => updateField(conv.conversationId, 'model', e.target.value)}
                          placeholder="默认模型"
                        />
                      </Col>
                      <Col xs={24} sm={12} md={8}>
                        <label className="field-label">dingToken</label>
                        <Input
                          value={edit.dingToken || ''}
                          onChange={e => updateField(conv.conversationId, 'dingToken', e.target.value)}
                        />
                      </Col>
                      <Col xs={24} sm={12} md={8}>
                        <label className="field-label">单聊手机号</label>
                        <Input
                          value={edit.mobile || ''}
                          onChange={e => updateField(conv.conversationId, 'mobile', e.target.value)}
                          placeholder="单聊目标用户手机号"
                        />
                      </Col>
                      <Col xs={24} sm={12} md={8}>
                        <label className="field-label">白名单 (逗号分隔)</label>
                        <Input
                          value={(edit.whiteUserList || []).join(',')}
                          onChange={e => updateField(conv.conversationId, 'whiteUserList', e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
                        />
                      </Col>
                      <Col xs={24} sm={12} md={8}>
                        <label className="field-label">关联会话ID</label>
                        <Input
                          value={edit.linkConversationId || ''}
                          onChange={e => updateField(conv.conversationId, 'linkConversationId', e.target.value)}
                        />
                      </Col>
                      <Col xs={24} sm={12} md={8}>
                        <label className="field-label">工作目录</label>
                        <Input
                          value={edit.workDir || ''}
                          onChange={e => updateField(conv.conversationId, 'workDir', e.target.value)}
                        />
                      </Col>
                      <Col xs={24} sm={12} md={8}>
                        <label className="field-label">Agent</label>
                        <Input
                          value={edit.agent || ''}
                          onChange={e => updateField(conv.conversationId, 'agent', e.target.value)}
                        />
                      </Col>
                      <Col xs={24} sm={12} md={8}>
                        <label className="field-label">前置命令</label>
                        <Input
                          value={edit.preBash || ''}
                          onChange={e => updateField(conv.conversationId, 'preBash', e.target.value)}
                        />
                      </Col>
                      <Col xs={24} sm={12} md={8}>
                        <label className="field-label">权限模式</label>
                        <Select
                          value={edit.permissionMode || ''}
                          onChange={v => updateField(conv.conversationId, 'permissionMode', v)}
                          style={{ width: '100%' }}
                          allowClear
                          placeholder="默认"
                          options={[
                            { value: 'default', label: 'default' },
                            { value: 'acceptEdits', label: 'acceptEdits' },
                            { value: 'bypassPermissions', label: 'bypassPermissions' },
                          ]}
                        />
                      </Col>
                      <Col xs={24} sm={12} md={8}>
                        <label className="field-label">ACK 模式</label>
                        <Select
                          value={edit.receiveReplyMode || ''}
                          onChange={v => updateField(conv.conversationId, 'receiveReplyMode', v)}
                          style={{ width: '100%' }}
                          allowClear
                          placeholder="默认"
                          options={[
                            { value: 'reaction', label: 'reaction' },
                            { value: 'text', label: 'text' },
                          ]}
                        />
                      </Col>
                      <Col xs={24} sm={12} md={8}>
                        <label className="field-label">ACK Emoji</label>
                        <Input
                          value={edit.ackReaction || ''}
                          onChange={e => updateField(conv.conversationId, 'ackReaction', e.target.value)}
                          placeholder="如 👀"
                        />
                      </Col>
                      <Col xs={24} sm={12} md={8}>
                        <label className="field-label">最大超时(分钟)</label>
                        <InputNumber
                          value={edit.maxTurnTimeMins}
                          onChange={v => updateField(conv.conversationId, 'maxTurnTimeMins', v)}
                          style={{ width: '100%' }}
                          min={0}
                        />
                      </Col>
                      <Col xs={24} sm={12} md={8}>
                        <label className="field-label">Task Skill</label>
                        <Input
                          value={edit.taskCfg?.skill || ''}
                          onChange={e => updateField(conv.conversationId, 'taskCfg', { ...edit.taskCfg, skill: e.target.value })}
                        />
                      </Col>
                      <Col xs={24} sm={12} md={8}>
                        <label className="field-label">团队协作 Agent</label>
                        <Select
                          mode="multiple"
                          value={edit.teamAgents || []}
                          onChange={v => updateField(conv.conversationId, 'teamAgents', v)}
                          style={{ width: '100%' }}
                          allowClear
                          placeholder="选择可协作的 Agent"
                          options={teamAgentOptions}
                          showSearch
                          filterOption={(input, option) =>
                            (option?.label ?? '').toLowerCase().includes(input.toLowerCase())
                          }
                        />
                      </Col>
                    </Row>

                    {/* QA 配置 */}
                    <div style={{ marginTop: 12 }}>
                      <label className="field-label" style={{ marginBottom: 8 }}>QA 模式配置</label>
                      <Row gutter={[12, 8]}>
                        <Col xs={24} sm={12} md={8}>
                          <label className="field-label">Git 仓库 (逗号分隔)</label>
                          <Input
                            value={(edit.qaCfg?.gitRepos || []).join(',')}
                            onChange={e => updateField(conv.conversationId, 'qaCfg', {
                              ...edit.qaCfg,
                              gitRepos: e.target.value.split(',').map(s => s.trim()).filter(Boolean),
                            })}
                            placeholder="用于知识检索的 Git 仓库"
                          />
                        </Col>
                        <Col xs={24} sm={12} md={8}>
                          <label className="field-label">文档 URL (逗号分隔)</label>
                          <Input
                            value={(edit.qaCfg?.docs || []).join(',')}
                            onChange={e => updateField(conv.conversationId, 'qaCfg', {
                              ...edit.qaCfg,
                              docs: e.target.value.split(',').map(s => s.trim()).filter(Boolean),
                            })}
                            placeholder="用于知识检索的文档 URL"
                          />
                        </Col>
                        <Col xs={24} sm={12} md={8}>
                          <label className="field-label">自动 Pull</label>
                          <Switch
                            checked={!!edit.qaCfg?.autoPull}
                            onChange={v => updateField(conv.conversationId, 'qaCfg', { ...edit.qaCfg, autoPull: v })}
                            checkedChildren="开启"
                            unCheckedChildren="关闭"
                          />
                        </Col>
                      </Row>
                    </div>

                    {/* Boolean switches */}
                    <div style={{ marginTop: 12 }}>
                      <label className="field-label" style={{ marginBottom: 8 }}>开关选项</label>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
                        {([
                          ['qaMode', 'QA模式'],
                          ['freedomMode', '自由模式'],
                          ['streaming', 'Streaming'],
                          ['atSender', '@发送者'],
                          ['receiveReply', '接收回复'],
                          ['ensureAt', '确保@'],
                          ['useLocalOcr', '本地OCR'],
                        ] as [keyof IConversation, string][]).map(([field, label]) => (
                          <Switch
                            key={field}
                            checked={!!edit[field]}
                            onChange={v => updateField(conv.conversationId, field, v)}
                            checkedChildren={label}
                            unCheckedChildren={label}
                            size="small"
                          />
                        ))}
                      </div>
                    </div>

                    {/* Actions */}
                    <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                      <Popconfirm title="确定删除此会话?" onConfirm={() => handleDelete(conv.conversationId)}>
                        <Button danger icon={<DeleteOutlined />} size="small">删除</Button>
                      </Popconfirm>
                      <Button
                        type="primary"
                        icon={<SaveOutlined />}
                        size="small"
                        loading={saving[conv.conversationId]}
                        onClick={() => handleSave(conv.conversationId)}
                      >
                        保存
                      </Button>
                    </div>
                  </div>
                )}
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
