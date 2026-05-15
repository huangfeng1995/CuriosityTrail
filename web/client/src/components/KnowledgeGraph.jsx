import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Card, Button, Select, Modal, Space, message, Spin, Tooltip, Typography, Empty, Input } from 'antd';
import { 
  ZoomIn, 
  ZoomOut, 
  ReloadOutlined, 
  DownloadOutlined,
  FullscreenOutlined,
  FullscreenExitOutlined,
  NodeIndexOutlined,
  BulbOutlined,
  PlusOutlined,
  LinkOutlined
} from '@ant-design/icons';
import ForceGraph2D from 'react-force-graph-2d';
import axios from 'axios';
import dayjs from 'dayjs';

const { Title, Text } = Typography;
const { Option } = Select;
const { TextArea } = Input;

function KnowledgeGraph({ isDark }) {
  const [graphData, setGraphData] = useState({ nodes: [], links: [] });
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState('citations');
  const [selectedNode, setSelectedNode] = useState(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [addModalVisible, setAddModalVisible] = useState(false);
  const [reports, setReports] = useState([]);
  const [selectedSource, setSelectedSource] = useState(null);
  const [selectedTarget, setSelectedTarget] = useState(null);
  const [citationContext, setCitationContext] = useState('');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const graphRef = useRef(null);
  const containerRef = useRef(null);

  useEffect(() => {
    fetchGraphData();
    fetchReports();
  }, [viewMode]);

  useEffect(() => {
    if (graphRef.current && graphData.nodes.length > 0) {
      setTimeout(() => {
        graphRef.current.d3Force('charge').strength(-120);
        graphRef.current.d3Force('link').distance(80);
      }, 100);
    }
  }, [graphData]);

  const fetchGraphData = async () => {
    setLoading(true);
    try {
      const res = await axios.get(`/api/graph?type=${viewMode}`);
      setGraphData(res.data);
    } catch (err) {
      message.error('获取图谱数据失败');
    } finally {
      setLoading(false);
    }
  };

  const fetchReports = async () => {
    try {
      const res = await axios.get('/api/reports');
      setReports(res.data);
    } catch (err) {
      console.error('获取报告列表失败');
    }
  };

  const handleNodeClick = useCallback((node) => {
    setSelectedNode(node);
    setModalVisible(true);
    
    if (graphRef.current) {
      graphRef.current.centerAt(node.x, node.y, 1000);
      graphRef.current.zoom(2, 2000);
    }
  }, []);

  const handleNodeRightClick = useCallback((node, event) => {
    event.preventDefault();
    setSelectedNode(node);
    setModalVisible(true);
  }, []);

  const handleZoomIn = () => {
    if (graphRef.current) {
      const currentZoom = graphRef.current.zoom();
      graphRef.current.zoom(currentZoom * 1.5, 400);
    }
  };

  const handleZoomOut = () => {
    if (graphRef.current) {
      const currentZoom = graphRef.current.zoom();
      graphRef.current.zoom(currentZoom / 1.5, 400);
    }
  };

  const handleReset = () => {
    if (graphRef.current) {
      graphRef.current.zoomToFit(400);
    }
  };

  const handleAddCitation = async () => {
    if (!selectedSource || !selectedTarget) {
      message.warning('请选择源报告和目标报告');
      return;
    }

    try {
      await axios.post('/api/graph', {
        source_report_id: selectedSource,
        target_report_id: selectedTarget,
        citation_type: 'reference',
        context: citationContext
      });
      message.success('添加引用成功');
      setAddModalVisible(false);
      setSelectedSource(null);
      setSelectedTarget(null);
      setCitationContext('');
      fetchGraphData();
    } catch (err) {
      message.error('添加引用失败');
    }
  };

  const handleExtractCitations = async (reportId) => {
    try {
      const res = await axios.post('/api/graph/extract', { report_id: reportId });
      message.success(`提取完成，发现 ${res.data.count} 个引用关系`);
      fetchGraphData();
    } catch (err) {
      message.error('提取引用失败');
    }
  };

  const handleExportGraph = () => {
    const dataStr = JSON.stringify(graphData, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `knowledge-graph-${dayjs().format('YYYY-MM-DD')}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen();
      setIsFullscreen(true);
    } else {
      document.exitFullscreen();
      setIsFullscreen(false);
    }
  };

  const getNodeColor = (node) => {
    if (viewMode === 'citations') {
      if (node.citation_count > 5) return '#60a5fa';
      if (node.citation_count > 2) return '#34d399';
      return isDark ? '#9ca3af' : '#6b7280';
    }
    return isDark ? '#fbbf24' : '#d97706';
  };

  const getNodeSize = (node) => {
    if (viewMode === 'citations') {
      return Math.max(8, Math.min(20, node.citation_count * 3 + 6));
    }
    return Math.max(6, Math.min(16, node.frequency * 2 + 4));
  };

  const nodeCanvasObject = useCallback((node, ctx, globalScale) => {
    const label = node.title || node.label;
    const size = getNodeSize(node);
    const color = getNodeColor(node);
    
    ctx.beginPath();
    ctx.arc(node.x, node.y, size, 0, 2 * Math.PI, false);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.2)';
    ctx.lineWidth = 1;
    ctx.stroke();

    if (globalScale > 0.8) {
      const fontSize = Math.max(10, 12 / globalScale);
      ctx.font = `${fontSize}px Inter, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = isDark ? '#f9fafb' : '#111827';
      
      const textWidth = ctx.measureText(label).width;
      const bckgDimensions = [textWidth + 4, fontSize + 4];
      
      ctx.fillStyle = isDark ? 'rgba(17, 24, 39, 0.8)' : 'rgba(255, 255, 255, 0.8)';
      ctx.fillRect(
        node.x - bckgDimensions[0] / 2,
        node.y + size + 2,
        bckgDimensions[0],
        bckgDimensions[1]
      );
      
      ctx.fillStyle = isDark ? '#f9fafb' : '#111827';
      ctx.fillText(label, node.x, node.y + size + 4);
    }
  }, [isDark, viewMode]);

  return (
    <div style={{ position: 'relative', height: '100%' }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 20,
        flexWrap: 'wrap',
        gap: 12,
      }}>
        <div>
          <Title level={2} style={{
            margin: 0,
            fontSize: 26,
            fontWeight: 700,
            color: isDark ? '#f9fafb' : '#111827',
            fontFamily: 'Inter, system-ui, sans-serif',
          }}>
            知识图谱
          </Title>
          <Text style={{ fontSize: 14, color: isDark ? '#6b7280' : '#9ca3af' }}>
            可视化报告间的引用关系
          </Text>
        </div>

        <Space wrap>
          <Select
            value={viewMode}
            onChange={setViewMode}
            style={{ width: 160 }}
            styles={{
              popup: {
                background: isDark ? 'rgba(31, 41, 55, 0.95)' : 'rgba(255, 255, 255, 0.95)',
              }
            }}
          >
            <Option value="citations">
              <Space><NodeIndexOutlined /> 引用关系图</Space>
            </Option>
            <Option value="keywords">
              <Space><BulbOutlined /> 关键词图谱</Space>
            </Option>
          </Select>

          <Button 
            icon={<PlusOutlined />}
            onClick={() => setAddModalVisible(true)}
            type="primary"
          >
            添加引用
          </Button>

          <Button.Group>
            <Tooltip title="放大">
              <Button icon={<ZoomIn />} onClick={handleZoomIn} />
            </Tooltip>
            <Tooltip title="缩小">
              <Button icon={<ZoomOut />} onClick={handleZoomOut} />
            </Tooltip>
            <Tooltip title="重置视图">
              <Button icon={<ReloadOutlined />} onClick={handleReset} />
            </Tooltip>
            <Tooltip title={isFullscreen ? '退出全屏' : '全屏'}>
              <Button icon={isFullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />} onClick={toggleFullscreen} />
            </Tooltip>
          </Button.Group>

          <Tooltip title="导出图谱">
            <Button icon={<DownloadOutlined />} onClick={handleExportGraph} />
          </Tooltip>
        </Space>
      </div>

      <div
        ref={containerRef}
        style={{
          height: 'calc(100vh - 220px)',
          minHeight: 500,
          background: isDark ? 'rgba(15, 23, 42, 0.5)' : 'rgba(248, 249, 250, 0.5)',
          backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)',
          borderRadius: 12,
          border: `1px solid ${isDark ? 'rgba(55, 65, 81, 0.5)' : 'rgba(229, 231, 235, 0.5)'}`,
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        {loading ? (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
          }}>
            <Spin size="large" tip="加载图谱数据..." />
          </div>
        ) : graphData.nodes.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <span style={{ color: isDark ? '#6b7280' : '#9ca3af' }}>
                暂无数据。请先创建报告，或添加引用关系。
              </span>
            }
            style={{ marginTop: 100 }}
          />
        ) : (
          <ForceGraph2D
            ref={graphRef}
            graphData={graphData}
            nodeId="id"
            nodeLabel="title"
            nodeCanvasObject={nodeCanvasObject}
            nodePointerAreaPaint={(node, color, ctx) => {
              const size = getNodeSize(node);
              ctx.fillStyle = color;
              ctx.beginPath();
              ctx.arc(node.x, node.y, size + 5, 0, 2 * Math.PI, false);
              ctx.fill();
            }}
            linkColor={() => isDark ? 'rgba(96, 165, 250, 0.4)' : 'rgba(30, 58, 95, 0.3)'}
            linkWidth={2}
            linkDirectionalArrowLength={6}
            linkDirectionalArrowRelPos={1}
            onNodeClick={handleNodeClick}
            onNodeRightClick={handleNodeRightClick}
            backgroundColor="transparent"
            enableNodeDrag={true}
            enableZoomInteraction={true}
            enablePanInteraction={true}
            minZoom={0.5}
            maxZoom={8}
          />
        )}
      </div>

      <div style={{
        marginTop: 16,
        padding: '12px 16px',
        background: isDark ? 'rgba(31, 41, 55, 0.6)' : 'rgba(255, 255, 255, 0.8)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        borderRadius: 8,
        border: `1px solid ${isDark ? 'rgba(55, 65, 81, 0.5)' : 'rgba(229, 231, 235, 0.5)'}`,
      }}>
        <Text style={{ fontSize: 13, color: isDark ? '#9ca3af' : '#6b7280' }}>
          💡 提示：点击节点查看详情，拖拽调整布局，滚轮缩放。右键点击节点可快速查看详情。
        </Text>
      </div>

      <Modal
        title={
          <Space>
            <LinkOutlined />
            <span>节点详情</span>
          </Space>
        }
        open={modalVisible}
        onCancel={() => setModalVisible(false)}
        footer={[
          <Button key="close" onClick={() => setModalVisible(false)}>
            关闭
          </Button>,
          <Button 
            key="extract"
            icon={<ReloadOutlined />}
            onClick={() => {
              if (selectedNode && selectedNode.id) {
                handleExtractCitations(selectedNode.id);
                setModalVisible(false);
              }
            }}
          >
            自动提取引用
          </Button>
        ]}
        centered
        width={600}
        styles={{
          mask: { backdropFilter: 'blur(4px)' },
          content: {
            background: isDark ? 'rgba(31, 41, 55, 0.95)' : 'rgba(255, 255, 255, 0.95)',
            backdropFilter: 'blur(20px)',
            borderRadius: 12,
          }
        }}
      >
        {selectedNode && (
          <div>
            <Title level={4}>{selectedNode.title || selectedNode.label}</Title>
            <div style={{ marginBottom: 16 }}>
              <Text strong>创建时间：</Text>
              <Text style={{ marginLeft: 8 }}>
                {dayjs(selectedNode.created_at).format('YYYY-MM-DD HH:mm')}
              </Text>
            </div>
            {selectedNode.citation_count !== undefined && (
              <div style={{ marginBottom: 16 }}>
                <Text strong>被引用次数：</Text>
                <Text style={{ marginLeft: 8 }}>{selectedNode.citation_count}</Text>
              </div>
            )}
            {selectedNode.frequency !== undefined && (
              <div style={{ marginBottom: 16 }}>
                <Text strong>出现频率：</Text>
                <Text style={{ marginLeft: 8 }}>{selectedNode.frequency} 次</Text>
              </div>
            )}
            {selectedNode.content && (
              <div>
                <Text strong>内容预览：</Text>
                <div style={{
                  marginTop: 8,
                  padding: 12,
                  background: isDark ? '#111827' : '#f8f9fa',
                  borderRadius: 8,
                  maxHeight: 200,
                  overflow: 'auto',
                }}>
                  <Text style={{ whiteSpace: 'pre-wrap' }}>
                    {selectedNode.content.substring(0, 300)}
                    {selectedNode.content.length > 300 && '...'}
                  </Text>
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      <Modal
        title={
          <Space>
            <PlusOutlined />
            <span>添加引用关系</span>
          </Space>
        }
        open={addModalVisible}
        onCancel={() => setAddModalVisible(false)}
        onOk={handleAddCitation}
        centered
        width={520}
        styles={{
          mask: { backdropFilter: 'blur(4px)' },
          content: {
            background: isDark ? 'rgba(31, 41, 55, 0.95)' : 'rgba(255, 255, 255, 0.95)',
            backdropFilter: 'blur(20px)',
            borderRadius: 12,
          }
        }}
      >
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', marginBottom: 8, fontWeight: 500 }}>
            源报告（引用方） <Text type="secondary">引用其他报告的文档</Text>
          </label>
          <Select
            placeholder="选择引用其他报告的报告"
            value={selectedSource}
            onChange={setSelectedSource}
            style={{ width: '100%' }}
            showSearch
            optionFilterProp="children"
            size="large"
          >
            {reports.map(report => (
              <Option key={report.id} value={report.id}>{report.title}</Option>
            ))}
          </Select>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', marginBottom: 8, fontWeight: 500 }}>
            目标报告（被引用方） <Text type="secondary">被引用的文档</Text>
          </label>
          <Select
            placeholder="选择被引用的报告"
            value={selectedTarget}
            onChange={setSelectedTarget}
            style={{ width: '100%' }}
            showSearch
            optionFilterProp="children"
            size="large"
          >
            {reports.filter(r => r.id !== selectedSource).map(report => (
              <Option key={report.id} value={report.id}>{report.title}</Option>
            ))}
          </Select>
        </div>

        <div>
          <label style={{ display: 'block', marginBottom: 8, fontWeight: 500 }}>
            引用说明 <Text type="secondary">（可选）</Text>
          </label>
          <TextArea
            placeholder="描述引用关系，例如：基于XXX理论的分析..."
            value={citationContext}
            onChange={(e) => setCitationContext(e.target.value)}
            rows={3}
          />
        </div>
      </Modal>
    </div>
  );
}

export default KnowledgeGraph;
