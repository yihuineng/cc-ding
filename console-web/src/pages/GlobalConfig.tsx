import { useEffect, useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Tabs, Form, Input, InputNumber, Button, Card, Space, Popconfirm, message, Spin, Tag, Collapse, Progress, Modal, Tooltip, Table, Descriptions, Badge } from 'antd'
import { ArrowLeftOutlined, SaveOutlined, PlusOutlined, DeleteOutlined, ReloadOutlined, CheckCircleOutlined, CloseCircleOutlined, DownOutlined, ScanOutlined, CodeOutlined, FileTextOutlined, FormatPainterOutlined, SelectOutlined, CopyOutlined, SyncOutlined, MinusOutlined, RobotOutlined, ScheduleOutlined } from '@ant-design/icons'
import SimpleJsonEditor from '../components/SimpleJsonEditor'
import { api } from '../api/client'
import { IGlobalConfig, IRemoteConsole } from '../types'
import GlobalKeysTab from '../components/GlobalKeysTab'
import GlobalRetryLogsTab from '../components/GlobalRetryLogsTab'
import { globalConfigTypeDefinition } from '../schema/global-config-schema'

const { Panel } = Collapse

interface DiscoveredConsole {
  url: string
  hostname: string
  ccDingVersion: string
  adding?: boolean
}

