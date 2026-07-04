import { useEffect, useState } from 'react'
import { Table, Button, Space, Tag, Modal, Form, Input, Popconfirm, message, Tooltip } from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined, ReloadOutlined } from '@ant-design/icons'
import { api } from '../api/client'
import { IApiKey } from '../types'

interface Props {
  clientId: string
}

export default function KeysTab({ clientId }: Props) {
  const [keys, setKeys] = useState<IApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm()

  const loadKeys = async () => {
    setLoading(true)
    try {
      const data = await api.getApiKeys(clientId)
      setKeys(data.keys || [])
    } catch (e: any) {
      message.error(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadKeys() }, [clientId])

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
        await api.updateApiKey(clientId, editingIndex, values)
        message.success('Key 已更新')
      } else {
        await api.addApiKey(clientId, values)
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
      await api.deleteApiKey(clientId, index)
      message.success('Key 已删除')
      loadKeys()
    } catch (e: any) {
      message.error(e.message || '删除失败')
    }
  }

  const handleReset = async () => {
    try {
      await api.resetApiKeys(clientId)
      message.success('Keys 已重置')
      loadKeys()
    } catch (e: any) {
      message.error(e.message || '重置失败')
    }
  }

  const maskKey = (key: string) => {
    if (key.length <= 8) return key
    return key.slice(0, 4) + '****' + key.slice(-4)
  }

  const columns = [
    {
      title: '状态',
      dataIndex: 'isValid',
      key: 'isValid',
      width: 70,
      render: (v: boolean) => (
        <Tag color={v ? 'green' : 'red'}>{v ? '有效' : '无效'}</Tag>
      ),
    },
    {
      title: 'Key',
      dataIndex: 'key',
      key: 'key',
      render: (v: string) => (
        <Tooltip title={v}>
          <code style={{ fontSize: 12 }}>{maskKey(v)}</code>
        </Tooltip>
      ),
    },
    {
      title: 'Model',
      dataIndex: 'model',
      key: 'model',
      render: (v: string) => v || '-',
    },
    {
      title: '小模型',
      dataIndex: 'smallModel',
      key: 'smallModel',
      render: (v: string) => v || '-',
    },
    {
      title: 'Base URL',
      dataIndex: 'baseUrl',
      key: 'baseUrl',
      ellipsis: true,
      render: (v: string) => v ? <code style={{ fontSize: 11 }}>{v}</code> : '-',
    },
    {
      title: '备注',
      dataIndex: 'remark',
      key: 'remark',
      ellipsis: true,
      render: (v: string) => v || '-',
    },
    {
      title: '操作',
      key: 'action',
      width: 120,
      render: (_: any, __: any, index: number) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(index)} />
          <Popconfirm title="确定删除此 Key?" onConfirm={() => handleDelete(index)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

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

      <Table
        dataSource={keys}
        columns={columns}
        rowKey={(_, i) => String(i)}
        loading={loading}
        pagination={false}
        size="small"
        scroll={{ x: 600 }}
      />

      <Modal
        title={editingIndex !== null ? '编辑 API Key' : '添加 API Key'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSave}
        confirmLoading={saving}
        destroyOnClose
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="key" label="API Key" rules={[{ required: true, message: '请输入 Key' }]}>
            <Input placeholder="sk-xxx..." />
          </Form.Item>
          <Form.Item name="model" label="模型" rules={[{ required: true, message: '请输入模型名' }]}>
            <Input placeholder="claude-sonnet-4-20250514" />
          </Form.Item>
          <Form.Item name="smallModel" label="小模型">
            <Input placeholder="claude-haiku-..." />
          </Form.Item>
          <Form.Item name="baseUrl" label="Base URL">
            <Input placeholder="https://api.anthropic.com" />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input placeholder="备注说明" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
