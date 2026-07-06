import { useEffect, useState, useRef } from 'react'
import { Card, Button, Space, Spin, Tag, message, Tooltip } from 'antd'
import { SaveOutlined, ReloadOutlined, CheckCircleOutlined, CloseCircleOutlined, FormatPainterOutlined, SelectOutlined, CopyOutlined } from '@ant-design/icons'
import SimpleJsonEditor from './SimpleJsonEditor'
import { api } from '../api/client'

interface Props {
  remoteUrl?: string
}

/** settings-tpl Tab（支持本地/远程） */
export default function SettingsTplTab({ remoteUrl }: Props) {
  const [content, setContent] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [valid, setValid] = useState<boolean | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const loadContent = async () => {
    setLoading(true)
    try {
      const data: any = remoteUrl
        ? await api.getRemoteSettingsTpl(remoteUrl)
        : await api.getSettingsTpl()
      const raw = typeof data.content === 'string' ? data.content : JSON.stringify(data, null, 2)
      let parsed
      try { parsed = JSON.parse(raw) } catch { parsed = raw }
      const json = typeof parsed === 'object' ? JSON.stringify(parsed, null, 2) : raw
      setContent(json)
      setDirty(false)
      setValid(true)
      setErrors([])
    } catch (e: any) {
      message.error(e.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadContent() }, [remoteUrl])

  const handleValidationError = (errs: string[]) => {
    setErrors(errs)
    setValid(errs.length === 0)
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

  const onSave = async () => {
    if (valid === false) {
      message.error('JSON 格式校验失败，请修正错误后再保存')
      return
    }
    setSaving(true)
    try {
      let parsed
      try { parsed = JSON.parse(content) } catch {
        message.error('JSON 格式错误')
        setSaving(false)
        return
      }
      if (remoteUrl) {
        await api.putRemoteSettingsTpl(remoteUrl, JSON.stringify(parsed))
      } else {
        await api.putSettingsTpl(JSON.stringify(parsed))
      }
      message.success('settings-tpl 已保存')
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
          <span style={{ fontSize: 12, color: '#999' }}>settings-tpl.json 配置模板</span>
          {valid !== null && (
            valid ? <Tag icon={<CheckCircleOutlined />} color="success">JSON 有效</Tag>
                  : <Tag icon={<CloseCircleOutlined />} color="error">JSON 无效</Tag>
          )}
          {dirty && <Tag color="warning">未保存</Tag>}
        </div>
        <Space wrap>
          <Tooltip title="格式化 JSON">
            <Button icon={<FormatPainterOutlined />} onClick={formatDocument} disabled={!content}>格式化</Button>
          </Tooltip>
          <Tooltip title="全选内容">
            <Button icon={<SelectOutlined />} onClick={handleSelectAll} disabled={!content}>全选</Button>
          </Tooltip>
          <Tooltip title="复制到剪贴板">
            <Button icon={<CopyOutlined />} onClick={handleCopy} disabled={!content}>复制</Button>
          </Tooltip>
          <Button icon={<ReloadOutlined />} onClick={loadContent} loading={loading}>刷新</Button>
          <Button type="primary" icon={<SaveOutlined />} onClick={onSave} loading={saving} disabled={!dirty || valid === false}>保存</Button>
        </Space>
      </div>

      {errors.length > 0 && (
        <Card size="small" style={{ marginBottom: 16, borderColor: '#ff4d4f' }}>
          <div style={{ color: '#ff4d4f', fontSize: 13, marginBottom: 8 }}>校验错误 ({errors.length})</div>
          <div style={{ maxHeight: 120, overflow: 'auto', fontSize: 12 }}>
            {errors.slice(0, 5).map((err, i) => (
              <div key={i} style={{ color: '#ff4d4f', marginBottom: 4 }}>{err}</div>
            ))}
            {errors.length > 5 && <div style={{ color: '#999' }}>... 还有 {errors.length - 5} 个错误</div>}
          </div>
        </Card>
      )}

      <Spin spinning={loading}>
        <SimpleJsonEditor
          ref={textareaRef}
          value={content}
          onChange={(value) => { setContent(value); setDirty(true) }}
          height="500px"
          onValidationError={handleValidationError}
        />
      </Spin>
    </div>
  )
}
