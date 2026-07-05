import { useEffect, useState } from 'react'
import { Card, Button, Space, Tag, Modal, Form, Input, Popconfirm, message, Tooltip } from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined, ReloadOutlined } from '@ant-design/icons'
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

  const handleReset = async () => {
    try {
      const data: any = remoteUrl
        ? await api.resetRemoteGlobalApiKeys(remoteUrl)
        : await api.resetGlobalApiKeys()
      message.success(data.message || 'Keys 已重置')
      loadKeys()
    } catch (e: any) {
      message.error(e.message || '重置失败')
    }
  }

  const maskKey = (key: string) => {
    if (!key || key.length <= 8) return key || ''
    return key.slice(0, 4) + '****' + key.slice(-4)
  }

  if (loading) return <div style={{ padding: 24, textAlign: 'center' }}>加载中...</div>

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <Space>
          <Button type="primary" icon={<PlusOutlined />} onClick={openAdd}>添加 Key</Button>
          <Popconfirm title="确定重置所有 Key 状态为有效?" onConfirm={handleReset}>
            <Button icon={<ReloadOutlined />}>重置状态</Button>
          </Popconfirm>
        </Space>
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
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: 12 }}>
          {keys.map((key, index) => (
            <Card key={index} size="small" styles={{ body: { padding: '12px 16px' } }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <Tag color={key.isValid ? 'green' : 'red'} style={{ margin: 0 }}>{key.isValid ? '有效' : '无效'}</Tag>
                    <code style={{ fontSize: 12, color: '#999' }}>{maskKey(key.apiKey || '')}</code>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{key.model || '-'}</div>
                  <div style={{ fontSize: 11, color: '#666', wordBreak: 'break-all' }}>
                    {key.baseUrl && <><span style={{ color: '#999' }}>URL: </span><code>{key.baseUrl}</code><br /></>}
                    {key.smallModel && <><span style={{ color: '#999' }}>小模型: </span>{key.smallModel}<br /></>}
                    {key.memo && <><span style={{ color: '#999' }}>备注: </span>{key.memo}</>}
                  </div>
                </div>
                <Space size={4}>
                  <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openEdit(index)} />
                  <Popconfirm title="确定删除此 Key?" onConfirm={() => handleDelete(index)}>
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                </Space>
              </div>
            </Card>
          ))}
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
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="apiKey" label="API Key" rules={[{ required: true, message: '请输入 Key' }]}>
            <Input.Password placeholder="sk-xxx..." />
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
        </Form>
      </Modal>
    </div>
  )
}
