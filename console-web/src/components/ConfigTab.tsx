import { useState, useEffect } from 'react'
import { Form, Input, InputNumber, Switch, Button, Card, Row, Col, message, Divider, Space } from 'antd'
import { SaveOutlined, EyeInvisibleOutlined, EyeOutlined } from '@ant-design/icons'
import { api } from '../api/client'
import { IConfig } from '../types'

interface Props {
  clientId: string
  config: IConfig
}

/** 掩码凭证字段：仅显示前后 4 位 */
function maskSecret(value: string | undefined): string {
  if (!value) return ''
  if (value.length <= 8) return '****'
  return value.substring(0, 4) + '****' + value.substring(value.length - 4)
}

export default function ConfigTab({ clientId, config }: Props) {
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)
  // 敏感字段显示/隐藏
  const [showSecrets, setShowSecrets] = useState(false)
  // 原始凭证值（用于保存时对比，避免空覆盖）
  const [originalSecrets, setOriginalSecrets] = useState({
    clientSecret: config.clientSecret || '',
    defaultDingToken: config.defaultDingToken || '',
    dingSecret: config.dingSecret || '',
  })

  useEffect(() => {
    const vals: any = { ...config }
    // 敏感字段用掩码显示
    vals.clientSecret = maskSecret(config.clientSecret)
    vals.defaultDingToken = maskSecret(config.defaultDingToken)
    vals.dingSecret = maskSecret(config.dingSecret)
    // retryCfg 展开为顶层表单字段（用点号 key）
    vals['retryCfg.maxDurationSecs'] = config.retryCfg?.maxDurationSecs
    vals['retryCfg.maxCount'] = config.retryCfg?.maxCount
    vals['retryCfg.minCountForDuration'] = config.retryCfg?.minCountForDuration
    vals['retryCfg.retryCooldownSecs'] = config.retryCfg?.retryCooldownSecs
    // recorderCfg
    vals['recorderCfg.dist'] = config.recorderCfg?.dist
    form.setFieldsValue(vals)
    setOriginalSecrets({
      clientSecret: config.clientSecret || '',
      defaultDingToken: config.defaultDingToken || '',
      dingSecret: config.dingSecret || '',
    })
  }, [config, form])

  const onSave = async () => {
    setSaving(true)
    try {
      const values = await form.validateFields()
      const patches: any = {}

      // 处理敏感凭证：仅当值被修改时才提交（掩码 → 原值不变，非掩码 → 新值）
      const secretFields = ['clientSecret', 'defaultDingToken', 'dingSecret'] as const
      for (const field of secretFields) {
        const val = values[field]
        if (val && val !== maskSecret(originalSecrets[field])) {
          patches[field] = val
          originalSecrets[field] = val // 更新原始值
        }
      }

      // 处理 retryCfg 和 recorderCfg 嵌套字段（dot-path）
      const nestedFields = [
        'retryCfg.maxDurationSecs',
        'retryCfg.maxCount',
        'retryCfg.minCountForDuration',
        'retryCfg.retryCooldownSecs',
        'recorderCfg.dist',
      ]
      for (const key of nestedFields) {
        const val = values[key]
        if (val !== undefined && val !== null && val !== '') {
          patches[key] = val
        }
      }

      // 普通顶层字段
      Object.keys(values).forEach(key => {
        if (secretFields.includes(key as any) || nestedFields.includes(key)) return
        const v = values[key]
        if (v !== undefined && v !== null && v !== '') patches[key] = v
        else if (key === 'taskQueueSize' || key === 'sessionMaxConcurrency') patches[key] = v || undefined
      })

      await api.patchClientConfig(clientId, patches)
      message.success('配置已保存')
    } catch (e: any) {
      message.error(e.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      {/* 基本信息 */}
      <Card title="基本信息" style={{ marginBottom: 16 }}>
        <Form form={form} layout="vertical">
          <Row gutter={[16, 0]}>
            <Col xs={24} sm={12}>
              <Form.Item name="clientName" label="Client 名称"><Input /></Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item name="owner" label="Owner"><Input /></Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item name="model" label="默认模型"><Input /></Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item name="whiteUserList" label="白名单 (逗号分隔)"><Input /></Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item name="adminUserList" label="管理员列表 (逗号分隔)"><Input /></Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item name="ownerConversationId" label="Owner 单聊会话ID"><Input /></Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item name="preBash" label="前置命令 (preBash)"><Input /></Form.Item>
            </Col>
          </Row>
        </Form>
      </Card>

      {/* 钉钉凭证 */}
      <Card title={
        <Space>
          <span>🔐 钉钉凭证</span>
          <Button size="small" type="link" onClick={() => setShowSecrets(!showSecrets)}>
            {showSecrets ? <><EyeInvisibleOutlined /> 隐藏</> : <><EyeOutlined /> 显示</>}
          </Button>
        </Space>
      } style={{ marginBottom: 16 }}>
        <Form form={form} layout="vertical">
          <Row gutter={[16, 0]}>
            <Col xs={24} sm={12}>
              <Form.Item name="clientSecret" label="Client Secret (钉钉 Stream 密钥)">
                <Input.Password visibilityToggle={false} readOnly={!showSecrets} placeholder="请输入 Client Secret" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item name="defaultDingToken" label="Default DingToken (兜底机器人 Token)">
                <Input.Password visibilityToggle={false} readOnly={!showSecrets} placeholder="请输入 DingToken" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item name="dingSecret" label="DingSecret (群消息签名密钥，可选)">
                <Input.Password visibilityToggle={false} readOnly={!showSecrets} placeholder="请输入 DingSecret" />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Card>

      {/* 行为开关 */}
      <Card title="行为开关" style={{ marginBottom: 16 }}>
        <Form form={form} layout="vertical">
          <Row gutter={[16, 0]}>
            <Col xs={12} sm={6}>
              <Form.Item name="debug" label="DEBUG" valuePropName="checked"><Switch /></Form.Item>
            </Col>
            <Col xs={12} sm={6}>
              <Form.Item name="resultOnly" label="结果模式" valuePropName="checked"><Switch /></Form.Item>
            </Col>
            <Col xs={12} sm={6}>
              <Form.Item name="includeThinking" label="思考过程" valuePropName="checked"><Switch /></Form.Item>
            </Col>
            <Col xs={12} sm={6}>
              <Form.Item name="enableMsgToUser" label="单聊消息" valuePropName="checked"><Switch /></Form.Item>
            </Col>
          </Row>
        </Form>
      </Card>

      {/* 性能参数 */}
      <Card title="性能参数" style={{ marginBottom: 16 }}>
        <Form form={form} layout="vertical">
          <Row gutter={[16, 0]}>
            <Col xs={12} sm={6}>
              <Form.Item name="taskQueueSize" label="任务队列大小"><InputNumber style={{ width: '100%' }} /></Form.Item>
            </Col>
            <Col xs={12} sm={6}>
              <Form.Item name="sessionMaxConcurrency" label="最大并发"><InputNumber style={{ width: '100%' }} /></Form.Item>
            </Col>
            <Col xs={12} sm={6}>
              <Form.Item name="maxTurnTimeMins" label="Watchdog 超时(分钟)"><InputNumber style={{ width: '100%' }} /></Form.Item>
            </Col>
            <Col xs={12} sm={6}>
              <Form.Item name="maxAutoRecovery" label="自动恢复次数"><InputNumber style={{ width: '100%' }} /></Form.Item>
            </Col>
            <Col xs={12} sm={6}>
              <Form.Item name="taskHandlerCount" label="任务处理器数量"><InputNumber min={1} max={10} style={{ width: '100%' }} /></Form.Item>
            </Col>
          </Row>
        </Form>
      </Card>

      {/* 无限重试检测 */}
      <Card title=" 无限重试检测" style={{ marginBottom: 16 }}>
        <Form form={form} layout="vertical">
          <Row gutter={[16, 0]}>
            <Col xs={12} sm={8}>
              <Form.Item name="retryCfg.maxDurationSecs" label="最大持续时间 (秒)">
                <InputNumber min={60} style={{ width: '100%' }} placeholder="默认 3600" />
              </Form.Item>
            </Col>
            <Col xs={12} sm={8}>
              <Form.Item name="retryCfg.maxCount" label="最大重试次数">
                <InputNumber min={1} style={{ width: '100%' }} placeholder="默认 50" />
              </Form.Item>
            </Col>
            <Col xs={12} sm={8}>
              <Form.Item name="retryCfg.minCountForDuration" label="持续时间触发最小次数">
                <InputNumber min={1} style={{ width: '100%' }} placeholder="默认 3" />
              </Form.Item>
            </Col>
            <Col xs={12} sm={8}>
              <Form.Item name="retryCfg.retryCooldownSecs" label="Key 冷却时长 (秒)">
                <InputNumber min={30} style={{ width: '100%' }} placeholder="默认 600" />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Card>

      {/* AI Card */}
      <Card title="📱 AI Card (流式输出)" style={{ marginBottom: 16 }}>
        <Form form={form} layout="vertical">
          <Row gutter={[16, 0]}>
            <Col xs={24} sm={12}>
              <Form.Item name="cardTemplateId" label="模板 ID (cardTemplateId)">
                <Input placeholder="钉钉开放平台创建的 AI Card 模板 ID" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item name="cardTemplateKey" label="模板变量名 (默认 content)">
                <Input placeholder="默认 content" />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Card>

      {/* Recorder */}
      <Card title="🎙️ Recorder 模式" style={{ marginBottom: 16 }}>
        <Form form={form} layout="vertical">
          <Row gutter={[16, 0]}>
            <Col xs={24} sm={12}>
              <Form.Item name="recorderCfg.dist" label="保存目录">
                <Input placeholder="默认 .recorder" />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Card>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button type="primary" icon={<SaveOutlined />} onClick={onSave} loading={saving}>保存配置</Button>
      </div>
    </div>
  )
}