export default function GlobalConfig() {
  const navigate = useNavigate()
  const [config, setConfig] = useState<IGlobalConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [form] = Form.useForm()

  // Remote console editing state
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [editForm] = Form.useForm()
  const [savingRemote, setSavingRemote] = useState(false)
  const [addModalOpen, setAddModalOpen] = useState(false)
  const [addForm] = Form.useForm()
  const [adding, setAdding] = useState(false)

  // Scan state
  const [scanModalOpen, setScanModalOpen] = useState(false)
  const [scanForm] = Form.useForm()
  const [scanning, setScanning] = useState(false)
  const [scanProgress, setScanProgress] = useState(0)
  const [discoveredConsoles, setDiscoveredConsoles] = useState<DiscoveredConsole[]>([])

  // Settings-tpl state
  const [settingsContent, setSettingsContent] = useState<string>('')
  const [settingsLoading, setSettingsLoading] = useState(false)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [settingsDirty, setSettingsDirty] = useState(false)
  const [settingsValid, setSettingsValid] = useState<boolean | null>(null)
  const [settingsErrors, setSettingsErrors] = useState<string[]>([])
  const settingsTextareaRef = useRef<HTMLTextAreaElement>(null)

  // Raw config state
  const [rawContent, setRawContent] = useState<string>('')
  const [rawLoading, setRawLoading] = useState(false)
  const [rawSaving, setRawSaving] = useState(false)
  const [rawDirty, setRawDirty] = useState(false)
  const [rawValid, setRawValid] = useState<boolean | null>(null)
  const [rawErrors, setRawErrors] = useState<string[]>([])
  const rawTextareaRef = useRef<HTMLTextAreaElement>(null)
  const [typeDefModalOpen, setTypeDefModalOpen] = useState(false)
  const [updatePkgUrl, setUpdatePkgUrl] = useState<string>('')
  const [a2aHubUrl, setA2aHubUrl] = useState<string>('')
  const [a2aApiKey, setA2aApiKey] = useState<string>('')
  const [a2aRemoteAgents, setA2aRemoteAgents] = useState<Array<{id: string; name: string; baseUrl: string; apiKey?: string; defaultSkill?: string}>>([])

  useEffect(() => {
    api.getGlobalConfig()
      .then((data: any) => {
        const configObj = data.config || data
        const configData = configObj.console || configObj
        setConfig(configData)
        form.setFieldsValue(configData)
        setUpdatePkgUrl(configObj.updatePkgUrl || '')
        // Load A2A config
        const a2aCfg = configObj.a2aCfg || {}
        setA2aHubUrl(a2aCfg.hubUrl || '')
        setA2aApiKey(a2aCfg.apiKey || '')
        setA2aRemoteAgents(a2aCfg.remoteAgents || [])
      })
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

  // Remote console functions
  const handleEdit = (rc: IRemoteConsole) => {
    setEditingKey(rc.url)
    editForm.setFieldsValue(rc)
  }

  const handleSaveEdit = async () => {
    try {
      const values = await editForm.validateFields()
      setSavingRemote(true)
      const updatedConsoles = config?.remoteConsoles?.map(rc =>
        rc.url === editingKey ? { ...rc, ...values } : rc
      ) || []
      await api.putGlobalConfig({ ...config, remoteConsoles: updatedConsoles })
      setConfig({ ...config!, remoteConsoles: updatedConsoles })
      setEditingKey(null)
      message.success('远程 Console 已更新')
    } catch (e: any) {
      message.error(e.message || '保存失败')
    } finally {
      setSavingRemote(false)
    }
  }

  const handleDelete = async (url: string) => {
    try {
      const updatedConsoles = config?.remoteConsoles?.filter(rc => rc.url !== url) || []
      await api.putGlobalConfig({ ...config, remoteConsoles: updatedConsoles })
      setConfig({ ...config!, remoteConsoles: updatedConsoles })
      message.success('远程 Console 已删除')
    } catch (e: any) {
      message.error(e.message || '删除失败')
    }
  }

  const handleSyncToAllRemotes = async () => {
    if (!remoteConsoles.length) return
    const loadingMsg = message.loading({ content: '正在同步配置到远程 Console...', duration: 0 })
    let successCount = 0
    let failCount = 0
    const results: string[] = []

    try {
      for (const rc of remoteConsoles) {
        try {
          // Get current remote config first
          const remoteData = await api.getRemoteGlobalConfig(rc.url)
          const remoteConfig = remoteData.config?.console || remoteData.config || {}

          // Merge local config into remote (keep remote's auth settings)
          const mergedConfig = {
            ...remoteConfig,
            port: config?.console?.port,
            host: config?.console?.host,
            updatePkgUrl: (config as any)?.updatePkgUrl,
            apiKeyCfg: (config as any)?.apiKeyCfg,
          }

          await api.putRemoteGlobalConfig(rc.url, mergedConfig)
          successCount++
          results.push(`✓ ${rc.hostname || rc.url}`)
        } catch (e: any) {
          failCount++
          results.push(`✗ ${rc.hostname || rc.url}: ${e.message}`)
        }
      }

      loadingMsg()
      if (failCount === 0) {
        message.success(`同步完成！${successCount} 个远程 Console 配置已更新`)
      } else {
        message.warning(`同步完成！成功 ${successCount} 个，失败 ${failCount} 个`)
      }
    } catch (e: any) {
      loadingMsg()
      message.error(e.message || '同步失败')
    }
  }

  const handleSaveA2A = async () => {
    try {
      const a2aCfg: any = {}
      if (a2aHubUrl.trim()) a2aCfg.hubUrl = a2aHubUrl.trim()
      if (a2aApiKey.trim()) a2aCfg.apiKey = a2aApiKey.trim()
      if (a2aRemoteAgents.length > 0) {
        a2aCfg.remoteAgents = a2aRemoteAgents.filter(a => a.id && a.baseUrl)
      }
      await api.putGlobalConfig({ ...config, a2aCfg: Object.keys(a2aCfg).length > 0 ? a2aCfg : undefined } as any)
      message.success('A2A 配置已保存')
    } catch (e: any) {
      message.error(e.message || '保存失败')
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

  const handleAdd = async () => {
    try {
      const values = await addForm.validateFields()
      setAdding(true)
      const newRc: IRemoteConsole = {
        url: values.url,
        hostname: values.hostname || undefined,
        username: values.username || undefined,
        password: values.password || undefined,
        token: values.token || undefined,
      }
      const updatedConsoles = [...(config?.remoteConsoles || []), newRc]
      await api.putGlobalConfig({ ...config, remoteConsoles: updatedConsoles })
      setConfig({ ...config!, remoteConsoles: updatedConsoles })
      setAddModalOpen(false)
      addForm.resetFields()
      message.success('远程 Console 已添加')
    } catch (e: any) {
      message.error(e.message || '添加失败')
    } finally {
      setAdding(false)
    }
  }

  // Scan functions
  const handleScan = async () => {
    try {
      const values = await scanForm.validateFields()
      setScanning(true)
      setScanProgress(0)
      setDiscoveredConsoles([])

      // Simulate progress
      const progressInterval = setInterval(() => {
        setScanProgress(prev => Math.min(prev + Math.random() * 10, 90))
      }, 500)

      const result = await api.scanRemoteConsoles(values.subnet, values.port, values.timeout)

      clearInterval(progressInterval)
      setScanProgress(100)
      setDiscoveredConsoles(result.discovered || [])
      message.success(`扫描完成，发现 ${result.count} 个 Console`)
    } catch (e: any) {
      message.error(e.message || '扫描失败')
    } finally {
      setScanning(false)
    }
  }

  const handleAddDiscovered = async (console: DiscoveredConsole) => {
    try {
      const newRc: IRemoteConsole = {
        url: console.url,
        hostname: console.hostname || undefined,
      }
      const updatedConsoles = [...(config?.remoteConsoles || []), newRc]
      await api.putGlobalConfig({ ...config, remoteConsoles: updatedConsoles })
      setConfig({ ...config!, remoteConsoles: updatedConsoles })
      setDiscoveredConsoles(prev => prev.filter(c => c.url !== console.url))
      message.success(`已添加 ${console.hostname || console.url}`)
    } catch (e: any) {
      message.error(e.message || '添加失败')
    }
  }

  const handleAddAllDiscovered = async () => {
    try {
      const newConsoles: IRemoteConsole[] = discoveredConsoles.map(c => ({
        url: c.url,
        hostname: c.hostname || undefined,
      }))
      const updatedConsoles = [...(config?.remoteConsoles || []), ...newConsoles]
      await api.putGlobalConfig({ ...config, remoteConsoles: updatedConsoles })
      setConfig({ ...config!, remoteConsoles: updatedConsoles })
      setDiscoveredConsoles([])
      message.success(`已添加 ${newConsoles.length} 个 Console`)
    } catch (e: any) {
      message.error(e.message || '批量添加失败')
    }
  }

  // Settings-tpl functions
  const loadSettingsTpl = async () => {
    setSettingsLoading(true)
    try {
      const data: any = await api.getSettingsTpl()
      const raw = typeof data.content === 'string' ? data.content : JSON.stringify(data, null, 2)
      let parsed
      try { parsed = JSON.parse(raw) } catch { parsed = raw }
      const json = typeof parsed === 'object' ? JSON.stringify(parsed, null, 2) : raw
      setSettingsContent(json)
      setSettingsDirty(false)
      setSettingsValid(true)
      setSettingsErrors([])
    } catch (e: any) {
      message.error(e.message || '加载失败')
    } finally {
      setSettingsLoading(false)
    }
  }

  const handleSettingsValidationError = (errors: string[]) => {
    setSettingsErrors(errors)
    setSettingsValid(errors.length === 0)
  }

  const formatSettingsDocument = () => {
    try {
      const formatted = JSON.stringify(JSON.parse(settingsContent), null, 2)
      setSettingsContent(formatted)
      setSettingsDirty(true)
      message.success('JSON 已格式化')
    } catch (e) {
      message.error('JSON 格式错误，无法格式化')
    }
  }

  const handleSettingsSelectAll = () => {
    if (settingsTextareaRef.current) {
      settingsTextareaRef.current.select()
      settingsTextareaRef.current.focus()
      message.success('已全选')
    }
  }

  const handleSettingsCopy = async () => {
    if (!settingsContent) return
    try {
      await navigator.clipboard.writeText(settingsContent)
      message.success('已复制到剪贴板')
    } catch (e) {
      const textArea = document.createElement('textarea')
      textArea.value = settingsContent
      document.body.appendChild(textArea)
      textArea.select()
      document.execCommand('copy')
      document.body.removeChild(textArea)
      message.success('已复制到剪贴板')
    }
  }

  const handleSaveSettings = async () => {
    if (settingsValid === false) {
      message.error('JSON 格式校验失败，请修正错误后再保存')
      return
    }
    setSettingsSaving(true)
    try {
      let parsed
      try { parsed = JSON.parse(settingsContent) } catch {
        message.error('JSON 格式错误')
        setSettingsSaving(false)
        return
      }
      await api.putSettingsTpl(JSON.stringify(parsed))
      message.success('settings-tpl 已保存')
      setSettingsDirty(false)
    } catch (e: any) {
      message.error(e.message || '保存失败')
    } finally {
      setSettingsSaving(false)
    }
  }

  // Raw config functions
  const loadRawConfig = async () => {
    setRawLoading(true)
    try {
      const data = await api.getGlobalRawConfig()
      setRawContent(data.content)
      setRawDirty(false)
      setRawValid(true)
      setRawErrors([])
    } catch (e: any) {
      message.error(e.message || '加载失败')
    } finally {
      setRawLoading(false)
    }
  }

  const handleRawValidationError = (errors: string[]) => {
    setRawErrors(errors)
    setRawValid(errors.length === 0)
  }

  const formatRawDocument = () => {
    try {
      const formatted = JSON.stringify(JSON.parse(rawContent), null, 2)
      setRawContent(formatted)
      setRawDirty(true)
      message.success('JSON 已格式化')
    } catch (e) {
      message.error('JSON 格式错误，无法格式化')
    }
  }

  const handleRawSelectAll = () => {
    if (rawTextareaRef.current) {
      rawTextareaRef.current.select()
      rawTextareaRef.current.focus()
      message.success('已全选')
    }
  }

  const handleRawCopy = async () => {
    if (!rawContent) return
    try {
      await navigator.clipboard.writeText(rawContent)
      message.success('已复制到剪贴板')
    } catch (e) {
      const textArea = document.createElement('textarea')
      textArea.value = rawContent
      document.body.appendChild(textArea)
      textArea.select()
      document.execCommand('copy')
      document.body.removeChild(textArea)
      message.success('已复制到剪贴板')
    }
  }

  const handleSaveRaw = async () => {
    if (rawValid === false) {
      message.error('JSON 格式或 Schema 校验失败，请修正错误后再保存')
      return
    }
    setRawSaving(true)
    try {
      let parsed
      try { parsed = JSON.parse(rawContent) } catch {
        message.error('JSON 格式错误')
        setRawSaving(false)
        return
      }
      await api.putGlobalRawConfig(JSON.stringify(parsed, null, 2))
      message.success('全局配置已保存')
      setRawDirty(false)
      setRawContent(JSON.stringify(parsed, null, 2))
    } catch (e: any) {
      message.error(e.message || '保存失败')
    } finally {
      setRawSaving(false)
    }
  }

  if (loading) return <div style={{ padding: 24, textAlign: 'center' }}>加载中...</div>
  if (!config) return <div style={{ padding: 24 }}>配置加载失败</div>

  const remoteConsoles = config.remoteConsoles || []

  return (
    <div className="page-container" style={{ padding: 24, maxWidth: 1200, margin: '0 auto' }}>
      <div className="client-detail-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 8 }}>
        <div style={{ flex: '0 0 auto' }}>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/')}>返回</Button>
        </div>
        <div style={{ flex: '1 1 auto', textAlign: 'center' }}>
          <span style={{ fontSize: 16, fontWeight: 600 }}>🌐 全局配置</span>
        </div>
        <div style={{ flex: '0 0 auto' }}></div>
      </div>

      <Tabs defaultActiveKey="console" items={[
        {
          key: 'console',
          label: '⚙️ 基础配置',
          children: (
            <div>
              <Card title="服务配置" style={{ marginBottom: 16 }}>
                <Form form={form} layout="vertical">
                  <Form.Item name="port" label="端口"><InputNumber style={{ width: 200 }} /></Form.Item>
                  <Form.Item name="host" label="Host"><Input style={{ width: 200 }} /></Form.Item>
                  <Button type="primary" icon={<SaveOutlined />} onClick={onSave}>保存</Button>
                </Form>
              </Card>
              <Card title="更新配置">
                <Form layout="vertical">
                  <Form.Item label="更新包下载地址 (updatePkgUrl)">
                    <Input
                      placeholder="http://192.168.3.2:39000/cc-ding/releases/cc-ding-latest.tgz"
                      value={updatePkgUrl}
                      onChange={(e) => setUpdatePkgUrl(e.target.value)}
                      style={{ maxWidth: 600 }}
                    />
                  </Form.Item>
                  <Button
                    type="primary"
                    icon={<SaveOutlined />}
                    onClick={async () => {
                      const value = updatePkgUrl.trim();
                      try {
                        await api.putGlobalConfig({ ...config, updatePkgUrl: value || undefined } as any);
                        message.success('更新包地址已保存');
                      } catch (err: any) {
                        message.error(err.message || '保存失败');
                      }
                    }}
                  >
                    保存
                  </Button>
                  <div style={{ fontSize: 12, color: '#999', marginTop: 12 }}>
                    客户端执行 <code>/reboot --update</code> 时优先从此地址下载安装包
                  </div>
                </Form>
              </Card>
            </div>
          ),
        },
        {
          key: 'remote',
          label: '🌐 远程 Console',
          children: (
            <div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16, gap: 8, flexWrap: 'wrap' }}>
                <Popconfirm
                  title="确定将本地配置同步到所有远程 Console?"
                  description="这将覆盖所有远程 Console 的当前配置"
                  onConfirm={handleSyncToAllRemotes}
                  okText="确定"
                  cancelText="取消"
                >
                  <Button icon={<SyncOutlined />} disabled={remoteConsoles.length === 0}>同步到所有远程</Button>
                </Popconfirm>
                <Button icon={<ScanOutlined />} onClick={() => { setScanModalOpen(true); setDiscoveredConsoles([]); setScanProgress(0); scanForm.resetFields() }}>扫描局域网</Button>
                <Button type="primary" icon={<PlusOutlined />} onClick={() => setAddModalOpen(true)}>添加远程 Console</Button>
              </div>

              {remoteConsoles.length === 0 ? (
                <Card>
                  <div style={{ textAlign: 'center', padding: '40px 0', color: '#999' }}>
                    <div style={{ fontSize: 48, marginBottom: 16 }}>🌐</div>
                    <div>暂无远程 Console 配置</div>
                    <div style={{ fontSize: 12, marginTop: 8 }}>点击右上角"添加远程 Console"按钮开始配置</div>
                  </div>
                </Card>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {remoteConsoles.map(rc => {
                    const isEditing = editingKey === rc.url
                    return (
                      <Card
                        key={rc.url}
                        size="small"
                        styles={{ body: { padding: isEditing ? '12px 16px' : '8px 16px' } }}
                      >
                        {!isEditing ? (
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                            <div>
                              <div style={{ fontWeight: 600, fontSize: 14 }}>
                                {rc.hostname || rc.url}
                                {rc.hostname && <span style={{ color: '#999', fontSize: 12, marginLeft: 8 }}>{rc.url}</span>}
                              </div>
                              <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
                                {rc.username ? `账号: ${rc.username}` : rc.token ? 'Token 认证' : '未配置认证'}
                              </div>
                            </div>
                            <Space>
                              <Button size="small" onClick={() => handleEdit(rc)}>编辑</Button>
                              <Popconfirm title="确定删除?" onConfirm={() => handleDelete(rc.url)}>
                                <Button size="small" danger icon={<DeleteOutlined />} />
                              </Popconfirm>
                            </Space>
                          </div>
                        ) : (
                          <div>
                            <div style={{ marginBottom: 12, fontWeight: 600 }}>编辑远程 Console</div>
                            <Form form={editForm} layout="vertical">
                              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                                <Form.Item name="url" label="Console 地址" rules={[{ required: true, message: '必填' }]} style={{ minWidth: 240 }}>
                                  <Input placeholder="http://192.168.1.100:8080" />
                                </Form.Item>
                                <Form.Item name="hostname" label="主机名 (可选)" style={{ minWidth: 150 }}>
                                  <Input placeholder="显示名称" />
                                </Form.Item>
                              </div>
                              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                                <Form.Item name="username" label="登录账号" style={{ minWidth: 150 }}>
                                  <Input placeholder="admin" />
                                </Form.Item>
                                <Form.Item name="password" label="登录密码" style={{ minWidth: 150 }}>
                                  <Input.Password placeholder="留空不变" />
                                </Form.Item>
                                <Form.Item name="token" label="API Token" style={{ minWidth: 200 }}>
                                  <Input placeholder="与账号密码二选一" />
                                </Form.Item>
                              </div>
                              <Space>
                                <Button type="primary" icon={<SaveOutlined />} onClick={handleSaveEdit} loading={savingRemote}>保存</Button>
                                <Button onClick={() => setEditingKey(null)}>取消</Button>
                              </Space>
                            </Form>
                          </div>
                        )}
                      </Card>
                    )
                  })}
                </div>
              )}

              {/* Scan Modal */}
              {scanModalOpen && (
                <Card size="small" style={{ marginTop: 16, border: '1px solid #1890ff' }}>
                  <div style={{ marginBottom: 12, fontWeight: 600 }}>扫描局域网</div>
                  <Form form={scanForm} layout="vertical" initialValues={{ subnet: '192.168.3', port: 8080, timeout: 2000 }}>
                    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                      <Form.Item name="subnet" label="子网地址" rules={[{ required: true, message: '必填，格式如: 192.168.3' }]} style={{ minWidth: 200 }}>
                        <Input placeholder="192.168.3" />
                      </Form.Item>
                      <Form.Item name="port" label="端口" style={{ minWidth: 120 }}>
                        <InputNumber min={1} max={65535} style={{ width: '100%' }} />
                      </Form.Item>
                      <Form.Item name="timeout" label="超时 (ms)" style={{ minWidth: 120 }}>
                        <InputNumber min={500} max={10000} step={500} style={{ width: '100%' }} />
                      </Form.Item>
                    </div>
                    <Space style={{ marginBottom: 16 }}>
                      <Button type="primary" icon={<ScanOutlined />} onClick={handleScan} loading={scanning}>开始扫描</Button>
                      <Button onClick={() => { setScanModalOpen(false); setDiscoveredConsoles([]); setScanProgress(0); scanForm.resetFields() }}>关闭</Button>
                    </Space>
                  </Form>

                  {scanning && (
                    <div style={{ marginBottom: 16 }}>
                      <Progress percent={Math.round(scanProgress)} status="active" />
                      <div style={{ fontSize: 12, color: '#999', marginTop: 8 }}>正在扫描局域网，请稍候...</div>
                    </div>
                  )}

                  {!scanning && discoveredConsoles.length > 0 && (
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                        <div style={{ fontWeight: 600 }}>发现 {discoveredConsoles.length} 个 Console</div>
                        <Button size="small" type="primary" onClick={handleAddAllDiscovered}>全部添加</Button>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 8 }}>
                        {discoveredConsoles.map(dc => (
                          <Card key={dc.url} size="small" styles={{ body: { padding: '10px 14px' } }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontWeight: 600, fontSize: 13 }}>{dc.hostname || dc.url}</div>
                                <div style={{ fontSize: 11, color: '#999', wordBreak: 'break-all' }}>
                                  {dc.url}
                                  {dc.ccDingVersion && <span style={{ marginLeft: 8 }}>v{dc.ccDingVersion}</span>}
                                </div>
                              </div>
                              <Button size="small" type="primary" onClick={() => handleAddDiscovered(dc)}>添加</Button>
                            </div>
                          </Card>
                        ))}
                      </div>
                    </div>
                  )}

                  {!scanning && discoveredConsoles.length === 0 && scanProgress > 0 && (
                    <div style={{ textAlign: 'center', padding: '20px 0', color: '#999' }}>
                      <div style={{ fontSize: 32, marginBottom: 8 }}>🔍</div>
                      <div>未发现新的 Console</div>
                      <div style={{ fontSize: 12, marginTop: 4 }}>已排除本机和已添加的 Console</div>
                    </div>
                  )}
                </Card>
              )}

              {/* Add Modal */}
              {addModalOpen && (
                <Card size="small" style={{ marginTop: 16, border: '1px solid #00ff9d' }}>
                  <div style={{ marginBottom: 12, fontWeight: 600 }}>添加远程 Console</div>
                  <Form form={addForm} layout="vertical">
                    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                      <Form.Item name="url" label="Console 地址" rules={[{ required: true, message: '必填' }]} style={{ minWidth: 240 }}>
                        <Input placeholder="http://192.168.1.100:8080" />
                      </Form.Item>
                      <Form.Item name="hostname" label="主机名 (可选)" style={{ minWidth: 150 }}>
                        <Input placeholder="显示名称" />
                      </Form.Item>
                    </div>
                    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                      <Form.Item name="username" label="登录账号" style={{ minWidth: 150 }}>
                        <Input placeholder="admin" />
                      </Form.Item>
                      <Form.Item name="password" label="登录密码" style={{ minWidth: 150 }}>
                        <Input.Password placeholder="密码" />
                      </Form.Item>
                      <Form.Item name="token" label="API Token (可选)" style={{ minWidth: 200 }}>
                        <Input placeholder="与账号密码二选一" />
                      </Form.Item>
                    </div>
                    <Space>
                      <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd} loading={adding}>添加</Button>
                      <Button onClick={() => { setAddModalOpen(false); addForm.resetFields() }}>取消</Button>
                    </Space>
                  </Form>
                </Card>
              )}
            </div>
          ),
        },
        {
          key: 'a2a',
          label: '🤖 A2A 配置',
          children: (
            <div>
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
                    <Input.Password
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
                        <Input.Password
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
                <Button type="primary" icon={<SaveOutlined />} onClick={handleSaveA2A}>保存 A2A 配置</Button>
              </div>
            </div>
          ),
        },
        {
          key: 'a2a-panel',
          label: '📊 A2A 监控',
          children: <A2APanel />,
        },
        {
          key: 'settings',
          label: '📝 settings-tpl',
          children: (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, color: '#999' }}>settings-tpl.json 配置模板</span>
                  {settingsValid !== null && (
                    settingsValid ? <Tag icon={<CheckCircleOutlined />} color="success">JSON 有效</Tag>
                                  : <Tag icon={<CloseCircleOutlined />} color="error">JSON 无效</Tag>
                  )}
                  {settingsDirty && <Tag color="warning">未保存</Tag>}
                </div>
                <Space wrap>
                  <Tooltip title="格式化 JSON">
                    <Button icon={<FormatPainterOutlined />} onClick={formatSettingsDocument} disabled={!settingsContent}>格式化</Button>
                  </Tooltip>
                  <Tooltip title="全选内容">
                    <Button icon={<SelectOutlined />} onClick={handleSettingsSelectAll} disabled={!settingsContent}>全选</Button>
                  </Tooltip>
                  <Tooltip title="复制到剪贴板">
                    <Button icon={<CopyOutlined />} onClick={handleSettingsCopy} disabled={!settingsContent}>复制</Button>
                  </Tooltip>
                  <Button icon={<ReloadOutlined />} onClick={loadSettingsTpl} loading={settingsLoading}>刷新</Button>
                  <Button type="primary" icon={<SaveOutlined />} onClick={handleSaveSettings} loading={settingsSaving} disabled={!settingsDirty || settingsValid === false}>保存</Button>
                </Space>
              </div>

              {settingsErrors.length > 0 && (
                <Card size="small" style={{ marginBottom: 16, borderColor: '#ff4d4f' }}>
                  <div style={{ color: '#ff4d4f', fontSize: 13, marginBottom: 8 }}>校验错误 ({settingsErrors.length})</div>
                  <div style={{ maxHeight: 120, overflow: 'auto', fontSize: 12 }}>
                    {settingsErrors.slice(0, 5).map((err, i) => (
                      <div key={i} style={{ color: '#ff4d4f', marginBottom: 4 }}>{err}</div>
                    ))}
                    {settingsErrors.length > 5 && <div style={{ color: '#999' }}>... 还有 {settingsErrors.length - 5} 个错误</div>}
                  </div>
                </Card>
              )}

              <Spin spinning={settingsLoading}>
                <SimpleJsonEditor
                  ref={settingsTextareaRef}
                  value={settingsContent}
                  onChange={(value) => { setSettingsContent(value || ''); setSettingsDirty(true) }}
                  height="500px"
                  onValidationError={handleSettingsValidationError}
                />
              </Spin>
            </div>
          ),
        },
        {
          key: 'apikeys',
          label: '🔑 全局 API Keys',
          children: <GlobalKeysTab />,
        },
        {
          key: 'retrylogs',
          label: '🔄 重试日志',
          children: <GlobalRetryLogsTab />,
        },
        {
          key: 'raw',
          label: '📝 原始JSON',
          children: (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, color: '#999' }}>直接编辑 ~/.cc-ding/config.json</span>
                  {rawValid !== null && (
                    rawValid ? <Tag icon={<CheckCircleOutlined />} color="success">JSON 有效</Tag>
                              : <Tag icon={<CloseCircleOutlined />} color="error">JSON 无效</Tag>
                  )}
                  {rawDirty && <Tag color="warning">未保存</Tag>}
                </div>
                <Space wrap>
                  <Tooltip title="格式化 JSON">
                    <Button icon={<FormatPainterOutlined />} onClick={formatRawDocument} disabled={!rawContent}>格式化</Button>
                  </Tooltip>
                  <Tooltip title="全选内容">
                    <Button icon={<SelectOutlined />} onClick={handleRawSelectAll} disabled={!rawContent}>全选</Button>
                  </Tooltip>
                  <Tooltip title="复制到剪贴板">
                    <Button icon={<CopyOutlined />} onClick={handleRawCopy} disabled={!rawContent}>复制</Button>
                  </Tooltip>
                  <Button icon={<CodeOutlined />} onClick={() => setTypeDefModalOpen(true)}>类型定义</Button>
                  <Button icon={<ReloadOutlined />} onClick={loadRawConfig} loading={rawLoading}>刷新</Button>
                  <Button type="primary" icon={<SaveOutlined />} onClick={handleSaveRaw} loading={rawSaving} disabled={!rawDirty || rawValid === false}>保存</Button>
                </Space>
              </div>

              {rawErrors.length > 0 && (
                <Card size="small" style={{ marginBottom: 16, borderColor: '#ff4d4f' }}>
                  <div style={{ color: '#ff4d4f', fontSize: 13, marginBottom: 8 }}>校验错误 ({rawErrors.length})</div>
                  <div style={{ maxHeight: 120, overflow: 'auto', fontSize: 12 }}>
                    {rawErrors.slice(0, 5).map((err, i) => (
                      <div key={i} style={{ color: '#ff4d4f', marginBottom: 4 }}>{err}</div>
                    ))}
                    {rawErrors.length > 5 && <div style={{ color: '#999' }}>... 还有 {rawErrors.length - 5} 个错误</div>}
                  </div>
                </Card>
              )}

              <Spin spinning={rawLoading}>
                <SimpleJsonEditor
                  ref={rawTextareaRef}
                  value={rawContent}
                  onChange={(value) => { setRawContent(value || ''); setRawDirty(true) }}
                  height="600px"
                  onValidationError={handleRawValidationError}
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
                  value={globalConfigTypeDefinition}
                  height="500px"
                  readOnly={true}
                />
              </Modal>
            </div>
          ),
        },
      ]} />
    </div>
  )
}

