import { useEffect, useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Tabs, Form, Input, InputNumber, Button, Card, Space, Popconfirm, message, Spin, Tag, Collapse, Table, Progress } from 'antd'
import { ArrowLeftOutlined, SaveOutlined, PlusOutlined, DeleteOutlined, ReloadOutlined, CheckCircleOutlined, CloseCircleOutlined, DownOutlined, ScanOutlined } from '@ant-design/icons'
import Editor, { type OnMount } from '@monaco-editor/react'
import { api } from '../api/client'
import { IGlobalConfig, IRemoteConsole } from '../types'

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
  const settingsEditorRef = useRef<any>(null)

  useEffect(() => {
    api.getGlobalConfig()
      .then((data: any) => {
        const configData = data.config?.console || data.config || data
        setConfig(configData)
        form.setFieldsValue(configData)
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

  const handleSettingsMount: OnMount = (editor, monaco) => {
    settingsEditorRef.current = editor
    monaco.languages.json.jsonDefaults.setDiagnosticsOptions({ validate: true, schemas: [] })
    monaco.editor.onDidChangeMarkers(([uri]) => {
      const markers = monaco.editor.getModelMarkers({ resource: uri })
      const errors = markers.filter(m => m.severity === monaco.MarkerSeverity.Error).map(m => `第 ${m.startLineNumber} 行: ${m.message}`)
      setSettingsErrors(errors)
      setSettingsValid(errors.length === 0)
    })
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
              <Form form={form} layout="vertical">
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
            <div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16, gap: 8 }}>
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
                      <Table
                        dataSource={discoveredConsoles}
                        columns={[
                          { title: '地址', dataIndex: 'url', key: 'url', render: (v: string) => <code>{v}</code> },
                          { title: '主机名', dataIndex: 'hostname', key: 'hostname' },
                          { title: '版本', dataIndex: 'ccDingVersion', key: 'version' },
                          {
                            title: '操作',
                            key: 'action',
                            width: 100,
                            render: (_: any, record: DiscoveredConsole) => (
                              <Button size="small" type="primary" onClick={() => handleAddDiscovered(record)}>添加</Button>
                            ),
                          },
                        ]}
                        rowKey="url"
                        pagination={false}
                        size="small"
                      />
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
                <Space>
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
                <Card styles={{ body: { padding: 0 } }}>
                  <Editor
                    height="500px"
                    defaultLanguage="json"
                    value={settingsContent}
                    theme="vs-dark"
                    onChange={value => { setSettingsContent(value || ''); setSettingsDirty(true) }}
                    onMount={handleSettingsMount}
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
          ),
        },
      ]} />
    </div>
  )
}
