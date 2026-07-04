import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ConfigProvider } from 'antd'

function App() {
  return (
    <ConfigProvider theme={{ token: { colorPrimary: '#00ff9d' } }}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<div>CC-DING Console</div>} />
        </Routes>
      </BrowserRouter>
    </ConfigProvider>
  )
}

export default App
