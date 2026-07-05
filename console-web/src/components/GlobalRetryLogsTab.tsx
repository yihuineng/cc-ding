import { useEffect, useState } from 'react'
import { Table, Button, Space, Modal, Form, Input, Tag, Popconfirm, message, Tooltip } from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined, ReloadOutlined } from '@ant-design/icons'
import { api } from '../api/client'

interface RetryLogEntry {
  baseUrl: string
  keywords: string[]
}

/** 全局 retryLogs 管理 Tab */
export default function GlobalRetryLogsTab() {
  const [retryLogs, setRetryLogs] = useState<Record<string, string[]>>({})
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingBaseUrl, setEditingBaseUrl] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm()

  const loadRetryLogs = async () => {
    setLoading(true)
    try {
      const data = await api.getGlobalRetryLogs()
      setRetryLogs(data.retryLogs || {})
    } catch (e: any) {
      message.error(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadRetryLogs() }, [])

  const openAdd = () => {
    setEditingBaseUrl(null)
    form.resetFields()
    setModalOpen(true)
  }

  const openEdit = (baseUrl: string) => {
    setEditingBaseUrl(baseUrl)
    form.setFieldsValue({
      baseUrl,
      keywords: retryLogs[baseUrl]?.join('\n') || '',
    })
    setModalOpen(true)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const values = await form.validateFields()
      const keywords = (values.keywords || '')
        .split('\n')
        .map((k: string) => k.trim())
        .filter(Boolean)
      const newRetryLogs = { ...retryLogs }
      newRetryLogs[values.baseUrl] = keywords
      await api.putGlobalRetryLogs(newRetryLogs)
      setRetryLogs(newRetryLogs)
      message.success(editingBaseUrl ? '已更新' : '已添加')
      setModalOpen(false)
    } catch (e: any) {
      if (e.errorFields) return
      message.error(e.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (baseUrl: string) => {
    try {
      const newRetryLogs = { ...retryLogs }
      delete newRetryLogs[baseUrl]
      await api.putGlobalRetryLogs(newRetryLogs)
      setRetryLogs(newRetryLogs)
      message.success('已删除')
    } catch (e: any) {
      message.error(e.message || '删除失败')
    }
  }

  const entries: RetryLogEntry[] = Object.entries(retryLogs).map(([baseUrl, keywords]) => ({
    baseUrl,
    keywords,
  }))

  const columns = [
    {
      title: 'Base URL',
      dataIndex: 'baseUrl',
      key: 'baseUrl',
      ellipsis: true,
      render: (v: string) => <code style={{ fontSize: 11 }}>{v}</code>,
    },
    {
      title: '重试关键词',
      dataIndex: 'keywords',
      key: 'keywords',
      render: (keywords: string[]) => (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {keywords.map((kw, i) => (
            <Tooltip key={i} title={kw}>
              <Tag color="blue" style={{ marginBottom: 2 }}>
                {kw.length > 30 ? kw.slice(0, 30) + '...' : kw}
              </Tag>
            </Tooltip>
          ))}
          {keywords.length === 0 && <span style={{ color: '#999' }}>无</span>}
        </div>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 120,
      render: (_: any, record: RetryLogEntry) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(record.baseUrl)} />
          <Popconfirm title={`确定删除 ${record.baseUrl} 的 retryLogs?`} onConfirm={() => handleDelete(record.baseUrl)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <div style={{ marginBottom: 16, fontSize: 12, color: '#999' }}>
        当 Claude 异常退出信息包含这些关键词时，自动发送"继续"重试（随机间隔 1-2 分钟）
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
        <Space>
          <Button type="primary" icon={<PlusOutlined />} onClick={openAdd}>添加 Base URL</Button>
          <Button onClick={loadRetryLogs} icon={<ReloadOutlined />}>刷新</Button>
        </Space>
      </div>

      <Table
        dataSource={entries}
        columns={columns}
        rowKey="baseUrl"
        loading={loading}
        pagination={false}
        size="small"
        scroll={{ x: 500 }}
      />

      <Modal
        title={editingBaseUrl ? '编辑 retryLogs' : '添加 retryLogs'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSave}
        confirmLoading={saving}
        destroyOnClose
        width={600}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="baseUrl" label="Base URL" rules={[{ required: true, message: '请输入 Base URL' }]}>
            <Input placeholder="https://api.example.com" disabled={!!editingBaseUrl} />
          </Form.Item>
          <Form.Item
            name="keywords"
            label="关键词（每行一个）"
            rules={[{ required: true, message: '请输入至少一个关键词' }]}
          >
            <Input.TextArea
              rows={6}
              placeholder={"overloaded_error\nrate_limit_exceeded\nupstream_timeout"}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
