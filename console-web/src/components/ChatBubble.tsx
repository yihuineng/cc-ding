import React from 'react';
import { Bubble } from 'antd';
import type { IChatMessage } from '../types';

interface ChatBubbleProps {
  message: IChatMessage;
}

export const ChatBubble: React.FC<ChatBubbleProps> = ({ message }) => {
  const isUser = message.role === 'user';

  return (
    <Bubble
      placement={isUser ? 'end' : 'start'}
      content={message.content}
      variant={isUser ? 'filled' : 'outlined'}
      styles={{
        content: {
          backgroundColor: isUser ? '#1677ff' : '#f5f5f5',
          color: isUser ? '#fff' : '#000',
        },
      }}
    />
  );
};
