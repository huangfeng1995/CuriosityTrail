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
      <button type="button" className="ct-palette-trigger" onClick={() => setOpen(true)}>
        <PlusOutlined />
        添加内容块
      </button>
    );
  }

  return (
    <div className="ct-palette">
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
