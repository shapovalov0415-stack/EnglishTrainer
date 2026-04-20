import React from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import type { NavigatorScreenParams } from '@react-navigation/native';

import HomeScreen from '../screens/HomeScreen';
import PracticeScreen from '../screens/PracticeScreen';
import RoleplayScreen from '../screens/RoleplayScreen';
import ExtensionScreen from '../screens/ExtensionScreen';
import HistoryScreen from '../screens/HistoryScreen';
import SessionDetailScreen from '../screens/SessionDetailScreen';
import FolderDetailScreen from '../screens/FolderDetailScreen';
import PhraseListScreen from '../screens/PhraseListScreen';
import EchoTriggerScreen from '../screens/EchoTriggerScreen';

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

export type AudioSegment = {
  id: number;
  start: number;
  end: number;
  text: string;
};

export type PhraseWithTranslation = {
  phrase: string;
  translation: string;
};

export type ScriptTurn = {
  speaker: string;
  text: string;
};

/** フォルダータブ内のスタック */
export type FolderStackParamList = {
  FolderList: undefined;
  SessionDetail: { sessionId: number };
  FolderDetail: { folderId: number };
};

/**
 * @deprecated 過渡期の別名。新規コードは FolderStackParamList を使う。
 */
export type HistoryStackParamList = FolderStackParamList;

/** 画面下部の Bottom Tab */
export type RootTabParamList = {
  HomeTab: undefined;
  EchoTriggerTab: undefined;
  FolderTab: NavigatorScreenParams<FolderStackParamList>;
  PhraseListTab: undefined;
};

/** アプリ最上位のスタック */
export type RootStackParamList = {
  MainTabs: NavigatorScreenParams<RootTabParamList>;
  Practice: {
    phrases: string[];
    phrasesWithTranslation?: PhraseWithTranslation[];
    transcript?: string;
    fileUri?: string;
    segments?: AudioSegment[];
    scriptTurns?: ScriptTurn[];
    speakers?: [string, string];
    sessionFolder?: string;
    sessionId?: number;
    /** 前回残したフレーズ index 配列（再入場時の復元用） */
    initialActivePhrases?: number[];
    /** 前回の各フレーズへの話者割当（-1 は未割当）（再入場時の復元用） */
    initialSpeakerAssign?: number[];
    /** 前回 Roleplay で演じる役として選んだ話者 index（再入場時の復元用） */
    initialSelectedRole?: number;
  };
  Roleplay: {
    sessionId: number;
    scriptTurns?: ScriptTurn[];
    speakers?: [string, string];
    myRoleIndex: number;
    fileUri?: string;
    segments?: AudioSegment[];
    sessionFolder?: string;
  };
  Extension: { sessionId: number; sessionFolder?: string };
};

// ---------------------------------------------------------------------------
// Navigators
// ---------------------------------------------------------------------------

const RootStack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<RootTabParamList>();
const FolderStack = createNativeStackNavigator<FolderStackParamList>();

function FolderNavigator() {
  return (
    <FolderStack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: '#FFFFFF' },
        headerTintColor: '#0F172A',
        headerTitleStyle: { fontWeight: '600' },
        contentStyle: { backgroundColor: '#FFFFFF' },
      }}
    >
      <FolderStack.Screen
        name="FolderList"
        component={HistoryScreen}
        options={{ headerShown: false }}
      />
      <FolderStack.Screen
        name="SessionDetail"
        component={SessionDetailScreen}
        options={{ title: 'Session Detail' }}
      />
      <FolderStack.Screen
        name="FolderDetail"
        component={FolderDetailScreen}
        options={{ headerShown: false }}
      />
    </FolderStack.Navigator>
  );
}

function TabIcon({ label, focused }: { label: string; focused: boolean }) {
  return (
    <View style={styles.tabIconWrap}>
      <Text style={[styles.tabIcon, focused && styles.tabIconActive]}>
        {label}
      </Text>
    </View>
  );
}

function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: '#FFFFFF',
          borderTopColor: '#E2E8F0',
          borderTopWidth: 1,
          height: 68,
          paddingTop: 8,
          paddingBottom: 10,
        },
        tabBarActiveTintColor: '#7C3AED',
        tabBarInactiveTintColor: '#94A3B8',
        tabBarLabelStyle: { fontSize: 11, fontWeight: '700' },
      }}
    >
      <Tab.Screen
        name="HomeTab"
        component={HomeScreen}
        options={{
          title: 'Home',
          tabBarIcon: ({ focused }) => (
            <TabIcon label={'\u{1F3E0}'} focused={focused} />
          ),
        }}
      />
      <Tab.Screen
        name="EchoTriggerTab"
        component={EchoTriggerScreen}
        options={{
          title: 'Echo',
          tabBarIcon: ({ focused }) => (
            <TabIcon label={'\u{1F3A4}'} focused={focused} />
          ),
        }}
      />
      <Tab.Screen
        name="FolderTab"
        component={FolderNavigator}
        options={{
          title: 'フォルダー',
          tabBarIcon: ({ focused }) => (
            <TabIcon label={'\u{1F4C1}'} focused={focused} />
          ),
        }}
      />
      <Tab.Screen
        name="PhraseListTab"
        component={PhraseListScreen}
        options={{
          title: 'フレーズ',
          tabBarIcon: ({ focused }) => (
            <TabIcon label={'\u{2B50}'} focused={focused} />
          ),
        }}
      />
    </Tab.Navigator>
  );
}

export default function RootNavigator() {
  return (
    <RootStack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: '#FFFFFF' },
        headerTintColor: '#0F172A',
        headerTitleStyle: { fontWeight: '600' },
        contentStyle: { backgroundColor: '#FFFFFF' },
      }}
    >
      <RootStack.Screen
        name="MainTabs"
        component={MainTabs}
        options={{ headerShown: false }}
      />
      <RootStack.Screen
        name="Practice"
        component={PracticeScreen}
        options={{ title: 'Step 1: Practice' }}
      />
      <RootStack.Screen
        name="Roleplay"
        component={RoleplayScreen}
        options={{ title: 'Step 2: Roleplay' }}
      />
      <RootStack.Screen
        name="Extension"
        component={ExtensionScreen}
        options={{ title: 'Step 3: Extension' }}
      />
    </RootStack.Navigator>
  );
}

const styles = StyleSheet.create({
  tabIconWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabIcon: {
    fontSize: 22,
    opacity: 0.55,
  },
  tabIconActive: {
    opacity: 1,
  },
});
