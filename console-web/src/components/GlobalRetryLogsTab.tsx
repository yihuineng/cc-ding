import { useEffect, useState } from 'react'
import { Card, Button, Space, Modal, Form, Input, Tag, Popconfirm, message, Tooltip } from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined, ReloadOutlined } from '@ant-design/icons'
import { api } from '../api/client'

interface RetryLogEntry {
  baseUrl: string
  keywords: string[]
}

interface Props {
  remoteUrl?: string
}

/** 全局重试配置管理 Tab */
export default function GlobalRetryLogsTab({ remoteUrl }: Props) {
  const [retryLogs, setRetryLogs] = useState<Record<string, string[]>>({})
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingBaseUrl, setEditingBaseUrl] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm()

  const loadRetryLogs = async () => {
    setLoading(true)
    try {
      const data = remoteUrl
        ? await api.getRemoteGlobalRetryLogs(remoteUrl)
        : await api.getGlobalRetryLogs()
      setRetryLogs(data.retryLogs || {})
    } catch (e: any) {
      message.error(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadRetryLogs() }, [remoteUrl])

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
      if (remoteUrl) {
        await api.putRemoteGlobalRetryLogs(remoteUrl, newRetryLogs)
      } else {
        await api.putGlobalRetryLogs(newRetryLogs)
      }
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
      if (remoteUrl) {
        await api.putRemoteGlobalRetryLogs(remoteUrl, newRetryLogs)
      } else {
        await api.putGlobalRetryLogs(newRetryLogs)
      }
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

  if (loading) return <div style={{ padding: 24, textAlign: 'center' }}>加载中...</div>

  return (
    <div>
      <div style={{ marginBottom: 16, fontSize: 12, color: '#999' }}>
        按 Base URL 配置异常关键词，当 Claude 异常退出信息包含这些关键词时，自动冷却当前 API Key 并切换到其他可用 Key 继续重试
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
        <Space>
          <Button type="primary" icon={<PlusOutlined />} onClick={openAdd}>添加 Base URL</Button>
          <Button onClick={loadRetryLogs} icon={<ReloadOutlined />}>刷新</Button>
        </Space>
      </div>

      {entries.length === 0 ? (
        <Card>
          <div style={{ textAlign: 'center', padding: '40px 0', color: '#999' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>🔄</div>
            <div>暂无重试配置</div>
            <div style={{ fontSize: 12, marginTop: 8 }}>点击"添加 Base URL"按钮开始配置</div>
          </div>
        </Card>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(420px, 100%), 1fr))', gap: 12 }}>
          {entries.map(entry => (
            <Card key={entry.baseUrl} size="small" styles={{ body: { padding: '12px 16px' } }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ marginBottom: 8 }}>
                    <code style={{ fontSize: 12, color: '#00ff9d', wordBreak: 'break-all' }}>{entry.baseUrl}</code>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {entry.keywords.map((kw, i) => (
                      <Tooltip key={i} title={kw}>
                        <Tag color="blue" style={{ marginBottom: 2 }}>
                          {kw.length > 30 ? kw.slice(0, 30) + '...' : kw}
                        </Tag>
                      </Tooltip>
                    ))}
                    {entry.keywords.length === 0 && <span style={{ color: '#999', fontSize: 12 }}>无关键词</span>}
                  </div>
                </div>
                <Space size={4}>
                  <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openEdit(entry.baseUrl)} />
                  <Popconfirm title={`确定删除 ${entry.baseUrl} 的重试配置?`} onConfirm={() => handleDelete(entry.baseUrl)}>
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                </Space>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal
        title={editingBaseUrl ? '编辑重试配置' : '添加重试配置'}
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
