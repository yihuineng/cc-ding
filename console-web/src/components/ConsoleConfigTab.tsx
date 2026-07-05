import { useEffect, useState } from 'react'
import { Card, Form, Input, InputNumber, Button, Space, message } from 'antd'
import { SaveOutlined } from '@ant-design/icons'
import { api } from '../api/client'

interface Props {
  remoteUrl?: string
}

/** Console 配置 Tab（支持本地/远程） */
export default function ConsoleConfigTab({ remoteUrl }: Props) {
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setLoading(true)
    const loadConfig = remoteUrl
      ? api.getRemoteGlobalConfig(remoteUrl)
      : api.getGlobalConfig()
    loadConfig
      .then((data: any) => {
        const configData = data.config?.console || data.config || data
        form.setFieldsValue(configData)
      })
      .catch(e => message.error(e.message))
      .finally(() => setLoading(false))
  }, [remoteUrl])

  const onSave = async () => {
    setSaving(true)
    try {
      const values = await form.validateFields()
      if (remoteUrl) {
        await api.putRemoteGlobalConfig(remoteUrl, values)
      } else {
        await api.putGlobalConfig(values)
      }
      message.success('配置已保存')
    } catch (e: any) {
      message.error(e.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div style={{ padding: 24, textAlign: 'center' }}>加载中...</div>

  return (
    <Card>
      <Form form={form} layout="vertical">
        <Form.Item name="port" label="端口"><InputNumber style={{ width: 200 }} /></Form.Item>
        <Form.Item name="host" label="Host"><Input style={{ width: 200 }} /></Form.Item>
        <Button type="primary" icon={<SaveOutlined />} onClick={onSave} loading={saving}>保存</Button>
      </Form>
    </Card>
  )
}
