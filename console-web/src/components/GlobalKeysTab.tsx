import { useEffect, useState, useRef, useCallback } from 'react'
import { Card, Button, Space, Modal, Form, Input, Popconfirm, message, Switch, Tag } from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined, ReloadOutlined, CopyOutlined, DragOutlined } from '@ant-design/icons'
import { api } from '../api/client'
import { IApiKey } from '../types'

interface Props {
  remoteUrl?: string
}

/** 全局 API Key 管理 Tab */
export default function GlobalKeysTab({ remoteUrl }: Props) {
  const [keys, setKeys] = useState<IApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm()
  const [togglingIndex, setTogglingIndex] = useState<number | null>(null)
  // 拖拽排序
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)
  const [reorderSaving, setReorderSaving] = useState(false)
  const isRemote = !!remoteUrl

  // 触摸拖拽状态
  const touchState = useRef<{
    startIndex: number | null
    currentY: number
    cardHeight: number
    cardGap: number
    columns: number
  } | null>(null)
  const cardRefs = useRef<(HTMLDivElement | null)[]>([])

  const loadKeys = async () => {
    setLoading(true)
    try {
      const data = remoteUrl
        ? await api.getRemoteGlobalApiKeys(remoteUrl)
        : await api.getGlobalApiKeys()
      setKeys(data.apiKeys || [])
    } catch (e: any) {
      message.error(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadKeys() }, [remoteUrl])

  const openAdd = () => {
    setEditingIndex(null)
    form.resetFields()
    setModalOpen(true)
  }

  const openEdit = (index: number) => {
    setEditingIndex(index)
    form.setFieldsValue(keys[index])
    setModalOpen(true)
  }

  const openCopy = (index: number) => {
    const src = keys[index]
    setEditingIndex(null)
    form.resetFields()
    form.setFieldsValue({
      baseUrl: src.baseUrl,
      model: src.model,
      smallModel: src.smallModel,
      memo: src.memo,
      isValid: src.isValid,
    })
    setModalOpen(true)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const values = await form.validateFields()
      if (editingIndex !== null) {
        if (remoteUrl) {
          await api.updateRemoteGlobalApiKey(remoteUrl, editingIndex, values)
        } else {
          await api.updateGlobalApiKey(editingIndex, values)
        }
        message.success('Key 已更新')
      } else {
        if (remoteUrl) {
          await api.addRemoteGlobalApiKey(remoteUrl, values)
        } else {
          await api.addGlobalApiKey(values)
        }
        message.success('Key 已添加')
      }
      setModalOpen(false)
      loadKeys()
    } catch (e: any) {
      if (e.errorFields) return
      message.error(e.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (index: number) => {
    try {
      if (remoteUrl) {
        await api.deleteRemoteGlobalApiKey(remoteUrl, index)
      } else {
        await api.deleteGlobalApiKey(index)
      }
      message.success('Key 已删除')
      loadKeys()
    } catch (e: any) {
      message.error(e.message || '删除失败')
    }
  }

  const handleToggleValid = async (index: number, currentValid: boolean) => {
    setTogglingIndex(index)
    try {
      const newValid = !currentValid
      if (remoteUrl) {
        await api.updateRemoteGlobalApiKey(remoteUrl, index, { isValid: newValid })
      } else {
        await api.updateGlobalApiKey(index, { isValid: newValid })
      }
      setKeys(prev => prev.map((k, i) => i === index ? { ...k, isValid: newValid } : k))
      message.success(newValid ? 'Key 已启用' : 'Key 已禁用')
    } catch (e: any) {
      message.error(e.message || '操作失败')
    } finally {
      setTogglingIndex(null)
    }
  }

  // 拖拽排序：本地模式
  const handleReorder = useCallback(async (newOrder: number[]) => {
    if (isRemote) return
    setReorderSaving(true)
    try {
      await api.reorderGlobalApiKeys(newOrder)
      setKeys(prev => newOrder.map(i => prev[i]))
      message.success('排序已更新，排前的 Key 优先使用')
    } catch (e: any) {
      message.error(e.message || '排序失败')
      loadKeys()
    } finally {
      setReorderSaving(false)
    }
  }, [isRemote])

  // HTML5 拖拽（桌面端）
  const handleDragEnter = (e: React.DragEvent, index: number) => {
    if (isRemote || dragIndex === null || dragIndex === index) return
    e.preventDefault()
    setOverIndex(index)
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
  }

  const handleDragLeave = () => {
    setOverIndex(null)
  }

  const handleDrop = (e: React.DragEvent, targetIndex: number) => {
    e.preventDefault()
    if (isRemote || dragIndex === null || dragIndex === targetIndex) {
      setDragIndex(null)
      setOverIndex(null)
      return
    }
    const newOrder = keys.map((_, i) => i)
    const [moved] = newOrder.splice(dragIndex, 1)
    newOrder.splice(targetIndex, 0, moved)
    setDragIndex(null)
    setOverIndex(null)
    handleReorder(newOrder)
  }

  const handleDragStart = (index: number) => {
    if (isRemote) return
    setDragIndex(index)
  }

  // 触摸拖拽（移动端）
  const handleTouchStart = (e: React.TouchEvent, index: number) => {
    if (isRemote) return
    const touch = e.touches[0]
    const card = cardRefs.current[index]
    if (!card) return

    // 计算网格列数
    const container = card.parentElement
    if (!container) return
    const containerWidth = container.clientWidth
    const cardWidth = card.offsetWidth
    const gap = 12
    const columns = Math.floor((containerWidth + gap) / (cardWidth + gap)) || 1

    touchState.current = {
      startIndex: index,
      currentY: touch.clientY,
      cardHeight: card.offsetHeight,
      cardGap: gap,
      columns,
    }
    setDragIndex(index)
    setOverIndex(index)
  }

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!touchState.current || isRemote) return
    e.preventDefault()

    const touch = e.touches[0]
    const { startIndex, cardHeight, cardGap, columns } = touchState.current
    if (startIndex === null) return

    const deltaY = touch.clientY - touchState.current.currentY
    const cardIndexDelta = Math.round(deltaY / (cardHeight + cardGap))
    const currentIndex = startIndex + cardIndexDelta * columns
    const clampedIndex = Math.max(0, Math.min(keys.length - 1, currentIndex))

    setOverIndex(clampedIndex)
  }

  const handleTouchEnd = () => {
    if (!touchState.current || isRemote) return
    const { startIndex } = touchState.current
    const targetIndex = overIndex ?? startIndex

    touchState.current = null
    setDragIndex(null)
    setOverIndex(null)

    if (startIndex === null || startIndex === targetIndex) return

    const newOrder = keys.map((_, i) => i)
    const [moved] = newOrder.splice(startIndex, 1)
    newOrder.splice(targetIndex, 0, moved)
    handleReorder(newOrder)
  }

  // 掩码显示 API Key
  const maskKey = (key: string) => {
    if (!key || key.length <= 8) return key || ''
    return key.slice(0, 4) + '****' + key.slice(-4)
  }

  // 截断长文本
  const truncate = (text: string, maxLen: number) => {
    if (!text) return ''
    return text.length > maxLen ? text.slice(0, maxLen) + '...' : text
  }

  if (loading) return <div style={{ padding: 24, textAlign: 'center' }}>加载中...</div>

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button type="primary" icon={<PlusOutlined />} onClick={openAdd}>添加 Key</Button>
          {!isRemote && <Tag color="blue" style={{ margin: 0 }}>拖拽排序，排前优先</Tag>}
        </div>
        <Button onClick={loadKeys} icon={<ReloadOutlined />}>刷新</Button>
      </div>

      {keys.length === 0 ? (
        <Card>
          <div style={{ textAlign: 'center', padding: '40px 0', color: '#999' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>🔑</div>
            <div>暂无全局 API Key</div>
            <div style={{ fontSize: 12, marginTop: 8 }}>点击"添加 Key"按钮开始配置</div>
          </div>
        </Card>
      ) : (
        <div className="api-keys-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(320px, 100%), 1fr))', gap: 12 }}>
          {keys.map((key, index) => {
            const isDragging = dragIndex === index;
            const isOver = overIndex === index;
            return (
              <div
                key={index}
                ref={el => { cardRefs.current[index] = el }}
                style={{
                  opacity: key.isValid ? 1 : 0.6,
                  transform: isDragging ? 'scale(0.98)' : isOver && dragIndex !== null ? 'scale(1.02)' : undefined,
                  transition: 'transform 0.15s',
                }}
              >
                <Card
                  size="small"
                  styles={{ body: { padding: '12px 16px' } }}
                  style={{
                    border: isOver && dragIndex !== null ? '2px solid #00ff9d' : undefined,
                    cursor: isRemote ? 'default' : 'grab',
                    touchAction: isRemote ? 'auto' : 'none',
                  }}
                  draggable={!isRemote}
                  onDragStart={() => handleDragStart(index)}
                  onDragEnter={(e) => handleDragEnter(e, index)}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => handleDrop(e, index)}
                  onTouchStart={(e) => handleTouchStart(e, index)}
                  onTouchMove={handleTouchMove}
                  onTouchEnd={handleTouchEnd}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flex: 1, minWidth: 0 }}>
                      {!isRemote && (
                        <DragOutlined style={{ color: '#666', marginTop: 3, flexShrink: 0 }} />
                      )}
                      <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                          <span style={{ fontSize: 11, color: '#666', fontWeight: 600, flexShrink: 0 }}>#{index + 1}</span>
                          <code style={{ fontSize: 12, color: '#999', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }} title={key.apiKey || ''}>{maskKey(key.apiKey || '')}</code>
                        </div>
                        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{key.model || '-'}</div>
                        <div style={{ fontSize: 11, color: '#666', overflow: 'hidden' }}>
                          {key.baseUrl && <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><span style={{ color: '#999' }}>URL: </span><code title={key.baseUrl}>{truncate(key.baseUrl, 50)}</code></div>}
                          {key.smallModel && <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><span style={{ color: '#999' }}>小模型: </span>{key.smallModel}</div>}
                          {key.memo && <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><span style={{ color: '#999' }}>备注: </span>{key.memo}</div>}
                        </div>
                      </div>
                    </div>
                    <Space size={4} align="start" style={{ flexShrink: 0 }}>
                      <Switch
                        size="small"
                        checked={key.isValid}
                        loading={togglingIndex === index}
                        onChange={() => handleToggleValid(index, key.isValid)}
                        checkedChildren="启用"
                        unCheckedChildren="禁用"
                      />
                      <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => openCopy(index)} />
                      <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openEdit(index)} />
                      <Popconfirm title="确定删除此 Key?" onConfirm={() => handleDelete(index)}>
                        <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                      </Popconfirm>
                    </Space>
                  </div>
                </Card>
              </div>
            );
          })}
        </div>
      )}

      <Modal
        title={editingIndex !== null ? '编辑全局 API Key' : '添加全局 API Key'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSave}
        confirmLoading={saving}
        destroyOnClose
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }} initialValues={{ isValid: true }}>
          <Form.Item name="apiKey" label="API Key" rules={[{ required: true, message: '请输入 Key' }]}>
            <Input placeholder="sk-xxx..." />
          </Form.Item>
          <Form.Item name="baseUrl" label="Base URL" rules={[{ required: true, message: '请输入 Base URL' }]}>
            <Input placeholder="https://api.anthropic.com" />
          </Form.Item>
          <Form.Item name="model" label="模型" rules={[{ required: true, message: '请输入模型名' }]}>
            <Input placeholder="claude-sonnet-4-20250514" />
          </Form.Item>
          <Form.Item name="smallModel" label="小模型">
            <Input placeholder="claude-haiku-..." />
          </Form.Item>
          <Form.Item name="memo" label="备注">
            <Input placeholder="备注说明" />
          </Form.Item>
          <Form.Item name="isValid" label="启用状态" valuePropName="checked">
            <Switch checkedChildren="有效" unCheckedChildren="无效" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
