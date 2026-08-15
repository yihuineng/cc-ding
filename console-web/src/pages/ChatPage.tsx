import React from 'react';
import { useParams } from 'react-router-dom';
import { ChatPanel } from '../components/ChatPanel';

export const ChatPage: React.FC = () => {
  const { clientId, convId } = useParams<{ clientId: string; convId: string }>();

  if (!clientId || !convId) {
    return <div>参数错误</div>;
  }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <ChatPanel clientId={clientId} convId={convId} />
      </div>
    </div>
  );
};
