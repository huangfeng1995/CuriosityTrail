import React, { useState } from 'react';
import { Button, Typography, message } from 'antd';
import { FileTextOutlined, LinkOutlined, ImportOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import api from '../../api/client';

const { Text } = Typography;

/**
 * 来源角标。
 *
 * AI 检索到的参考资料要能溯源——用户点开才知道这段是查来的还是编的。
 * 站内素材可点回素材库详情，外部链接走新标签页。
 * 外部资料看着有用，可以一键存进素材库，下次就不用再查一遍。
 */
export default function CitationBadge({ citations }) {
  const navigate = useNavigate();
  const [saving, setSaving] = useState('');

  if (!citations?.length) return null;

  // 把外部资料存进素材库
  const saveAsMaterial = async (c) => {
    setSaving(c.url);
    try {
      await api.post('/materials', {
        title: c.title || c.url,
        body: c.snippet || '',
        source: '网页',
        sourceUrl: c.url,
        tags: '联网检索',
      });
      message.success('已存入素材库');
    } catch (e) {
      message.error(e.response?.data?.error || '存入素材库失败');
    } finally {
      setSaving('');
    }
  };

  return (
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
      {citations.map((c, i) => (
        <div
          key={c.materialId || c.url || i}
          style={{
            fontSize: 12,
            padding: '6px 8px',
            borderRadius: 6,
            background: 'rgba(128,128,128,0.08)',
            borderLeft: '2px solid rgba(128,128,128,0.35)',
          }}
        >
          <div style={{ opacity: 0.7, marginBottom: 2 }}>
            [{i + 1}] {c.source || '来源'}
            {c.title ? ` · ${c.title}` : ''}
            {c.page ? ` · 第 ${c.page} 页` : ''}
          </div>
          {c.snippet && (
            <div style={{ opacity: 0.85, lineHeight: 1.6 }}>{c.snippet}</div>
          )}
          {c.materialId ? (
            <Button
              type="link"
              size="small"
              icon={<FileTextOutlined />}
              onClick={() => navigate(`/materials?focus=${c.materialId}`)}
              style={{ fontSize: 12, padding: 0, height: 'auto' }}
            >
              查看素材
            </Button>
          ) : c.url ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <a
                href={c.url}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 12, display: 'inline-block', marginTop: 2 }}
              >
                <LinkOutlined style={{ marginRight: 4 }} />
                查看原文
              </a>
              <Button
                type="link"
                size="small"
                icon={<ImportOutlined />}
                loading={saving === c.url}
                onClick={() => saveAsMaterial(c)}
                style={{ fontSize: 12, padding: 0, height: 'auto' }}
              >
                存入素材库
              </Button>
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}
