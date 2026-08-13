import React from 'react';
import { Tag } from 'antd';
import type { IChatMessage } from '../types';

interface ChatBubbleProps {
  message: IChatMessage;
}

export const ChatBubble: React.FC<ChatBubbleProps> = ({ message }) => {
  const isUser = message.role === 'user';

  return (
    <div style={{
      display: 'flex',
      justifyContent: isUser ? 'flex-end' : 'flex-start',
      marginBottom: 12,
    }}>
      <div style={{
        maxWidth: '70%',
        padding: '8px 12px',
        borderRadius: 8,
        backgroundColor: isUser ? '#1677ff' : '#1f1f1f',
        color: isUser ? '#fff' : '#d4dce6',
        border: isUser ? 'none' : '1px solid #2d3d4f',
        wordBreak: 'break-word',
        whiteSpace: 'pre-wrap',
        fontSize: 14,
        lineHeight: 1.6,
      }}>
        <div style={{ marginBottom: 4 }}>
          <Tag color={isUser ? 'blue' : 'green'} style={{ fontSize: 11, margin: 0 }}>
            {isUser ? 'User' : 'Assistant'}
          </Tag>
        </div>
        {message.content}
      </div>
    </div>
  );
};
