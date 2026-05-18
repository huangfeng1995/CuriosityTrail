import React, { useState, useEffect, useRef } from 'react';
import { Input } from 'antd';
import { Search, X, Clock } from 'lucide-react';

function SearchBar({ value, onChange, isDark, mobile }) {
  const [isFocused, setIsFocused] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [searchHistory, setSearchHistory] = useState([]);
  const inputRef = useRef(null);

  useEffect(() => {
    const history = localStorage.getItem('searchHistory');
    if (history) {
      setSearchHistory(JSON.parse(history).slice(0, 10));
    }
  }, []);

  const handleChange = (e) => {
    const newValue = e.target.value;
    onChange(newValue);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && value.trim()) {
      saveToHistory(value.trim());
      setShowHistory(false);
    }
  };

  const saveToHistory = (query) => {
    const newHistory = [query, ...searchHistory.filter(h => h !== query)].slice(0, 10);
    setSearchHistory(newHistory);
    localStorage.setItem('searchHistory', JSON.stringify(newHistory));
  };

  const selectHistory = (query) => {
    onChange(query);
    setShowHistory(false);
    inputRef.current?.focus();
  };

  const clearHistory = () => {
    setSearchHistory([]);
    localStorage.removeItem('searchHistory');
  };

  return (
    <div style={{ position: 'relative', width: mobile ? 'auto' : 360 }}>
      <Input
        ref={inputRef}
        placeholder="搜索报告或文献..."
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onFocus={() => {
          setIsFocused(true);
          setShowHistory(value === '' && searchHistory.length > 0);
        }}
        onBlur={() => setTimeout(() => setIsFocused(false), 200)}
        allowClear
        prefix={
          <Search 
            size={16} 
            style={{ 
              color: isDark ? '#6b7280' : '#9ca3af',
              marginRight: 8,
            }} 
          />
        }
        style={{
          borderRadius: 8,
          height: 38,
          padding: '0 14px',
          background: isDark ? '#111827' : '#f8f9fa',
          border: `1px solid ${isFocused ? (isDark ? '#60a5fa' : '#1e3a5f') : (isDark ? '#374151' : '#e5e7eb')}`,
          boxShadow: isFocused ? (isDark ? '0 0 0 3px rgba(96, 165, 250, 0.1)' : '0 0 0 3px rgba(30, 58, 95, 0.1)') : 'none',
          transition: 'all 0.2s ease',
          color: isDark ? '#f9fafb' : '#111827',
          width: mobile ? '120px' : '100%',
        }}
      />
      
      {showHistory && (
        <div style={{
          position: 'absolute',
          top: '100%',
          left: 0,
          right: 0,
          marginTop: 4,
          background: isDark ? '#1f2937' : '#ffffff',
          borderRadius: 10,
          border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
          boxShadow: isDark ? '0 4px 20px rgba(0,0,0,0.3)' : '0 4px 20px rgba(0,0,0,0.1)',
          zIndex: 1000,
          overflow: 'hidden',
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 16px',
            borderBottom: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Clock size={14} style={{ color: isDark ? '#6b7280' : '#9ca3af' }} />
              <span style={{ 
                fontSize: 13, 
                color: isDark ? '#9ca3af' : '#6b7280',
                fontWeight: 500,
              }}>
                搜索历史
              </span>
            </div>
            <button
              onClick={clearHistory}
              style={{
                fontSize: 12,
                color: isDark ? '#f87171' : '#ef4444',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              清空
            </button>
          </div>
          {searchHistory.map((item, index) => (
            <button
              key={index}
              onClick={() => selectHistory(item)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                padding: '10px 16px',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'background 0.15s ease',
                color: isDark ? '#d1d5db' : '#4b5563',
                fontSize: 14,
              }}
              onMouseEnter={(e) => e.target.style.background = isDark ? '#111827' : '#f8f9fa'}
              onMouseLeave={(e) => e.target.style.background = 'none'}
            >
              <Search size={14} style={{ marginRight: 10, color: isDark ? '#6b7280' : '#9ca3af' }} />
              {item}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default SearchBar;
