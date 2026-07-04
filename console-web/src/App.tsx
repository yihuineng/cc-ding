import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import Login from './pages/Login'
import Clients from './pages/Clients'
import ClientDetail from './pages/ClientDetail'

function App() {
  return (
    <ConfigProvider locale={zhCN} theme={{ token: { colorPrimary: '#00ff9d' } }}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<Clients />} />
          <Route path="/client/:clientId" element={<ClientDetail />} />
          <Route path="/client/:clientId/:tab" element={<ClientDetail />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </ConfigProvider>
  )
}

export default App
