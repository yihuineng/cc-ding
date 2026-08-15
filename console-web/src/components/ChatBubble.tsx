import React from 'react';
import { Avatar, Tooltip } from 'antd';
import { UserOutlined, RobotOutlined, FileOutlined } from '@ant-design/icons';
import type { IChatMessage } from '../types';

interface ChatBubbleProps {
  message: IChatMessage;
}

// 简单的时间格式化
function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  if (isToday) return time;
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

// 附件显示组件
const AttachmentDisplay: React.FC<{ attachments: NonNullable<IChatMessage['attachments']> }> = ({ attachments }) => {
  return (
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {attachments.map((attachment, index) => (
        <div key={index}>
          {attachment.type === 'image' ? (
            <img
              src={attachment.url}
              alt={decodeURIComponent(attachment.fileName)}
              style={{
                maxWidth: 300,
                maxHeight: 300,
                borderRadius: 8,
                cursor: 'pointer',
              }}
              onClick={() => window.open(attachment.url, '_blank')}
              onError={(e) => {
                // 如果图片加载失败，显示为文件链接
                const target = e.target as HTMLImageElement;
                target.style.display = 'none';
                const parent = target.parentElement;
                if (parent && !parent.querySelector('.file-fallback')) {
                  const link = document.createElement('a');
                  link.href = attachment.url;
                  link.download = decodeURIComponent(attachment.fileName);
                  link.className = 'file-fallback';
                  link.style.cssText = `
                    display: inline-flex;
                    align-items: center;
                    gap: 8px;
                    padding: 8px 12px;
                    background-color: #2d3d4f;
                    border-radius: 8px;
                    color: #d4dce6;
                    text-decoration: none;
                  `;
                  link.innerHTML = `📄 ${decodeURIComponent(attachment.fileName)} <span style="font-size: 12px; color: #8c8c8c;">(${(attachment.size / 1024).toFixed(1)} KB)</span>`;
                  parent.appendChild(link);
                }
              }}
            />
          ) : (
            <a
              href={attachment.url}
              download={decodeURIComponent(attachment.fileName)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 12px',
                backgroundColor: '#2d3d4f',
                borderRadius: 8,
                color: '#d4dce6',
                textDecoration: 'none',
              }}
            >
              <FileOutlined />
              <span>{decodeURIComponent(attachment.fileName)}</span>
              <span style={{ fontSize: 12, color: '#8c8c8c' }}>
                ({(attachment.size / 1024).toFixed(1)} KB)
              </span>
            </a>
          )}
        </div>
      ))}
    </div>
  );
};

export const ChatBubble: React.FC<ChatBubbleProps> = ({ message }) => {
  const isUser = message.role === 'user';
  const senderName = message.senderNick || (isUser ? '用户' : 'AI');

  if (isUser) {
    // 用户消息：内容在右，头像在最右
    return (
      <div style={{ display: 'flex', alignItems: 'flex-start', marginBottom: 16, width: '100%' }}>
        <div style={{ flex: 1 }} />
        <div style={{ maxWidth: '75%', minWidth: 0, marginRight: 8 }}>
          <div style={{ fontSize: 12, color: '#8c8c8c', marginBottom: 4, textAlign: 'right' }}>
            {senderName}
          </div>
          <div style={{
            padding: '10px 14px',
            borderRadius: '16px 16px 4px 16px',
            backgroundColor: '#1677ff',
            color: '#fff',
            wordBreak: 'break-word',
            whiteSpace: 'pre-wrap',
            fontSize: 14,
            lineHeight: 1.6,
            boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
          }}>
            {message.content}
          </div>
          {message.attachments && message.attachments.length > 0 && (
            <AttachmentDisplay attachments={message.attachments} />
          )}
          <Tooltip title={new Date(message.timestamp).toLocaleString('zh-CN')}>
            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4, textAlign: 'right' }}>
              {formatTime(message.timestamp)}
            </div>
          </Tooltip>
        </div>
        <Avatar
          size={32}
          icon={<UserOutlined />}
          style={{ backgroundColor: '#1677ff', flexShrink: 0 }}
        />
      </div>
    );
  }

  // AI 消息：头像在左，内容在右
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', marginBottom: 16, width: '100%' }}>
      <Avatar
        size={32}
        icon={<RobotOutlined />}
        style={{ backgroundColor: '#52c41a', flexShrink: 0 }}
      />
      <div style={{ maxWidth: '75%', minWidth: 0, marginLeft: 8 }}>
        <div style={{ fontSize: 12, color: '#8c8c8c', marginBottom: 4, textAlign: 'left' }}>
          {senderName}
        </div>
        <div style={{
          padding: '10px 14px',
          borderRadius: '16px 16px 16px 4px',
          backgroundColor: '#262626',
          color: '#d4dce6',
          border: '1px solid #2d3d4f',
          wordBreak: 'break-word',
          whiteSpace: 'pre-wrap',
          fontSize: 14,
          lineHeight: 1.6,
          boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
        }}>
          {message.content}
        </div>
        {message.attachments && message.attachments.length > 0 && (
          <AttachmentDisplay attachments={message.attachments} />
        )}
        <Tooltip title={new Date(message.timestamp).toLocaleString('zh-CN')}>
          <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4, textAlign: 'left' }}>
            {formatTime(message.timestamp)}
          </div>
        </Tooltip>
      </div>
      <div style={{ flex: 1 }} />
    </div>
  );
};
