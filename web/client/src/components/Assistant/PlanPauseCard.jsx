import { GitBranch } from 'lucide-react';

/**
 * 关键抉择暂停面板（HP12）。
 *
 * 拍表已经生成、正文还没开写：作者在这里看一眼要写什么，再决定方向。
 * 三件事必须齐全，少一件就等于把决定权又推回给模型：
 *   - 这一拍的目标（作者要知道自己选的是什么）
 *   - 每个选项的后果（不给后果就是让作者掷骰子）
 *   - 放行与放弃（看完不改也得能往下走）
 */
export default function PlanPauseCard({
  pause,
  chosenLabel = '',
  abandoned = false,
  disabled = false,
  onChoose,
  onAbandon,
}) {
  if (!pause) {
    if (!chosenLabel && !abandoned) return null;
    return (
      <div className="ct-plan-pause">
        <div className="ct-plan-pause-head">
          <GitBranch size={13} />
          <span>{abandoned ? '已放弃这次规划' : `已选：${chosenLabel}`}</span>
        </div>
        <div className="ct-plan-pause-note">
          {abandoned
            ? '计划已留档但不再使用；再发一次写作指令会重新规划。'
            : '正在按这个选择继续写，不会重新规划。'}
        </div>
      </div>
    );
  }

  const options = Array.isArray(pause.options) ? pause.options : [];
  // 只展示有目标的拍，最多 8 条：作者要的是「一眼看清写什么」，不是读完整份 JSON。
  const beats = (Array.isArray(pause.beats) ? pause.beats : [])
    .filter((beat) => beat && beat.id)
    .slice(0, 8);

  return (
    <div className="ct-plan-pause">
      <div className="ct-plan-pause-head">
        <GitBranch size={13} />
        <span>开写前定这一拍</span>
      </div>
      {pause.goal && <div className="ct-plan-pause-goal">本节抉择：{pause.goal}</div>}

      {beats.length > 0 && (
        <ol className="ct-plan-pause-beats">
          {beats.map((beat) => (
            <li key={beat.id} className={beat.id === pause.beatId ? 'is-pause' : ''}>
              <span className="ct-plan-pause-beat-id">{beat.id}</span>
              <span className="ct-plan-pause-beat-type">{beat.type || ''}</span>
              <span className="ct-plan-pause-beat-goal">{beat.goal || ''}</span>
            </li>
          ))}
        </ol>
      )}

      <div className="ct-plan-pause-options">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            className="ct-plan-pause-option"
            disabled={disabled}
            onClick={() => onChoose?.(option.id)}
          >
            <span className="ct-plan-pause-option-label">{option.label}</span>
            <span className="ct-plan-pause-option-consequence">后果：{option.consequence}</span>
          </button>
        ))}
      </div>

      <div className="ct-plan-pause-actions">
        <button
          type="button"
          className="ct-plan-pause-pass"
          disabled={disabled}
          onClick={() => onChoose?.('')}
        >
          按原计划写
        </button>
        <button
          type="button"
          className="ct-plan-pause-abandon"
          disabled={disabled}
          onClick={() => onAbandon?.()}
        >
          放弃这次规划
        </button>
      </div>
    </div>
  );
}
