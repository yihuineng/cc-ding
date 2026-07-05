import { useState, useEffect } from 'react'
import { Form, Input, InputNumber, Switch, Button, Card, Row, Col, message, Divider } from 'antd'
import { SaveOutlined } from '@ant-design/icons'
import { api } from '../api/client'
import { IConfig } from '../types'

interface Props {
  clientId: string
  config: IConfig
}

export default function ConfigTab({ clientId, config }: Props) {
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    form.setFieldsValue(config)
  }, [config, form])

  const onSave = async () => {
    setSaving(true)
    try {
      const values = await form.validateFields()
      const patches: any = {}
      Object.keys(values).forEach(key => {
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
          <Divider />
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
          <Divider />
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
          </Row>
        </Form>
      </Card>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button type="primary" icon={<SaveOutlined />} onClick={onSave} loading={saving}>保存配置</Button>
      </div>
    </div>
  )
}
