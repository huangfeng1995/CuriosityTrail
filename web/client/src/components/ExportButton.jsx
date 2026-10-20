import React, { useState } from 'react';
import { Button, Dropdown } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';

/**
 * 导出按钮。
 *
 * 格式选择放在下拉里：作者要的是「导出来给编辑看」，
 * DOCX 是投稿/打印的常规格式，Markdown 留给自己继续用，TXT 最保险。
 *
 * 走 window.open 而不是 axios：文件下载要触发浏览器的下载行为，
 * 走 fetch 拿 blob 再造 a 链接在 Safari 上容易被拦。
 */
const FORMATS = [
  { key: 'docx', label: 'Word 文档（.docx）', ext: 'docx' },
  { key: 'markdown', label: 'Markdown（.md）', ext: 'md' },
  { key: 'txt', label: '纯文本（.txt）', ext: 'txt' },
];

export default function ExportButton({ scope, id, size = 'small', label = '导出', block }) {
  const [busy, setBusy] = useState('');

  const doExport = (format) => {
    const ext = format.ext || format;
    setBusy(ext);
    window.open(`/api/export/${scope}/${id}/${ext}`, '_blank');
    // 浏览器接管下载后这里立刻复位，不阻塞下一次点击
    setTimeout(() => setBusy(''), 1200);
  };

  return (
    <Dropdown
      menu={{
        items: FORMATS.map((f) => ({
          key: f.key,
          label: f.label,
          onClick: () => doExport(f),
        })),
      }}
      trigger={['click']}
      disabled={!id}
    >
      <Button
        size={size}
        block={block}
        icon={<DownloadOutlined />}
        loading={!!busy}
      >
        {label}
      </Button>
    </Dropdown>
  );
}
