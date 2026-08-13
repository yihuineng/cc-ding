import React, { useEffect, useRef, useState } from 'react';
import { Input, Button, List, Spin, Alert } from 'antd';
import { SendOutlined } from '@ant-design/icons';
import { api } from '../api/client';
import { ChatBubble } from './ChatBubble';
import type { IChatMessage } from '../types';

interface ChatPanelProps {
  clientId: string;
  convId: string;
}

export const ChatPanel: React.FC<ChatPanelProps> = ({ clientId, convId }) => {
  const [messages, setMessages] = useState<IChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<{ isProcessing: boolean; queueLength: number; clientOnline: boolean }>({
    isProcessing: false,
    queueLength: 0,
    clientOnline: true,
  });
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const loadMessages = async () => {
    try {
      const lastTs = messages.length > 0 ? messages[messages.length - 1].timestamp : 0;
      const res = await api.getChatMessages(clientId, convId, { since: lastTs });
      if (res.messages.length > 0) {
        setMessages(prev => [...prev, ...res.messages]);
      }
    } catch (err) {
      console.error('加载消息失败:', err);
    }
  };

  const loadStatus = async () => {
    try {
      const res = await api.getChatStatus(clientId, convId);
      setStatus(res);
    } catch (err) {
      console.error('加载状态失败:', err);
    }
  };

  useEffect(() => {
    setLoading(true);
    loadMessages().finally(() => setLoading(false));
    const interval = setInterval(() => {
      loadMessages();
      loadStatus();
    }, 2000);
    return () => clearInterval(interval);
  }, [clientId, convId]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || status.isProcessing || !status.clientOnline) return;

    const message = input.trim();
    setInput('');
    setSending(true);

    try {
      await api.sendChatMessage(clientId, convId, message);
      // 乐观更新由 API 端完成，这里等待下一次轮询拉取
    } catch (err) {
      console.error('发送失败:', err);
    } finally {
      setSending(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {!status.clientOnline && (
        <Alert message="Client 离线，消息将等待处理" type="warning" showIcon style={{ marginBottom: 12 }} />
      )}
      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        {loading ? (
          <Spin size="large" />
        ) : (
          <List
            dataSource={messages}
            renderItem={(msg) => (
              <List.Item style={{ border: 'none', padding: '8px 0' }}>
                <ChatBubble message={msg} />
              </List.Item>
            )}
          />
        )}
        <div ref={messagesEndRef} />
      </div>
      <div style={{ padding: 16, borderTop: '1px solid #f0f0f0' }}>
        <Input.Search
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={status.isProcessing ? 'Agent 处理中...' : '输入消息...'}
          disabled={status.isProcessing || !status.clientOnline || sending}
          enterButton={<SendOutlined />}
          onSearch={handleSend}
          loading={sending}
        />
        {status.isProcessing && (
          <div style={{ marginTop: 8, color: '#999', fontSize: 12 }}>
            Agent 处理中{status.queueLength > 0 ? `，队列 ${status.queueLength} 条` : ''}...
          </div>
        )}
      </div>
    </div>
  );
};
