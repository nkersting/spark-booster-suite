import React from 'react';
import { BaseEdge, EdgeProps, getBezierPath } from '@xyflow/react';

export default function TaperedEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps) {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const sourceWeight = typeof data?.sourceWeight === 'number' ? data.sourceWeight : 50;
  const targetWeight = typeof data?.targetWeight === 'number' ? data.targetWeight : 50;

  // Stroke width is directly proportional to the average of the two node weights
  const averageWeight = (sourceWeight + targetWeight) / 2;
  const averageStrokeWidth = Math.max(0.1, averageWeight * 1.0);

  return (
    <BaseEdge
      path={edgePath}
      style={{
        stroke: '#76cc76', // Slightly darker mint green
        strokeWidth: averageStrokeWidth,
        opacity: 1, // Full opacity
      }}
    />
  );
}