import { useEffect, useState } from 'react'
import { Form, Input, Button, Card, message } from 'antd'
import { SaveOutlined, PlusOutlined, MinusOutlined } from '@ant-design/icons'
import { api } from '../api/client'

interface Props {
  /** 远程 Console URL，不传则为本地模式 */
  remoteUrl?: string
}

export default function A2AConfigTab({ remoteUrl }: Props) {
  const [a2aHubUrl, setA2aHubUrl] = useState<string>('')
  const [a2aApiKey, setA2aApiKey] = useState<string>('')
  const [a2aRemoteAgents, setA2aRemoteAgents] = useState<Array<{ id: string; name: string; baseUrl: string; apiKey?: string; defaultSkill?: string }>>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const isRemote = !!remoteUrl

  useEffect(() => {
    const fetchConfig = isRemote
      ? api.getRemoteGlobalConfig(remoteUrl!)
      : api.getGlobalConfig()

    fetchConfig
      .then((data: any) => {
        const configObj = isRemote ? (data as any) : ((data as any)?.config || data)
        const a2aCfg = configObj?.a2aCfg || {}
        setA2aHubUrl(a2aCfg.hubUrl || '')
        setA2aApiKey(a2aCfg.apiKey || '')
        setA2aRemoteAgents(a2aCfg.remoteAgents || [])
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
      if (a2aRemoteAgents.length > 0) {
        a2aCfg.remoteAgents = a2aRemoteAgents.filter(a => a.id && a.baseUrl)
      }

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

  const handleAddRemoteAgent = () => {
    setA2aRemoteAgents([...a2aRemoteAgents, { id: '', name: '', baseUrl: '', apiKey: '', defaultSkill: '' }])
  }

  const handleRemoveRemoteAgent = (index: number) => {
    setA2aRemoteAgents(a2aRemoteAgents.filter((_, i) => i !== index))
  }

  const handleUpdateRemoteAgent = (index: number, field: string, value: string) => {
    const updated = [...a2aRemoteAgents]
    updated[index] = { ...updated[index], [field]: value }
    setA2aRemoteAgents(updated)
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

      {/* 远端 Agent 列表 */}
      <Card title="远端 Agent 列表（备用）">
        <div style={{ marginBottom: 12 }}>
          <Button type="dashed" icon={<PlusOutlined />} onClick={handleAddRemoteAgent}>添加 Agent</Button>
        </div>
        {a2aRemoteAgents.map((agent, index) => (
          <Card key={index} size="small" style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <Form.Item label="ID" style={{ marginBottom: 0, minWidth: 150 }}>
                <Input
                  placeholder="agent-id"
                  value={agent.id}
                  onChange={(e) => handleUpdateRemoteAgent(index, 'id', e.target.value)}
                />
              </Form.Item>
              <Form.Item label="名称" style={{ marginBottom: 0, minWidth: 150 }}>
                <Input
                  placeholder="Agent 名称"
                  value={agent.name}
                  onChange={(e) => handleUpdateRemoteAgent(index, 'name', e.target.value)}
                />
              </Form.Item>
              <Form.Item label="Base URL" style={{ marginBottom: 0, minWidth: 250 }}>
                <Input
                  placeholder="https://agent.example.com"
                  value={agent.baseUrl}
                  onChange={(e) => handleUpdateRemoteAgent(index, 'baseUrl', e.target.value)}
                />
              </Form.Item>
              <Form.Item label="API Key" style={{ marginBottom: 0, minWidth: 200 }}>
                <Input
                  placeholder="认证密钥"
                  value={agent.apiKey}
                  onChange={(e) => handleUpdateRemoteAgent(index, 'apiKey', e.target.value)}
                />
              </Form.Item>
              <Form.Item label="默认技能" style={{ marginBottom: 0, minWidth: 150 }}>
                <Input
                  placeholder="skill-name"
                  value={agent.defaultSkill}
                  onChange={(e) => handleUpdateRemoteAgent(index, 'defaultSkill', e.target.value)}
                />
              </Form.Item>
              <Button
                type="text"
                danger
                icon={<MinusOutlined />}
                onClick={() => handleRemoveRemoteAgent(index)}
                style={{ marginTop: 4 }}
              />
            </div>
          </Card>
        ))}
        {a2aRemoteAgents.length === 0 && (
          <div style={{ color: '#999', fontSize: 13 }}>
            暂无远端 Agent 配置。Hub 不可用时，可通过此处配置直连 Agent。
          </div>
        )}
      </Card>

      <div style={{ marginTop: 16 }}>
        <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} loading={saving}>保存 A2A 配置</Button>
      </div>
    </div>
  )
}
