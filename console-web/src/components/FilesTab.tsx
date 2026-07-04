import { useState } from 'react'
import { Card, Select, Button, Input, Space, message, Spin } from 'antd'
import { SaveOutlined, ReloadOutlined } from '@ant-design/icons'
import { api } from '../api/client'

interface Props {
  clientId: string
}

const FILE_OPTIONS = [
  { value: 'menu.json', label: 'menu.json (菜单配置)' },
  { value: 'model.json', label: 'model.json (模型配置)' },
  { value: 'cron.json', label: 'cron.json (定时任务)' },
  { value: 'todo.json', label: 'todo.json (待办事项)' },
  { value: 'user-map.json', label: 'user-map.json (用户映射)' },
  { value: 'active.json', label: 'active.json (活跃配置)' },
]

export default function FilesTab({ clientId }: Props) {
  const [selectedFile, setSelectedFile] = useState<string>('')
  const [content, setContent] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  const loadFile = async (name: string) => {
    if (!name) return
    setLoading(true)
    try {
      const data = await api.getFile(clientId, name)
      setContent(JSON.stringify(data, null, 2))
      setDirty(false)
    } catch (e: any) {
      message.error(e.message || '加载失败')
      setContent('')
    } finally {
      setLoading(false)
    }
  }

  const handleSelect = (value: string) => {
    setSelectedFile(value)
    loadFile(value)
  }

  const handleSave = async () => {
    if (!selectedFile) return
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
      await api.putFile(clientId, selectedFile, parsed)
      message.success('文件已保存')
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
        <Select
          placeholder="选择文件"
          value={selectedFile || undefined}
          onChange={handleSelect}
          options={FILE_OPTIONS}
          style={{ minWidth: 240 }}
          showSearch
        />
        <Space>
          <Button
            icon={<ReloadOutlined />}
            onClick={() => loadFile(selectedFile)}
            disabled={!selectedFile}
          >
            刷新
          </Button>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            onClick={handleSave}
            loading={saving}
            disabled={!selectedFile || !dirty}
          >
            保存
          </Button>
        </Space>
      </div>

      <Spin spinning={loading}>
        <Card>
          <Input.TextArea
            value={content}
            onChange={e => { setContent(e.target.value); setDirty(true) }}
            rows={20}
            style={{ fontFamily: 'monospace', fontSize: 13 }}
            placeholder="选择文件后加载内容..."
          />
        </Card>
      </Spin>
    </div>
  )
}
