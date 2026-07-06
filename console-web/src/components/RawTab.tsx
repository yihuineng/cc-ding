import { useEffect, useState, useRef } from 'react'
import { Card, Button, Space, message, Spin, Tag, Modal, Tooltip } from 'antd'
import { SaveOutlined, ReloadOutlined, CheckCircleOutlined, CloseCircleOutlined, CodeOutlined, FileTextOutlined, FormatPainterOutlined, SelectOutlined, CopyOutlined } from '@ant-design/icons'
import SimpleJsonEditor from './SimpleJsonEditor'
import { api } from '../api/client'
import { clientConfigTypeDefinition } from '../schema/client-config-schema'

interface Props {
  clientId: string
}

export default function RawTab({ clientId }: Props) {
  const [content, setContent] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [valid, setValid] = useState<boolean | null>(null)
  const [validationErrors, setValidationErrors] = useState<string[]>([])
  const [typeDefModalOpen, setTypeDefModalOpen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const loadRaw = async () => {
    setLoading(true)
    try {
      const data: any = await api.getRawConfig(clientId)
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
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadRaw() }, [clientId])

  const handleValidationError = (errors: string[]) => {
    setValidationErrors(errors)
    setValid(errors.length === 0)
  }

  const formatDocument = () => {
    try {
      const formatted = JSON.stringify(JSON.parse(content), null, 2)
      setContent(formatted)
      setDirty(true)
      message.success('JSON 已格式化')
    } catch (e) {
      message.error('JSON 格式错误，无法格式化')
    }
  }

  const handleSelectAll = () => {
    if (textareaRef.current) {
      textareaRef.current.select()
      textareaRef.current.focus()
      message.success('已全选')
    }
  }

  const handleCopy = async () => {
    if (!content) return
    try {
      await navigator.clipboard.writeText(content)
      message.success('已复制到剪贴板')
    } catch (e) {
      const textArea = document.createElement('textarea')
      textArea.value = content
      document.body.appendChild(textArea)
      textArea.select()
      document.execCommand('copy')
      document.body.removeChild(textArea)
      message.success('已复制到剪贴板')
    }
  }

  const handleSave = async () => {
    if (valid === false) {
      message.error('JSON 格式校验失败，请修正错误后再保存')
      return
    }
    setSaving(true)
    try {
      let parsed
      try { parsed = JSON.parse(content) } catch {
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
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: '#999' }}>直接编辑 config.json 原始内容</span>
          {valid !== null && (
            valid ? <Tag icon={<CheckCircleOutlined />} color="success">JSON 有效</Tag>
                  : <Tag icon={<CloseCircleOutlined />} color="error">JSON 无效</Tag>
          )}
          {dirty && <Tag color="warning">未保存</Tag>}
        </div>
        <Space wrap>
          <Tooltip title="格式化 JSON">
            <Button icon={<FormatPainterOutlined />} onClick={formatDocument}>格式化</Button>
          </Tooltip>
          <Tooltip title="全选内容">
            <Button icon={<SelectOutlined />} onClick={handleSelectAll}>全选</Button>
          </Tooltip>
          <Tooltip title="复制到剪贴板">
            <Button icon={<CopyOutlined />} onClick={handleCopy}>复制</Button>
          </Tooltip>
          <Button icon={<CodeOutlined />} onClick={() => setTypeDefModalOpen(true)}>类型定义</Button>
          <Button icon={<ReloadOutlined />} onClick={loadRaw}>刷新</Button>
          <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} loading={saving} disabled={!dirty || valid === false}>保存</Button>
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
        <SimpleJsonEditor
          ref={textareaRef}
          value={content}
          onChange={(value) => { setContent(value); setDirty(true) }}
          height="600px"
          onValidationError={handleValidationError}
        />
      </Spin>

      {/* Type Definition Modal */}
      <Modal
        title={
          <span>
            <FileTextOutlined style={{ marginRight: 8 }} />
            TypeScript 类型定义
          </span>
        }
        open={typeDefModalOpen}
        onCancel={() => setTypeDefModalOpen(false)}
        footer={null}
        width={800}
      >
        <SimpleJsonEditor
          value={clientConfigTypeDefinition}
          height="500px"
        />
      </Modal>
    </div>
  )
}
