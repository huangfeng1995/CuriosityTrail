import React, { useState, useEffect } from 'react';
import { Card, Button, Space, message, Upload, Typography, Row, Col, Statistic } from 'antd';
import { Database, FileText, FolderOpen, TrendingUp } from 'lucide-react';
import { CloudDownloadOutlined, CloudUploadOutlined } from '@ant-design/icons';
import axios from 'axios';
import { BarChart, PieChart } from 'recharts';
import { Bar, Pie, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

const { Title, Paragraph } = Typography;

function Settings({ isDark }) {
  const [backupLoading, setBackupLoading] = useState(false);
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [stats, setStats] = useState({ reports: 0, documents: 0, categories: 0 });
  const [reportTrend, setReportTrend] = useState([]);
  const [categoryDistribution, setCategoryDistribution] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAllData();
  }, []);

  const fetchAllData = async () => {
    setLoading(true);
    try {
      const [reportsRes, docsRes, catsRes] = await Promise.all([
        axios.get('/api/reports'),
        axios.get('/api/documents'),
        axios.get('/api/categories'),
      ]);

      // 统计数据
      setStats({
        reports: reportsRes.data.length,
        documents: docsRes.data.length,
        categories: catsRes.data.filter(c => !c.is_default).length,
      });

      // 报告趋势（基于实际报告的创建时间）
      const reports = reportsRes.data;
      if (reports.length > 0) {
        const monthCounts = {};
        const months = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
        
        // 初始化最近6个月
        for (let i = 5; i >= 0; i--) {
          const date = new Date();
          date.setMonth(date.getMonth() - i);
          const monthKey = `${date.getFullYear()}-${date.getMonth()}`;
          monthCounts[monthKey] = {
            month: months[date.getMonth()],
            count: 0
          };
        }

        // 统计每个月的报告数量
        reports.forEach(report => {
          const date = new Date(report.created_at);
          const monthKey = `${date.getFullYear()}-${date.getMonth()}`;
          if (monthCounts[monthKey]) {
            monthCounts[monthKey].count++;
          }
        });

        const trend = Object.values(monthCounts);
        if (trend.length > 0) {
          setReportTrend(trend);
        }
      }

      // 分类分布（基于实际文献的分类）
      const documents = docsRes.data;
      const categories = catsRes.data;
      
      if (documents.length > 0) {
        const categoryCounts = {};
        
        documents.forEach(doc => {
          const catName = doc.category_name || '未分类';
          categoryCounts[catName] = (categoryCounts[catName] || 0) + 1;
        });

        const distribution = Object.entries(categoryCounts).map(([name, value]) => ({
          name,
          value
        }));

        if (distribution.length > 0) {
          setCategoryDistribution(distribution);
        }
      }
    } catch (err) {
      console.error('获取统计数据失败:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleBackup = async () => {
    try {
      setBackupLoading(true);
      const res = await axios.get('/api/export/backup', { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement('a');
      const timestamp = new Date().toISOString().slice(0, 10);
      link.href = url;
      link.setAttribute('download', `curiosity_backup_${timestamp}.zip`);
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
      <div style={{ 
        display: 'flex', 
        alignItems: 'center', 
        gap: 12,
        marginBottom: 8,
      }}>
        <Title level={2} style={{ 
          margin: 0,
          fontSize: 26,
          fontWeight: 700,
          color: isDark ? '#f9fafb' : '#111827',
          fontFamily: 'Noto Serif SC, serif',
        }}>
          系统设置
        </Title>
      </div>

      <Row gutter={[20, 20]}>
        <Col xs={24} sm={12} lg={8}>
          <Card 
            loading={loading}
            style={{ 
              background: isDark ? '#1f2937' : '#ffffff',
              border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
              borderRadius: 12,
            }}
          >
            <Statistic
              title="探索报告"
              value={stats.reports}
              prefix={<FileText size={20} style={{ color: isDark ? '#60a5fa' : '#1e3a5f' }} />}
              titleStyle={{ color: isDark ? '#9ca3af' : '#6b7280', fontSize: 13 }}
              valueStyle={{ color: isDark ? '#f9fafb' : '#111827', fontSize: 28, fontWeight: 700 }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={8}>
          <Card 
            loading={loading}
            style={{ 
              background: isDark ? '#1f2937' : '#ffffff',
              border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
              borderRadius: 12,
            }}
          >
            <Statistic
              title="文献数量"
              value={stats.documents}
              prefix={<FolderOpen size={20} style={{ color: isDark ? '#f59e0b' : '#d97706' }} />}
              titleStyle={{ color: isDark ? '#9ca3af' : '#6b7280', fontSize: 13 }}
              valueStyle={{ color: isDark ? '#f9fafb' : '#111827', fontSize: 28, fontWeight: 700 }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={24} lg={8}>
          <Card 
            loading={loading}
            style={{ 
              background: isDark ? '#1f2937' : '#ffffff',
              border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
              borderRadius: 12,
            }}
          >
            <Statistic
              title="分类数量"
              value={stats.categories}
              prefix={<Database size={20} style={{ color: isDark ? '#34d399' : '#10b981' }} />}
              titleStyle={{ color: isDark ? '#9ca3af' : '#6b7280', fontSize: 13 }}
              valueStyle={{ color: isDark ? '#f9fafb' : '#111827', fontSize: 28, fontWeight: 700 }}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[20, 20]}>
        <Col xs={24} lg={14}>
          <Card 
            title={
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <TrendingUp size={16} style={{ color: isDark ? '#60a5fa' : '#1e3a5f' }} />
                <span style={{ fontFamily: 'Noto Serif SC, serif', fontWeight: 600 }}>
                  报告增长趋势（近6个月）
                </span>
              </div>
            }
            loading={loading}
            style={{ 
              background: isDark ? '#1f2937' : '#ffffff',
              border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
              borderRadius: 12,
            }}
          >
            {reportTrend.length > 0 ? (
              <div style={{ height: 200 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={reportTrend}>
                    <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#374151' : '#e5e7eb'} />
                    <XAxis 
                      dataKey="month" 
                      tick={{ fill: isDark ? '#9ca3af' : '#6b7280', fontSize: 12 }}
                      axisLine={{ stroke: isDark ? '#374151' : '#e5e7eb' }}
                    />
                    <YAxis 
                      tick={{ fill: isDark ? '#9ca3af' : '#6b7280', fontSize: 12 }}
                      axisLine={{ stroke: isDark ? '#374151' : '#e5e7eb' }}
                      allowDecimals={false}
                    />
                    <Tooltip 
                      contentStyle={{ 
                        background: isDark ? '#1f2937' : '#ffffff',
                        border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
                        borderRadius: 8,
                      }}
                    />
                    <Bar 
                      dataKey="count" 
                      fill={isDark ? '#60a5fa' : '#1e3a5f'} 
                      radius={[4, 4, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div style={{ 
                height: 200, 
                display: 'flex', 
                alignItems: 'center', 
                justifyContent: 'center',
                color: isDark ? '#6b7280' : '#9ca3af',
                fontSize: 14,
              }}>
                暂无报告数据
              </div>
            )}
          </Card>
        </Col>
        <Col xs={24} lg={10}>
          <Card 
            title={
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <FolderOpen size={16} style={{ color: isDark ? '#f59e0b' : '#d97706' }} />
                <span style={{ fontFamily: 'Noto Serif SC, serif', fontWeight: 600 }}>
                  文献分类分布
                </span>
              </div>
            }
            loading={loading}
            style={{ 
              background: isDark ? '#1f2937' : '#ffffff',
              border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
              borderRadius: 12,
            }}
          >
            {categoryDistribution.length > 0 ? (
              <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={categoryDistribution}
                      cx="50%"
                      cy="50%"
                      innerRadius={50}
                      outerRadius={80}
                      paddingAngle={2}
                      dataKey="value"
                      label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                      labelLine={{ stroke: isDark ? '#6b7280' : '#9ca3af' }}
                    >
                      {categoryDistribution.map((entry, index) => (
                        <cell 
                          key={`cell-${index}`} 
                          fill={['#1e3a5f', '#d97706', '#10b981', '#ef4444', '#8b5cf6'][index % 5]} 
                        />
                      ))}
                    </Pie>
                    <Tooltip 
                      contentStyle={{ 
                        background: isDark ? '#1f2937' : '#ffffff',
                        border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
                        borderRadius: 8,
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div style={{ 
                height: 200, 
                display: 'flex', 
                alignItems: 'center', 
                justifyContent: 'center',
                color: isDark ? '#6b7280' : '#9ca3af',
                fontSize: 14,
              }}>
                暂无文献数据
              </div>
            )}
          </Card>
        </Col>
      </Row>

      <Card 
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <CloudDownloadOutlined size={16} style={{ color: isDark ? '#34d399' : '#10b981' }} />
            <span style={{ fontFamily: 'Noto Serif SC, serif', fontWeight: 600 }}>
              数据备份与恢复
            </span>
          </div>
        }
        style={{ 
          background: isDark ? '#1f2937' : '#ffffff',
          border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
          borderRadius: 12,
        }}
      >
        <Paragraph style={{ color: isDark ? '#9ca3af' : '#6b7280' }}>
          备份包含数据库和所有 PDF 文献，以便在需要时恢复。建议定期进行备份以防止数据丢失。
        </Paragraph>
        <Space style={{ marginTop: 16 }}>
          <Button
            type="primary"
            icon={<CloudDownloadOutlined size={16} />}
            onClick={handleBackup}
            loading={backupLoading}
            style={{ borderRadius: 8 }}
          >
            创建备份
          </Button>
          <Upload beforeUpload={handleRestore} showUploadList={false} accept=".zip">
            <Button 
              icon={<CloudUploadOutlined size={16} />} 
              loading={restoreLoading}
              style={{ borderRadius: 8 }}
            >
              恢复备份
            </Button>
          </Upload>
        </Space>
      </Card>
    </Space>
  );
}

export default Settings;
