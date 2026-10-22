import React, { useState } from 'react';
import { Button, Typography, message } from 'antd';
import {
  FileTextOutlined,
  LinkOutlined,
  ImportOutlined,
  AimOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import api from '../../api/client';

const { Text } = Typography;

/**
 * 来源角标。
 *
 * AI 检索到的参考资料要能溯源——用户点开才知道这段是查来的还是编的。
 * 站内素材可点回素材库详情，外部链接走新标签页。
 * 外部资料看着有用，可以一键存进素材库，下次就不用再查一遍。
 *
 * 「定位」按钮带着片段跳回素材库，服务端会算出这段文字在原文里的位置
 * 和页码，作者不用自己翻三十万字的参考资料。
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

  // 带片段跳回素材库，让页面直接定位到引用出处
  const goToMaterial = (c) => {
    const params = new URLSearchParams();
    params.set('focus', c.materialId);
    if (c.snippet) params.set('snippet', c.snippet);
    navigate(`/materials?${params.toString()}`);
  };

  return (
    <div className="ct-citations">
      {citations.map((c, i) => (
        <div key={c.materialId || c.url || i} className="ct-citation">
          <div className="ct-citation-head">
            [{i + 1}] {c.source || '来源'}
            {c.title ? ` · ${c.title}` : ''}
            {c.page ? ` · 第 ${c.page} 页` : ''}
          </div>
          {c.snippet && <div className="ct-citation-snippet">{c.snippet}</div>}
          {c.materialId ? (
            <span className="ct-citation-actions">
              <Button
                type="link"
                size="small"
                icon={<FileTextOutlined />}
                onClick={() => goToMaterial(c)}
              >
                查看素材
              </Button>
              {c.snippet && (
                <Button
                  type="link"
                  size="small"
                  icon={<AimOutlined />}
                  onClick={() => goToMaterial(c)}
                >
                  定位到原文
                </Button>
              )}
            </span>
          ) : c.url ? (
            <span className="ct-citation-actions">
              <a href={c.url} target="_blank" rel="noreferrer" className="ct-citation-link">
                <LinkOutlined style={{ marginRight: 4 }} />
                查看原文
              </a>
              <Button
                type="link"
                size="small"
                icon={<ImportOutlined />}
                loading={saving === c.url}
                onClick={() => saveAsMaterial(c)}
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
