import React from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import RootNavigator from './src/navigation/RootNavigator';

type BoundaryState = { error: Error | null };

class ErrorBoundary extends React.Component<
  React.PropsWithChildren,
  BoundaryState
> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('App ErrorBoundary:', error, info.componentStack);
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <View style={styles.errWrap}>
          <Text style={styles.errTitle}>アプリでエラーが発生しました</Text>
          <ScrollView style={styles.errScroll}>
            <Text style={styles.errMsg}>{this.state.error.message}</Text>
            <Text style={styles.errStack}>{this.state.error.stack}</Text>
          </ScrollView>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  errWrap: {
    flex: 1,
    backgroundColor: '#1e293b',
    padding: 16,
    paddingTop: 48,
  },
  errTitle: {
    color: '#f87171',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 12,
  },
  errScroll: { flex: 1 },
  errMsg: { color: '#f8fafc', marginBottom: 12, fontSize: 15 },
  errStack: { color: '#94a3b8', fontSize: 11, fontFamily: 'monospace' },
});

export default function App() {
  return (
    <ErrorBoundary>
      <SafeAreaProvider>
        <NavigationContainer>
          <RootNavigator />
        </NavigationContainer>
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}
