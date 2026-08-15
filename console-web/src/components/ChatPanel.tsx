import React, { useEffect, useRef, useState } from 'react';
import { Input, Button, Spin, Alert, Typography, Modal } from 'antd';
import { SendOutlined, LoadingOutlined, InfoCircleOutlined } from '@ant-design/icons';
import { api } from '../api/client';
import { ChatBubble } from './ChatBubble';
import { FileUpload } from './FileUpload';
import type { IChatMessage, IConversation, IAttachment } from '../types';

const { Text } = Typography;

interface ChatPanelProps {
  clientId: string;
  convId: string;
}

export const ChatPanel: React.FC<ChatPanelProps> = ({ clientId, convId }) => {
  const [messages, setMessages] = useState<IChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<IAttachment[]>([]);
  const [status, setStatus] = useState<{ isProcessing: boolean; queueLength: number; clientOnline: boolean }>({
    isProcessing: false,
    queueLength: 0,
    clientOnline: true,
  });
  const [conversation, setConversation] = useState<IConversation | null>(null);
  const [claudeMd, setClaudeMd] = useState<string>('');
  const [showClaudeMd, setShowClaudeMd] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // 用 ref 跟踪已加载的最大时间戳，避免 interval 闭包捕获陈旧 state 导致重复拉取
  const lastTsRef = useRef<number>(0);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const loadMessages = async () => {
    try {
      const res = await api.getChatMessages(clientId, convId, { since: lastTsRef.current });
      if (res.messages.length > 0) {
        const maxTs = res.messages.reduce((m, msg) => Math.max(m, msg.timestamp), lastTsRef.current);
        lastTsRef.current = maxTs;
        setMessages(prev => {
          // 以 id 去重，防止极端情况下重复追加
          const existingIds = new Set(prev.map(m => m.id));
          const fresh = res.messages.filter(m => !existingIds.has(m.id));
          return fresh.length > 0 ? [...prev, ...fresh] : prev;
        });
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

  const loadConversationInfo = async () => {
    try {
      const config = await api.getClientConfig(clientId);
      console.log('加载配置成功，会话列表:', config.conversations?.length);
      // 解码 convId，因为 URL 参数可能被编码
      const decodedConvId = decodeURIComponent(convId);
      const conv = config.conversations?.find(c => c.conversationId === decodedConvId);
      console.log('找到会话:', conv ? { id: conv.conversationId, title: conv.conversationTitle } : '未找到');
      if (conv) {
        setConversation(conv);
      }
    } catch (err) {
      console.error('加载会话信息失败:', err);
    }
  };

  const loadClaudeMd = async () => {
    try {
      console.log('加载 CLAUDE.md, clientId:', clientId, 'convId:', convId);
      const res = await api.getClaudeMd(clientId, convId);
      console.log('CLAUDE.md 响应:', res);
      setClaudeMd(res.content);
    } catch (err) {
      console.error('加载 CLAUDE.md 失败:', err);
    }
  };

  useEffect(() => {
    setLoading(true);
    loadMessages().finally(() => setLoading(false));
    loadConversationInfo();
    loadClaudeMd();
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
    if ((!input.trim() && attachments.length === 0) || status.isProcessing || !status.clientOnline) return;

    const message = input.trim();
    const messageData = {
      message,
      attachments: attachments.length > 0 ? attachments : undefined,
    };

    setInput('');
    setAttachments([]);
    setSending(true);

    try {
      await api.sendChatMessage(clientId, convId, JSON.stringify(messageData));
      // 乐观更新由 API 端完成，这里等待下一次轮询拉取
    } catch (err) {
      console.error('发送失败:', err);
    } finally {
      setSending(false);
    }
  };

  const handleFileUploaded = (fileInfo: {
    fileId: string;
    fileName: string;
    mimeType: string;
    size: number;
    url: string;
  }) => {
    const attachment: IAttachment = {
      type: fileInfo.mimeType.startsWith('image/') ? 'image' : 'file',
      fileId: fileInfo.fileId,
      fileName: fileInfo.fileName,
      mimeType: fileInfo.mimeType,
      size: fileInfo.size,
      url: fileInfo.url,
    };
    setAttachments(prev => [...prev, attachment]);
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          try {
            const fileInfo = await api.uploadFile(clientId, file);
            handleFileUploaded({
              fileId: fileInfo.fileId,
              fileName: file.name || `screenshot_${Date.now()}.png`,
              mimeType: fileInfo.mimeType,
              size: fileInfo.size,
              url: fileInfo.url,
            });
          } catch (err) {
            console.error('粘贴图片上传失败:', err);
          }
        }
        break;
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Shift+Enter 或 Cmd/Ctrl+Enter 发送，Enter 换行
    if (e.key === 'Enter' && (e.shiftKey || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      backgroundColor: '#141414',
    }}>
      {/* 头部区域 */}
      <div style={{
        padding: '12px 16px',
        backgroundColor: '#1f1f1f',
        borderBottom: '1px solid #2d3d4f',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'nowrap',
      }}>
        <div style={{ fontSize: 16, fontWeight: 500, color: '#d4dce6', whiteSpace: 'nowrap' }}>
          {conversation?.conversationTitle || '聊天'}
        </div>
        <div style={{ fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '200px' }}>
          {convId}
        </div>
        <Button
          type="text"
          icon={<InfoCircleOutlined />}
          onClick={() => setShowClaudeMd(true)}
          style={{ color: '#8c8c8c', marginLeft: 'auto', flexShrink: 0 }}
        />
      </div>

      {!status.clientOnline && (
        <Alert
          message="Client 离线，消息将等待处理"
          type="warning"
          showIcon
          style={{ margin: '12px 16px 0', borderRadius: 8 }}
        />
      )}

      {/* 消息列表区域 */}
      <div style={{
        flex: 1,
        overflow: 'auto',
        padding: '16px 20px',
        width: '100%',
        boxSizing: 'border-box',
      }}>
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 60 }}>
            <Spin size="large" />
          </div>
        ) : messages.length === 0 ? (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            color: '#6b7280',
          }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>💬</div>
            <div>开始对话吧</div>
          </div>
        ) : (
          <div style={{ width: '100%' }}>
            {messages.map((msg) => (
              <ChatBubble key={msg.id} message={msg} />
            ))}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* 输入区域 */}
      <div style={{
        padding: '12px 16px 16px',
        backgroundColor: '#1f1f1f',
        borderTop: '1px solid #2d3d4f',
      }}>
        {/* 处理中状态提示 */}
        {status.isProcessing && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 8,
            padding: '6px 12px',
            backgroundColor: 'rgba(22, 119, 255, 0.1)',
            borderRadius: 6,
            fontSize: 12,
          }}>
            <LoadingOutlined style={{ color: '#1677ff' }} />
            <Text style={{ color: '#8c8c8c' }}>
              Agent 处理中{status.queueLength > 0 ? `，队列 ${status.queueLength} 条` : ''}
            </Text>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <FileUpload clientId={clientId} onFileUploaded={handleFileUploaded} />
          <Input.TextArea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={status.isProcessing ? 'Agent 处理中，请稍候...' : '输入消息，Shift+Enter 发送，Enter 换行'}
            disabled={status.isProcessing || !status.clientOnline || sending}
            autoSize={{ minRows: 1, maxRows: 4 }}
            style={{
              resize: 'none',
              borderRadius: 8,
              backgroundColor: '#262626',
              borderColor: '#2d3d4f',
              color: '#d4dce6',
              flex: 1,
            }}
          />
          <Button
            type="primary"
            icon={<SendOutlined />}
            onClick={handleSend}
            loading={sending}
            disabled={(!input.trim() && attachments.length === 0) || status.isProcessing || !status.clientOnline}
            style={{
              height: 'auto',
              borderRadius: 8,
            }}
          >
            发送
          </Button>
        </div>

        {/* 附件预览 */}
        {attachments.length > 0 && (
          <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {attachments.map((att, idx) => (
              <div
                key={idx}
                style={{
                  padding: '4px 8px',
                  backgroundColor: '#2d3d4f',
                  borderRadius: 6,
                  fontSize: 12,
                  color: '#d4dce6',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                {att.type === 'image' ? '🖼️' : '📄'} {att.fileName}
                <span
                  style={{ cursor: 'pointer', color: '#8c8c8c', marginLeft: 4 }}
                  onClick={() => setAttachments(prev => prev.filter((_, i) => i !== idx))}
                >
                  ✕
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* CLAUDE.md 弹窗 */}
      <Modal
        title="CLAUDE.md"
        open={showClaudeMd}
        onCancel={() => setShowClaudeMd(false)}
        footer={null}
        width={800}
        styles={{
          body: {
            maxHeight: '70vh',
            overflow: 'auto',
            backgroundColor: '#1f1f1f',
            padding: '16px',
          },
        }}
      >
        <pre style={{
          margin: 0,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          fontSize: 13,
          lineHeight: 1.6,
          color: '#d4dce6',
          fontFamily: 'monospace',
        }}>
          {claudeMd || '暂无 CLAUDE.md 内容'}
        </pre>
      </Modal>
    </div>
  );
};
