import React, { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Input,
  Select,
  Form,
  message,
  Spin,
  Typography,
  Tag,
  Empty,
} from 'antd';
import { SendOutlined } from '@ant-design/icons';
import api from '../api/client';

const { Text, Paragraph } = Typography;

/**
 * 用户反馈。
 *
 * 作者在这里提问题、提功能想法、报故障。
 * 提交后能看到自己的反馈与运营回复——反馈不能是黑洞，
 * 投出去就石沉大海，下次就不投了。
 */

const CATEGORY_LABEL = {
  bug: '故障',
  feature: '想要的功能',
  experience: '使用体验',
  other: '其他',
};

const STATUS_LABEL = {
  new: '已收到',
  triaged: '处理中',
  resolved: '已解决',
};

export default function FeedbackPage() {
  const [items, setItems] = useState([]);
  const [categories, setCategories] = useState(Object.keys(CATEGORY_LABEL));
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    try {
      const res = await api.get('/feedback');
      setItems(res.data.items || []);
      if (res.data.categories?.length) setCategories(res.data.categories);
    } catch (e) {
      message.error('反馈记录加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const submit = async (values) => {
    setSubmitting(true);
    try {
      await api.post('/feedback', values);
      form.resetFields();
      message.success('收到了，谢谢');
      load();
    } catch (e) {
      message.error(e.response?.data?.error || '提交失败，请稍后再试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="ct-page">
      <div className="ct-page-head">
        <div>
          <h2 className="ct-page-title font-serif">反馈</h2>
          <p className="ct-page-sub">哪里不好用、想要什么功能、遇到了什么问题</p>
        </div>
      </div>

      <div className="ct-insight-section">
        <Form form={form} layout="vertical" onFinish={submit} requiredMark={false}>
          <Form.Item
            name="category"
            label="类型"
            initialValue="feature"
            rules={[{ required: true, message: '选一个类型' }]}
          >
            <Select
              options={categories.map((c) => ({
                value: c,
                label: CATEGORY_LABEL[c] || c,
              }))}
            />
          </Form.Item>

          <Form.Item
            name="content"
            label="具体说说"
            rules={[
              { required: true, message: '说点什么吧' },
              { max: 2000, message: '2000 字以内就好' },
            ]}
          >
            <Input.TextArea
              rows={5}
              placeholder="比如：导出时想选「只导出已完成章节」，现在只能全导。"
              maxLength={2000}
              showCount
            />
          </Form.Item>

          <Form.Item name="contact" label="联系方式（选填）">
            <Input placeholder="邮箱或微信，方便追问细节" maxLength={120} />
          </Form.Item>

          <Button
            type="primary"
            htmlType="submit"
            icon={<SendOutlined />}
            loading={submitting}
          >
            提交
          </Button>
        </Form>
      </div>

      <div className="ct-insight-section">
        <div className="ct-insight-section-title">我提交过的</div>

        {loading ? (
          <div className="ct-insight-loading">
            <Spin />
          </div>
        ) : items.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有提交过反馈" />
        ) : (
          <div className="ct-feedback-list">
            {items.map((item) => (
              <div key={item.id} className="ct-feedback-item">
                <div className="ct-feedback-item-head">
                  <Tag>{CATEGORY_LABEL[item.category] || item.category}</Tag>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {new Date(item.created_at).toLocaleString('zh-CN')}
                  </Text>
                  <span style={{ flex: 1 }} />
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {STATUS_LABEL[item.status] || item.status}
                  </Text>
                </div>
                <Paragraph className="ct-feedback-item-content">{item.content}</Paragraph>
                {item.reply && (
                  <div className="ct-feedback-item-reply">
                    <Text strong>回复：</Text>
                    {item.reply}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
