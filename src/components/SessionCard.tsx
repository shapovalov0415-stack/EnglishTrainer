import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import type { SessionHistoryRow } from '../db/schema';

interface Props {
  session: SessionHistoryRow;
  onOpen: () => void;
  onEdit: () => void;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso.replace(' ', 'T') + 'Z');
    if (Number.isNaN(d.getTime())) return iso;
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
  } catch {
    return iso;
  }
}

function scoreColor(score: number | null): string {
  if (score == null) return '#94A3B8';
  if (score >= 80) return '#22C55E';
  if (score >= 60) return '#60A5FA';
  if (score >= 40) return '#FBBF24';
  return '#F87171';
}

function difficultyBadge(score: number | null): { label: string; bg: string; fg: string } {
  if (score == null) return { label: 'NEW', bg: '#E2E8F0', fg: '#334155' };
  if (score >= 80) return { label: 'GREAT', bg: '#14532D', fg: '#166534' };
  if (score >= 60) return { label: 'GOOD', bg: '#E2E8F0', fg: '#1E40AF' };
  if (score >= 40) return { label: 'FAIR', bg: '#78350F', fg: '#92400E' };
  return { label: 'HARD', bg: '#FEE2E2', fg: '#FCA5A5' };
}

export default function SessionCard({ session, onOpen, onEdit }: Props) {
  const badge = difficultyBadge(session.best_score);
  const color = scoreColor(session.best_score);
  const date = formatDate(session.last_practiced_at ?? session.created_at);

  return (
    <TouchableOpacity
      style={styles.card}
      activeOpacity={0.85}
      onPress={onOpen}
      onLongPress={onEdit}
      delayLongPress={400}
    >
      <View style={styles.cardHeader}>
        <View style={[styles.badge, { backgroundColor: badge.bg }]}>
          <Text style={[styles.badgeText, { color: badge.fg }]}>{badge.label}</Text>
        </View>
        <View style={styles.headerRight}>
          <Text style={styles.cardDate}>{date}</Text>
          <TouchableOpacity
            style={styles.editBtn}
            onPress={onEdit}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            activeOpacity={0.6}
          >
            <Text style={styles.editBtnText}>{'\u22EF'}</Text>
          </TouchableOpacity>
        </View>
      </View>

      <Text style={styles.cardTitle} numberOfLines={2}>
        {session.display_title}
      </Text>

      <View style={styles.cardFooter}>
        <View style={styles.scoreBlock}>
          <Text style={styles.scoreLabel}>BEST</Text>
          <View style={styles.scoreRow}>
            <Text style={[styles.scoreNum, { color }]}>{session.best_score ?? '-'}</Text>
            <Text style={styles.scoreUnit}>/ 100</Text>
          </View>
        </View>
        <View style={styles.cardArrow}>
          <Text style={styles.cardArrowText}>{'\u203A'}</Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#F8FAFC',
    borderRadius: 18,
    padding: 18,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  cardDate: {
    color: '#94A3B8',
    fontSize: 12,
    fontWeight: '600',
  },
  editBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
  },
  editBtnText: {
    color: '#A78BFA',
    fontSize: 18,
    fontWeight: '800',
    marginTop: -4,
  },
  cardTitle: {
    color: '#0F172A',
    fontSize: 17,
    fontWeight: '700',
    lineHeight: 24,
    marginBottom: 16,
  },
  cardFooter: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
  },
  scoreBlock: {
    flexDirection: 'column',
  },
  scoreLabel: {
    color: '#94A3B8',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.8,
    marginBottom: 2,
  },
  scoreRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 3,
  },
  scoreNum: {
    fontSize: 28,
    fontWeight: '800',
  },
  scoreUnit: {
    color: '#94A3B8',
    fontSize: 12,
    fontWeight: '600',
  },
  cardArrow: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardArrowText: {
    color: '#A78BFA',
    fontSize: 22,
    fontWeight: '700',
    marginTop: -2,
  },
});
