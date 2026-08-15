import React, { useRef, useState } from 'react';
import { Button, message } from 'antd';
import { PaperClipOutlined } from '@ant-design/icons';
import { api } from '../api/client';

interface FileUploadProps {
  clientId: string;
  onFileUploaded: (fileInfo: {
    fileId: string;
    fileName: string;
    mimeType: string;
    size: number;
    url: string;
  }) => void;
}

export const FileUpload: React.FC<FileUploadProps> = ({ clientId, onFileUploaded }) => {
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 50 * 1024 * 1024) {
      message.error('文件过大，最大支持 50MB');
      return;
    }

    setUploading(true);
    try {
      const fileInfo = await api.uploadFile(clientId, file);
      onFileUploaded({
        fileId: fileInfo.fileId,
        fileName: fileInfo.originalName,
        mimeType: fileInfo.mimeType,
        size: fileInfo.size,
        url: fileInfo.url,
      });
      message.success('文件上传成功');
    } catch (err) {
      message.error('文件上传失败');
      console.error(err);
    } finally {
      setUploading(false);
      if (inputRef.current) {
        inputRef.current.value = '';
      }
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        style={{ display: 'none' }}
        onChange={handleFileSelect}
      />
      <Button
        icon={<PaperClipOutlined />}
        loading={uploading}
        onClick={() => inputRef.current?.click()}
        style={{ color: '#8c8c8c' }}
      />
    </>
  );
};
