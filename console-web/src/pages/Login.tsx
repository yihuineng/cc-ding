import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Form, Input, Button, message } from 'antd'
import { LockOutlined, UserOutlined } from '@ant-design/icons'
import { api } from '../api/client'

export default function Login() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)

  const onFinish = async (values: { account: string; password: string }) => {
    setLoading(true)
    try {
      const data = await api.login(values.account, values.password)
      localStorage.setItem('ccding_token', data.token)
      localStorage.setItem('ccding_account', values.account)
      message.success('登录成功')
      navigate('/')
    } catch (e: any) {
      message.error(e.message || '登录失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', background: '#0a0e14' }}>
      <div style={{ width: 360, padding: 24, background: '#fff', borderRadius: 8, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
        <h2 style={{ textAlign: 'center', marginBottom: 24 }}>🔐 CC-DING Console</h2>
        <Form onFinish={onFinish} size="large">
          <Form.Item name="account" rules={[{ required: true, message: '请输入账号' }]}>
            <Input prefix={<UserOutlined />} placeholder="admin" defaultValue="admin" />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password prefix={<LockOutlined />} placeholder="默认: admin" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading} block>登 录</Button>
          </Form.Item>
        </Form>
      </div>
    </div>
  )
}
