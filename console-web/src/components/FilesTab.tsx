import { useState, useRef } from 'react'
import { Card, Select, Button, Space, message, Spin, Tag } from 'antd'
import { SaveOutlined, ReloadOutlined, CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons'
import Editor, { type OnMount } from '@monaco-editor/react'
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
  const [valid, setValid] = useState<boolean | null>(null)
  const [validationErrors, setValidationErrors] = useState<string[]>([])
  const editorRef = useRef<any>(null)

  const loadFile = async (name: string) => {
    if (!name) return
    setLoading(true)
    try {
      const data: any = await api.getFile(clientId, name)
      // API returns { content: "..." } or the raw object directly
      const raw = typeof data.content === 'string' ? data.content : JSON.stringify(data, null, 2)
      let parsed
      try { parsed = JSON.parse(raw) } catch { parsed = raw }
      const json = typeof parsed === 'object' ? JSON.stringify(parsed, null, 2) : raw
      setContent(json)
      setDirty(false)
      setValid(true)
      setValidationErrors([])
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

  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor
    monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
      validate: true,
      schemas: [],
    })
    monaco.editor.onDidChangeMarkers(([uri]) => {
      const markers = monaco.editor.getModelMarkers({ resource: uri })
      const errors = markers
        .filter(m => m.severity === monaco.MarkerSeverity.Error)
        .map(m => `第 ${m.startLineNumber} 行: ${m.message}`)
      setValidationErrors(errors)
      setValid(errors.length === 0)
    })
  }

  const handleSave = async () => {
    if (!selectedFile) return
    if (valid === false) {
      message.error('JSON 格式校验失败，请修正错误后再保存')
      return
    }
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
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Select
            placeholder="选择文件"
            value={selectedFile || undefined}
            onChange={handleSelect}
            options={FILE_OPTIONS}
            style={{ minWidth: 240 }}
            showSearch
          />
          {valid !== null && selectedFile && (
            valid ? <Tag icon={<CheckCircleOutlined />} color="success">JSON 有效</Tag>
                  : <Tag icon={<CloseCircleOutlined />} color="error">JSON 无效</Tag>
          )}
          {dirty && <Tag color="warning">未保存</Tag>}
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => loadFile(selectedFile)} disabled={!selectedFile}>刷新</Button>
          <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} loading={saving} disabled={!selectedFile || !dirty || valid === false}>保存</Button>
        </Space>
      </div>

      {validationErrors.length > 0 && (
        <Card size="small" style={{ marginBottom: 16, borderColor: '#ff4d4f' }}>
          <div style={{ color: '#ff4d4f', fontSize: 13, marginBottom: 8 }}>校验错误 ({validationErrors.length})</div>
          <div style={{ maxHeight: 120, overflow: 'auto', fontSize: 12 }}>
            {validationErrors.slice(0, 5).map((err, i) => (
              <div key={i} style={{ color: '#ff4d4f', marginBottom: 4 }}>{err}</div>
            ))}
            {validationErrors.length > 5 && <div style={{ color: '#999' }}>... 还有 {validationErrors.length - 5} 个错误</div>}
          </div>
        </Card>
      )}

      <Spin spinning={loading}>
        <Card styles={{ body: { padding: 0 } }}>
          <Editor
            height="600px"
            defaultLanguage="json"
            value={content}
            theme="vs-dark"
            onChange={value => { setContent(value || ''); setDirty(true) }}
            onMount={handleEditorMount}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              lineHeight: 20,
              scrollBeyondLastLine: false,
              roundedSelection: true,
              formatOnPaste: true,
              formatOnType: true,
              automaticLayout: true,
              tabSize: 2,
            }}
          />
        </Card>
      </Spin>
    </div>
  )
}
