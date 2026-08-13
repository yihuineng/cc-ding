import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ConfigProvider, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import Login from './pages/Login'
import Clients from './pages/Clients'
import ClientDetail from './pages/ClientDetail'
import GlobalConfig from './pages/GlobalConfig'
import RemoteGlobalConfig from './pages/RemoteGlobalConfig'
import A2AMonitor from './pages/A2AMonitor'
import { ChatPage } from './pages/ChatPage'

const darkTheme = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: '#00ff9d',
    colorBgBody: '#0a0e14',
    colorBgContainer: '#0f1419',
    colorBgElevated: '#151b23',
    colorBorder: '#1e2733',
    colorBorderSecondary: '#2d3d4f',
    colorText: '#d4dce6',
    colorTextSecondary: '#6b7d93',
    colorTextTertiary: '#3d4f63',
    colorInfo: '#00ff9d',
    colorSuccess: '#00ff9d',
    colorWarning: '#ffb454',
    colorError: '#ff4757',
    borderRadius: 8,
  },
}

function App() {
  return (
    <ConfigProvider locale={zhCN} theme={darkTheme}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<Clients />} />
          <Route path="/client/:clientId" element={<ClientDetail />} />
          <Route path="/client/:clientId/:tab" element={<ClientDetail />} />
          <Route path="/global" element={<GlobalConfig />} />
          <Route path="/global/:tab" element={<GlobalConfig />} />
          <Route path="/remote-global/:remoteUrl" element={<RemoteGlobalConfig />} />
          <Route path="/remote-global/:remoteUrl/:tab" element={<RemoteGlobalConfig />} />
          <Route path="/a2a" element={<A2AMonitor />} />
          <Route path="/client/:clientId/chat/:convId" element={<ChatPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </ConfigProvider>
  )
}

export default App
