import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Tabs, Form, Input, InputNumber, Button, Card, Table, Space, Popconfirm, message } from 'antd'
import { ArrowLeftOutlined, SaveOutlined, PlusOutlined, DeleteOutlined } from '@ant-design/icons'
import { api } from '../api/client'
import { IGlobalConfig, IRemoteConsole } from '../types'

export default function GlobalConfig() {
  const navigate = useNavigate()
  const [config, setConfig] = useState<IGlobalConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [form] = Form.useForm()

  useEffect(() => {
    api.getGlobalConfig()
      .then(setConfig)
      .catch(e => message.error(e.message))
      .finally(() => setLoading(false))
  }, [])

  const onSave = async () => {
    try {
      const values = await form.validateFields()
      await api.putGlobalConfig(values)
      message.success('配置已保存')
    } catch (e: any) {
      message.error(e.message)
    }
  }

  if (loading) return <div style={{ padding: 24, textAlign: 'center' }}>加载中...</div>
  if (!config) return <div style={{ padding: 24 }}>配置加载失败</div>

  const remoteConsoles = config.remoteConsoles || []

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/')}>返回</Button>
        <span style={{ fontSize: 16, fontWeight: 600 }}>🌐 全局配置</span>
      </div>

      <Tabs defaultActiveKey="console" items={[
        {
          key: 'console',
          label: '️ Console 配置',
          children: (
            <Card>
              <Form form={form} layout="vertical" initialValues={config}>
                <Form.Item name="port" label="端口"><InputNumber style={{ width: 200 }} /></Form.Item>
                <Form.Item name="host" label="Host"><Input style={{ width: 200 }} /></Form.Item>
                <Button type="primary" icon={<SaveOutlined />} onClick={onSave}>保存</Button>
              </Form>
            </Card>
          ),
        },
        {
          key: 'remote',
          label: '🌐 远程 Console',
          children: (
            <Card title="远程 Console 管理" extra={<Button type="primary" size="small" icon={<PlusOutlined />}>添加</Button>}>
              <Table
                dataSource={remoteConsoles}
                columns={[
                  { title: '地址', dataIndex: 'url', key: 'url', render: (v: string) => <code>{v}</code> },
                  { title: '主机名', dataIndex: 'hostname', key: 'hostname', render: (v: string) => v || '-' },
                  {
                    title: '操作', key: 'action', width: 150,
                    render: (_: any, record: IRemoteConsole) => (
                      <Space>
                        <Button size="small">编辑</Button>
                        <Popconfirm title="确定删除?" onConfirm={() => {}}>
                          <Button size="small" danger icon={<DeleteOutlined />} />
                        </Popconfirm>
                      </Space>
                    ),
                  },
                ]}
                rowKey="url"
                pagination={false}
              />
            </Card>
          ),
        },
        {
          key: 'settings',
          label: '📝 settings-tpl',
          children: (
            <Card title="settings-tpl.json">
              <Input.TextArea rows={12} style={{ fontFamily: 'monospace', fontSize: 13 }} placeholder="加载配置..." />
              <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
                <Button>🔄 刷新</Button>
                <Button type="primary">💾 保存</Button>
              </div>
            </Card>
          ),
        },
      ]} />
    </div>
  )
}
