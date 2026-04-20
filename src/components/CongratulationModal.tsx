import React, { useEffect, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
  Dimensions,
} from 'react-native';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

interface CongratulationModalProps {
  visible: boolean;
  score: number;
  onGoHome: () => void;
}

// Confetti-like animated dots
function ConfettiDot({
  delay,
  color,
  startX,
}: {
  delay: number;
  color: string;
  startX: number;
}) {
  const translateY = useRef(new Animated.Value(-20)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const translateX = useRef(new Animated.Value(startX)).current;

  useEffect(() => {
    const anim = Animated.sequence([
      Animated.delay(delay),
      Animated.parallel([
        Animated.timing(translateY, {
          toValue: 300,
          duration: 2000,
          useNativeDriver: true,
        }),
        Animated.sequence([
          Animated.timing(opacity, {
            toValue: 1,
            duration: 300,
            useNativeDriver: true,
          }),
          Animated.delay(1200),
          Animated.timing(opacity, {
            toValue: 0,
            duration: 500,
            useNativeDriver: true,
          }),
        ]),
        Animated.timing(translateX, {
          toValue: startX + (Math.random() - 0.5) * 80,
          duration: 2000,
          useNativeDriver: true,
        }),
      ]),
    ]);

    anim.start();
  }, [delay, startX, translateY, opacity, translateX]);

  return (
    <Animated.View
      style={[
        styles.confettiDot,
        {
          backgroundColor: color,
          transform: [{ translateY }, { translateX }],
          opacity,
        },
      ]}
    />
  );
}

const CONFETTI_COLORS = [
  '#60A5FA',
  '#A78BFA',
  '#34D399',
  '#FBBF24',
  '#F87171',
  '#FB923C',
];

export default function CongratulationModal({
  visible,
  score,
  onGoHome,
}: CongratulationModalProps) {
  const scaleAnim = useRef(new Animated.Value(0.5)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.spring(scaleAnim, {
          toValue: 1,
          friction: 4,
          tension: 40,
          useNativeDriver: true,
        }),
        Animated.timing(opacityAnim, {
          toValue: 1,
          duration: 400,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible, scaleAnim, opacityAnim]);

  if (!visible) return null;

  const confettiDots = Array.from({ length: 18 }, (_, i) => ({
    id: i,
    delay: Math.random() * 800,
    color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
    startX: (Math.random() - 0.5) * SCREEN_WIDTH * 0.8,
  }));

  return (
    <Animated.View style={[styles.overlay, { opacity: opacityAnim }]}>
      {/* Confetti */}
      <View style={styles.confettiContainer}>
        {confettiDots.map((dot) => (
          <ConfettiDot
            key={dot.id}
            delay={dot.delay}
            color={dot.color}
            startX={dot.startX}
          />
        ))}
      </View>

      <Animated.View
        style={[styles.card, { transform: [{ scale: scaleAnim }] }]}
      >
        <Text style={styles.trophy}>{'🏆'}</Text>
        <Text style={styles.congratsTitle}>Congratulations!</Text>
        <Text style={styles.congratsSubtitle}>
          全てのステップを完了しました！
        </Text>

        <View style={styles.finalScoreBox}>
          <Text style={styles.finalScoreLabel}>Extension Score</Text>
          <Text style={styles.finalScore}>{score}</Text>
          <Text style={styles.finalScoreUnit}>/ 100</Text>
        </View>

        <Text style={styles.motivationText}>
          練習を続けることで、{'\n'}
          英語力は確実に向上しています。{'\n'}
          Keep up the great work!
        </Text>

        <TouchableOpacity
          style={styles.homeButton}
          onPress={onGoHome}
          activeOpacity={0.8}
        >
          <Text style={styles.homeButtonText}>ホームに戻る</Text>
        </TouchableOpacity>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(15, 23, 42, 0.95)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
  },
  confettiContainer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    overflow: 'hidden',
  },
  confettiDot: {
    position: 'absolute',
    width: 10,
    height: 10,
    borderRadius: 5,
    top: 0,
  },
  card: {
    backgroundColor: '#F8FAFC',
    borderRadius: 28,
    padding: 36,
    alignItems: 'center',
    marginHorizontal: 24,
    width: '85%',
    maxWidth: 360,
    shadowColor: '#A78BFA',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.3,
    shadowRadius: 30,
    elevation: 10,
  },
  trophy: {
    fontSize: 64,
    marginBottom: 12,
  },
  congratsTitle: {
    color: '#0F172A',
    fontSize: 28,
    fontWeight: '800',
    marginBottom: 8,
  },
  congratsSubtitle: {
    color: '#64748B',
    fontSize: 15,
    marginBottom: 28,
  },
  finalScoreBox: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 20,
    alignItems: 'center',
    width: '100%',
    marginBottom: 24,
  },
  finalScoreLabel: {
    color: '#94A3B8',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 4,
  },
  finalScore: {
    color: '#34D399',
    fontSize: 52,
    fontWeight: '800',
  },
  finalScoreUnit: {
    color: '#94A3B8',
    fontSize: 14,
    marginTop: -4,
  },
  motivationText: {
    color: '#334155',
    fontSize: 14,
    lineHeight: 22,
    textAlign: 'center',
    marginBottom: 28,
  },
  homeButton: {
    backgroundColor: '#34D399',
    borderRadius: 14,
    paddingVertical: 16,
    paddingHorizontal: 48,
    width: '100%',
    alignItems: 'center',
  },
  homeButtonText: {
    color: '#064E3B',
    fontSize: 17,
    fontWeight: '800',
  },
});
