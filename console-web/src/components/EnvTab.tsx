import { useState } from 'react'
import { Card, Table, Button, Space, Modal, Form, Input, Popconfirm, message } from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined, SaveOutlined } from '@ant-design/icons'
import { api } from '../api/client'
import { IConfig } from '../types'

interface Props {
  clientId: string
  config: IConfig
  onRefresh: () => void
}

interface EnvItem {
  key: string
  value: string
}

export default function EnvTab({ clientId, config, onRefresh }: Props) {
  const [envs, setEnvs] = useState<EnvItem[]>(() => {
    // Extract envs from config (stored as 'envs' in the API response)
    const raw = (config as any).envs || (config as any).envVars || (config as any).env || {}
    if (typeof raw === 'object' && !Array.isArray(raw)) {
      return Object.entries(raw).map(([key, value]) => ({ key, value: String(value) }))
    }
    return []
  })
  const [modalOpen, setModalOpen] = useState(false)
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [form] = Form.useForm()

  const openAdd = () => {
    setEditingIndex(null)
    form.resetFields()
    setModalOpen(true)
  }

  const openEdit = (index: number) => {
    setEditingIndex(index)
    form.setFieldsValue(envs[index])
    setModalOpen(true)
  }

  const handleSave = async () => {
    const values = await form.validateFields()
    const newEnvs = [...envs]
    if (editingIndex !== null) {
      newEnvs[editingIndex] = values
    } else {
      // Check for duplicate key
      if (newEnvs.some(e => e.key === values.key)) {
        message.error('变量名已存在')
        return
      }
      newEnvs.push(values)
    }
    setEnvs(newEnvs)
    setDirty(true)
    setModalOpen(false)
  }

  const handleDelete = (index: number) => {
    const newEnvs = envs.filter((_, i) => i !== index)
    setEnvs(newEnvs)
    setDirty(true)
  }

  const handleSaveAll = async () => {
    setSaving(true)
    try {
      const envObj: Record<string, string> = {}
      envs.forEach(e => { envObj[e.key] = e.value })
      await api.patchClientConfig(clientId, { envs: envObj })
      message.success('环境变量已保存')
      setDirty(false)
      onRefresh()
    } catch (e: any) {
      message.error(e.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const columns = [
    {
      title: '变量名',
      dataIndex: 'key',
      key: 'key',
      render: (v: string) => <code>{v}</code>,
    },
    {
      title: '值',
      dataIndex: 'value',
      key: 'value',
      ellipsis: true,
    },
    {
      title: '操作',
      key: 'action',
      width: 120,
      render: (_: any, __: any, index: number) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(index)} />
          <Popconfirm title="确定删除?" onConfirm={() => handleDelete(index)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={openAdd}>添加变量</Button>
        <Button
          type="primary"
          icon={<SaveOutlined />}
          onClick={handleSaveAll}
          loading={saving}
          disabled={!dirty}
        >
          保存全部
        </Button>
      </div>

      <Card>
        <Table
          dataSource={envs}
          columns={columns}
          rowKey="key"
          pagination={false}
          size="small"
          locale={{ emptyText: '暂无环境变量' }}
        />
      </Card>

      <Modal
        title={editingIndex !== null ? '编辑环境变量' : '添加环境变量'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSave}
        destroyOnClose
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            name="key"
            label="变量名"
            rules={[{ required: true, message: '请输入变量名' }]}
          >
            <Input placeholder="如: API_KEY" disabled={editingIndex !== null} />
          </Form.Item>
          <Form.Item
            name="value"
            label="值"
            rules={[{ required: true, message: '请输入值' }]}
          >
            <Input placeholder="变量值" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
