import React, { useState } from 'react';
import { Tooltip, Button } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { BLOCK_TYPES } from './blocks';

/**
 * 底部添加块的按钮组。
 */
export default function BlockPalette({ onAdd }) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button
        type="dashed"
        icon={<PlusOutlined />}
        onClick={() => setOpen(true)}
        style={{ marginTop: 12, width: '100%' }}
      >
        添加内容块
      </Button>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
        marginTop: 12,
        padding: 12,
        border: '1px dashed rgba(128,128,128,0.35)',
        borderRadius: 8,
      }}
    >
      {BLOCK_TYPES.map((t) => (
        <Tooltip key={t.type} title={t.hint}>
          <Button size="small" onClick={() => onAdd(t.type)}>
            {t.label}
          </Button>
        </Tooltip>
      ))}
      <Button size="small" type="text" onClick={() => setOpen(false)}>
        收起
      </Button>
    </div>
  );
}
