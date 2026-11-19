import React from 'react';
import { EMPTY_TABLE, fillFromGrid, parseTsv } from './tableModel';

/**
 * 设定表格的网格编辑器。
 *
 * 作者直接填格子，内容落库时再写成 Markdown 表格——
 * 手打竖线、分隔行的活由这里接手。
 *
 * 支持从 Excel / 飞书表格复制一块区域，粘贴到任意格子，
 * 按锚点自动铺开，不用一格一格粘。
 */
export default function SettingTable({ table, onChange }) {
  const current = table || EMPTY_TABLE;
  const cols = Math.max(1, current.header.length, ...current.rows.map((r) => r.length));

  const setCell = (rowIndex, colIndex, value) => {
    const header = [...current.header];
    const rows = current.rows.map((r) => [...r]);
    if (rowIndex < 0) {
      while (header.length < cols) header.push('');
      header[colIndex] = value;
    } else {
      while (rows[rowIndex].length < cols) rows[rowIndex].push('');
      rows[rowIndex][colIndex] = value;
    }
    onChange({ header, rows });
  };

  const addRow = () =>
    onChange({
      header: [...current.header],
      rows: [...current.rows, Array.from({ length: cols }, () => '')],
    });

  const addCol = () =>
    onChange({
      header: [...current.header, ''],
      rows: current.rows.map((r) => [...r, '']),
    });

  const removeRow = (rowIndex) =>
    onChange({
      header: [...current.header],
      rows: current.rows.filter((_, i) => i !== rowIndex),
    });

  const removeCol = (colIndex) => {
    if (cols <= 1) return;
    const header = current.header.slice();
    while (header.length < cols) header.push('');
    onChange({
      header: header.filter((_, i) => i !== colIndex),
      rows: current.rows.map((r) => {
        const next = r.slice();
        while (next.length < cols) next.push('');
        return next.filter((_, i) => i !== colIndex);
      }),
    });
  };

  const onPaste = (event, rowIndex, colIndex) => {
    const text = event.clipboardData?.getData('text/plain') || '';
    if (!text || !/[\t\n]/.test(text)) return;
    event.preventDefault();
    onChange(fillFromGrid(current, parseTsv(text), rowIndex, colIndex));
  };

  const cellProps = (rowIndex, colIndex, placeholder) => ({
    value:
      rowIndex < 0
        ? current.header[colIndex] ?? ''
        : current.rows[rowIndex]?.[colIndex] ?? '',
    placeholder,
    'aria-label': rowIndex < 0 ? `第 ${colIndex + 1} 列名` : `第 ${rowIndex + 1} 行第 ${colIndex + 1} 列`,
    onChange: (e) => setCell(rowIndex, colIndex, e.target.value),
    onPaste: (e) => onPaste(e, rowIndex, colIndex),
  });

  return (
    <div className="ct-te">
      <div className="ct-te-bar">
        <span className="ct-te-count">
          {current.rows.length} 行 · {cols} 列
        </span>
        <button type="button" className="ct-te-add" onClick={addRow}>
          + 行
        </button>
        <button type="button" className="ct-te-add" onClick={addCol}>
          + 列
        </button>
      </div>

      <div className="ct-te-scroll">
        <table className="ct-te-table">
          <thead>
            <tr>
              {Array.from({ length: cols }, (_, colIndex) => (
                <th key={colIndex}>
                  <input {...cellProps(-1, colIndex, '列名')} />
                  <button
                    type="button"
                    className="ct-te-op"
                    title="删掉这一列"
                    aria-label={`删掉第 ${colIndex + 1} 列`}
                    onClick={() => removeCol(colIndex)}
                  >
                    ×
                  </button>
                </th>
              ))}
              <th className="ct-te-tail" aria-hidden="true" />
            </tr>
          </thead>
          <tbody>
            {current.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {Array.from({ length: cols }, (_, colIndex) => (
                  <td key={colIndex}>
                    <input {...cellProps(rowIndex, colIndex, '')} />
                  </td>
                ))}
                <td className="ct-te-tail">
                  <button
                    type="button"
                    className="ct-te-op"
                    title="删掉这一行"
                    aria-label={`删掉第 ${rowIndex + 1} 行`}
                    onClick={() => removeRow(rowIndex)}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="ct-te-note">可从 Excel 或飞书表格整块粘贴。</p>
    </div>
  );
}
