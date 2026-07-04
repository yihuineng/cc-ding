import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ConfigProvider } from 'antd'
import Login from './pages/Login'

function App() {
  return (
    <ConfigProvider theme={{ token: { colorPrimary: '#00ff9d' } }}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<div style={{ padding: 24 }}>CC-DING Console - Client List</div>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </ConfigProvider>
  )
}

export default App
