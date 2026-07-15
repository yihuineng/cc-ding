import { useEffect, useState } from 'react'
import { Form, Input, Button, Card, message } from 'antd'
import { SaveOutlined } from '@ant-design/icons'
import { api } from '../api/client'

interface Props {
  /** 远程 Console URL，不传则为本地模式 */
  remoteUrl?: string
}

export default function A2AConfigTab({ remoteUrl }: Props) {
  const [a2aHubUrl, setA2aHubUrl] = useState<string>('')
  const [a2aApiKey, setA2aApiKey] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const isRemote = !!remoteUrl

  useEffect(() => {
    const fetchConfig = isRemote
      ? api.getRemoteGlobalConfig(remoteUrl!)
      : api.getGlobalConfig()

    fetchConfig
      .then((data: any) => {
        const configObj = (data as any)?.config || data
        const a2aCfg = configObj?.a2aCfg || {}
        setA2aHubUrl(a2aCfg.hubUrl || '')
        setA2aApiKey(a2aCfg.apiKey || '')
      })
      .catch((e: any) => message.error(e.message))
      .finally(() => setLoading(false))
  }, [remoteUrl, isRemote])

  const handleSave = async () => {
    setSaving(true)
    try {
      const a2aCfg: any = {}
      if (a2aHubUrl.trim()) a2aCfg.hubUrl = a2aHubUrl.trim()
      if (a2aApiKey.trim()) a2aCfg.apiKey = a2aApiKey.trim()

      if (isRemote) {
        await api.putRemoteGlobalConfig(remoteUrl!, { a2aCfg: Object.keys(a2aCfg).length > 0 ? a2aCfg : undefined })
      } else {
        const configData = await api.getGlobalConfig()
        const configObj = (configData as any)?.config || configData
        await api.putGlobalConfig({ ...configObj, a2aCfg: Object.keys(a2aCfg).length > 0 ? a2aCfg : undefined })
      }
      message.success('A2A 配置已保存')
    } catch (e: any) {
      message.error(e.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div style={{ padding: 24, textAlign: 'center' }}>加载中...</div>

  return (
    <div>
      {/* Hub 配置 */}
      <Card title="Hub 配置" style={{ marginBottom: 16 }}>
        <Form layout="vertical">
          <Form.Item label="Hub URL">
            <Input
              placeholder="https://hub.example.com"
              value={a2aHubUrl}
              onChange={(e) => setA2aHubUrl(e.target.value)}
              style={{ maxWidth: 600 }}
            />
          </Form.Item>
          <Form.Item label="API Key">
            <Input
              placeholder="Hub 认证密钥"
              value={a2aApiKey}
              onChange={(e) => setA2aApiKey(e.target.value)}
              style={{ maxWidth: 600 }}
            />
          </Form.Item>
          <div style={{ fontSize: 12, color: '#999' }}>
            配置后自动向 Hub 注册并保持心跳，发现其他 Agent
          </div>
        </Form>
      </Card>

      <div style={{ marginTop: 16 }}>
        <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} loading={saving}>保存 A2A 配置</Button>
      </div>
    </div>
  )
}
