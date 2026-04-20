import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { GrowthPoint } from '../types/ai';

interface GrowthChartProps {
  /** Roleplay のスコア (Step 2) */
  roleplayScore: number | null;
  /** Extension のスコア (Step 3) */
  extensionScore: number;
  /** Shadowing ベストスコア (Step 1) */
  shadowingScore: number | null;
  /** 成長ポイント詳細 */
  growthPoints: GrowthPoint[];
}

export default function GrowthChart({
  roleplayScore,
  extensionScore,
  shadowingScore,
  growthPoints,
}: GrowthChartProps) {
  const scores = [
    { label: 'Step 1\nShadowing', score: shadowingScore, color: '#60A5FA' },
    { label: 'Step 2\nRoleplay', score: roleplayScore, color: '#A78BFA' },
    { label: 'Step 3\nExtension', score: extensionScore, color: '#34D399' },
  ];

  return (
    <View style={styles.container}>
      {/* Bar Chart */}
      <Text style={styles.chartTitle}>Score Progress</Text>
      <View style={styles.chartArea}>
        {scores.map((item, idx) => {
          const height = item.score != null ? (item.score / 100) * 120 : 0;
          return (
            <View key={idx} style={styles.barColumn}>
              <Text style={[styles.barScore, { color: item.color }]}>
                {item.score != null ? item.score : '—'}
              </Text>
              <View style={styles.barTrack}>
                <View
                  style={[
                    styles.barFill,
                    {
                      height,
                      backgroundColor: item.color,
                    },
                  ]}
                />
              </View>
              <Text style={styles.barLabel}>{item.label}</Text>
            </View>
          );
        })}
      </View>

      {/* Growth Points */}
      {growthPoints.length > 0 && (
        <View style={styles.growthSection}>
          <Text style={styles.growthTitle}>Growth Details</Text>
          {growthPoints.map((gp, idx) => (
            <View key={idx} style={styles.growthRow}>
              <View style={styles.growthHeader}>
                <Text
                  style={[
                    styles.growthIndicator,
                    { color: gp.improved ? '#34D399' : '#FBBF24' },
                  ]}
                >
                  {gp.improved ? '\u2191' : '\u2192'}
                </Text>
                <Text style={styles.growthCategory}>{gp.category}</Text>
              </View>
              <View style={styles.growthComparison}>
                <View style={styles.growthBefore}>
                  <Text style={styles.growthLabel}>Before</Text>
                  <Text style={styles.growthText}>{gp.before}</Text>
                </View>
                <Text style={styles.growthArrow}>{'\u2192'}</Text>
                <View style={styles.growthAfter}>
                  <Text style={[styles.growthLabel, { color: '#34D399' }]}>
                    Now
                  </Text>
                  <Text style={styles.growthText}>{gp.after}</Text>
                </View>
              </View>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
  chartTitle: {
    color: '#0F172A',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 16,
    textAlign: 'center',
  },
  chartArea: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'flex-end',
    height: 180,
    backgroundColor: '#F8FAFC',
    borderRadius: 16,
    padding: 20,
    paddingBottom: 12,
    marginBottom: 20,
  },
  barColumn: {
    alignItems: 'center',
    flex: 1,
  },
  barScore: {
    fontSize: 18,
    fontWeight: '800',
    marginBottom: 6,
  },
  barTrack: {
    width: 32,
    height: 120,
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    justifyContent: 'flex-end',
    overflow: 'hidden',
  },
  barFill: {
    width: '100%',
    borderRadius: 8,
    minHeight: 4,
  },
  barLabel: {
    color: '#64748B',
    fontSize: 11,
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 14,
  },

  // Growth Points
  growthSection: {
    width: '100%',
  },
  growthTitle: {
    color: '#0F172A',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 12,
  },
  growthRow: {
    backgroundColor: '#F8FAFC',
    borderRadius: 12,
    padding: 16,
    marginBottom: 10,
  },
  growthHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  growthIndicator: {
    fontSize: 18,
    fontWeight: '700',
    marginRight: 8,
  },
  growthCategory: {
    color: '#0F172A',
    fontSize: 15,
    fontWeight: '600',
  },
  growthComparison: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  growthBefore: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    padding: 10,
  },
  growthArrow: {
    color: '#94A3B8',
    fontSize: 16,
    marginHorizontal: 8,
  },
  growthAfter: {
    flex: 1,
    backgroundColor: '#064E3B',
    borderRadius: 8,
    padding: 10,
  },
  growthLabel: {
    color: '#94A3B8',
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 4,
  },
  growthText: {
    color: '#334155',
    fontSize: 13,
    lineHeight: 18,
  },
});
