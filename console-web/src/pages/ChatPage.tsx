import React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Button, Card, Typography } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { ChatPanel } from '../components/ChatPanel';

const { Title } = Typography;

export const ChatPage: React.FC = () => {
  const { clientId, convId } = useParams<{ clientId: string; convId: string }>();
  const navigate = useNavigate();

  if (!clientId || !convId) {
    return <div>参数错误</div>;
  }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Card size="small" style={{ borderBottom: '1px solid #f0f0f0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(`/client/${clientId}`)} />
          <Title level={5} style={{ margin: 0 }}>
            会话: {decodeURIComponent(convId)}
          </Title>
        </div>
      </Card>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <ChatPanel clientId={clientId} convId={convId} />
      </div>
    </div>
  );
};
