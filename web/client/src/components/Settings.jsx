import React, { useState } from 'react';
import { Card, Button, Space, message, Upload, Typography } from 'antd';
import { CloudUploadOutlined, CloudDownloadOutlined } from '@ant-design/icons';
import axios from 'axios';

const { Title, Paragraph } = Typography;

function Settings() {
  const [backupLoading, setBackupLoading] = useState(false);
  const [restoreLoading, setRestoreLoading] = useState(false);

  const handleBackup = async () => {
    try {
      setBackupLoading(true);
      const res = await axios.get('/api/export/backup', { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement('a');
      const timestamp = new Date().toISOString().slice(0, 10);
      link.href = url;
      link.setAttribute('download', `curiosity_backup_${timestamp}.zip');
      document.body.appendChild(link);
      link.click();
      link.remove();
      message.success('备份成功');
    } catch (err) {
      message.error('备份失败');
    } finally {
      setBackupLoading(false);
    }
  };

  const handleRestore = async (file) => {
    const formData = new FormData();
    formData.append('backup', file);

    try {
      setRestoreLoading(true);
      await axios.post('/api/export/restore', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      message.success('恢复成功，请刷新页面');
    } catch (err) {
      message.error('恢复失败');
    } finally {
      setRestoreLoading(false);
    }
    return false;
  };

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Title level={2}>⚙️ 系统设置</Title>

      <Card title="💾 数据备份与恢复">
        <Paragraph>
          备份包含数据库和所有 PDF 文献，以便在需要时恢复。
        </Paragraph>
        <Space style={{ marginTop: 16 }}>
          <Button
            type="primary"
            icon={<CloudDownloadOutlined />}
            onClick={handleBackup}
            loading={backupLoading}
          >
            创建备份
          </Button>
          <Upload beforeUpload={handleRestore} showUploadList={false} accept=".zip">
            <Button icon={<CloudUploadOutlined />} loading={restoreLoading}>
              恢复备份
            </Button>
          </Upload>
        </Space>
      </Card>
    </Space>
  );
}

export default Settings;
