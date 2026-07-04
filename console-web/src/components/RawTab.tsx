import { useEffect, useState } from 'react'
import { Card, Button, Space, message, Spin } from 'antd'
import { SaveOutlined, ReloadOutlined } from '@ant-design/icons'
import { api } from '../api/client'

interface Props {
  clientId: string
}

export default function RawTab({ clientId }: Props) {
  const [content, setContent] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  const loadRaw = async () => {
    setLoading(true)
    try {
      const data = await api.getRawConfig(clientId)
      setContent(JSON.stringify(data, null, 2))
      setDirty(false)
    } catch (e: any) {
      message.error(e.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadRaw() }, [clientId])

  const handleSave = async () => {
    setSaving(true)
    try {
      let parsed
      try {
        parsed = JSON.parse(content)
      } catch {
        message.error('JSON 格式错误，请检查')
        setSaving(false)
        return
      }
      await api.putRawConfig(clientId, parsed)
      message.success('原始配置已保存')
      setDirty(false)
    } catch (e: any) {
      message.error(e.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ fontSize: 12, color: '#999' }}>
          直接编辑 config.json 原始内容，保存后将立即生效
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={loadRaw}>刷新</Button>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            onClick={handleSave}
            loading={saving}
            disabled={!dirty}
          >
            保存
          </Button>
        </Space>
      </div>

      <Spin spinning={loading}>
        <Card>
          <textarea
            value={content}
            onChange={e => { setContent(e.target.value); setDirty(true) }}
            style={{
              width: '100%',
              minHeight: 500,
              fontFamily: 'monospace',
              fontSize: 13,
              lineHeight: 1.5,
              border: '1px solid #d9d9d9',
              borderRadius: 6,
              padding: 12,
              resize: 'vertical',
              outline: 'none',
            }}
            spellCheck={false}
          />
        </Card>
      </Spin>
    </div>
  )
}