/**
 * A2A 监控面板 - 显示接入的 Agents 列表和任务队列
 */
function A2APanel() {
  const [loading, setLoading] = useState(false)
  const [agents, setAgents] = useState<any[]>([])
  const [tasks, setTasks] = useState<any[]>([])
  const [stats, setStats] = useState<any>(null)
  const [error, setError] = useState<string>('')

  const fetchA2AData = async () => {
    setLoading(true)
    setError('')
    try {
      const config = await api.getGlobalConfig()
      const configObj = (config as any)?.config || config
      const a2aCfg = configObj?.a2aCfg
      if (!a2aCfg?.hubUrl) {
        setError('未配置 A2A Hub URL')
        setLoading(false)
        return
      }

      const hubUrl = a2aCfg.hubUrl.replace(/\/$/, '')

      // 并行获取 agents、tasks、stats
      const [agentsRes, tasksRes, statsRes] = await Promise.allSettled([
        fetch(`${hubUrl}/hub/agents`).then(r => r.json()),
        fetch(`${hubUrl}/hub/tasks`).then(r => r.json()),
        fetch(`${hubUrl}/hub/stats`).then(r => r.json()),
      ])

      if (agentsRes.status === 'fulfilled') {
        setAgents(agentsRes.value.agents || [])
      }
      if (tasksRes.status === 'fulfilled') {
        setTasks(tasksRes.value.records || [])
      }
      if (statsRes.status === 'fulfilled') {
        setStats(statsRes.value)
      }
    } catch (e: any) {
      setError(e.message || '获取 A2A 数据失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchA2AData()
    const timer = setInterval(fetchA2AData, 5000)
    return () => clearInterval(timer)
  }, [])

  const agentColumns = [
    {
      title: 'Agent ID',
      dataIndex: 'id',
      key: 'id',
      render: (text: string) => <code>{text}</code>,
    },
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
    },
    {
      title: 'Client',
      dataIndex: 'clientId',
      key: 'clientId',
      render: (text: string) => <code>{text}</code>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => (
        <Badge
          status={status === 'online' ? 'success' : 'default'}
          text={status === 'online' ? '在线' : '离线'}
        />
      ),
    },
    {
      title: '最后心跳',
      dataIndex: 'lastHeartbeat',
      key: 'lastHeartbeat',
      render: (ts: number) => ts ? new Date(ts).toLocaleString() : '-',
    },
  ]

  const taskColumns = [
    {
      title: 'Task ID',
      dataIndex: 'taskId',
      key: 'taskId',
      render: (text: string) => <code style={{ fontSize: 11 }}>{text}</code>,
    },
    {
      title: '目标 Agent',
      dataIndex: 'targetAgentName',
      key: 'targetAgentName',
    },
    {
      title: 'Client',
      dataIndex: 'clientId',
      key: 'clientId',
      render: (text: string) => <code>{text}</code>,
    },
    {
      title: '状态',
      dataIndex: 'state',
      key: 'state',
      render: (state: string) => {
        const colorMap: Record<string, string> = {
          'submitted': 'blue',
          'working': 'orange',
          'completed': 'green',
          'failed': 'red',
        }
        return <Tag color={colorMap[state] || 'default'}>{state}</Tag>
      },
    },
    {
      title: '方法',
      dataIndex: 'method',
      key: 'method',
      render: (method: string) => <code>{method}</code>,
    },
    {
      title: '耗时',
      dataIndex: 'durationMs',
      key: 'durationMs',
      render: (ms: number) => ms ? `${(ms / 1000).toFixed(1)}s` : '-',
    },
  ]

  return (
    <div>
      {/* 统计卡片 */}
      {stats && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 16, marginBottom: 24 }}>
          <Card size="small">
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 24, fontWeight: 600, color: '#1890ff' }}>{stats.agents || 0}</div>
              <div style={{ color: '#666' }}>Agents</div>
            </div>
          </Card>
          <Card size="small">
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 24, fontWeight: 600, color: '#52c41a' }}>{stats.onlineAgents || 0}</div>
              <div style={{ color: '#666' }}>在线</div>
            </div>
          </Card>
          <Card size="small">
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 24, fontWeight: 600, color: '#faad14' }}>{stats.clients || 0}</div>
              <div style={{ color: '#666' }}>客户端</div>
            </div>
          </Card>
          <Card size="small">
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 24, fontWeight: 600, color: '#722ed1' }}>{stats.totalRouted || 0}</div>
              <div style={{ color: '#666' }}>已路由任务</div>
            </div>
          </Card>
          <Card size="small">
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 24, fontWeight: 600, color: '#ff4d4f' }}>{stats.totalErrors || 0}</div>
              <div style={{ color: '#666' }}>任务错误</div>
            </div>
          </Card>
        </div>
      )}

      {/* Agents 列表 */}
      <Card
        title={<span><RobotOutlined /> 接入的 Agents</span>}
        extra={
          <Button size="small" icon={<ReloadOutlined />} onClick={fetchA2AData} loading={loading}>
            刷新
          </Button>
        }
        style={{ marginBottom: 16 }}
      >
        {error && (
          <div style={{ color: '#ff4d4f', marginBottom: 16 }}>
            {error}
          </div>
        )}
        <Table
          columns={agentColumns}
          dataSource={agents}
          rowKey="id"
          size="small"
          pagination={false}
          loading={loading}
          locale={{ emptyText: '暂无接入的 Agents' }}
        />
      </Card>

      {/* 任务队列 */}
      <Card
        title={<span><ScheduleOutlined /> 任务队列</span>}
        style={{ marginBottom: 16 }}
      >
        <Table
          columns={taskColumns}
          dataSource={tasks}
          rowKey="taskId"
          size="small"
          pagination={{ pageSize: 10 }}
          loading={loading}
          locale={{ emptyText: '暂无任务' }}
        />
      </Card>
    </div>
  )
}
