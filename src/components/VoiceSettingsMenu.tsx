import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Modal,
  StyleSheet,
  Pressable,
} from 'react-native';
import {
  RATE_OPTIONS,
  type VoiceGender,
} from '../utils/voiceSettings';

interface Props {
  enabled: boolean;
  onToggleEnabled: (v: boolean) => void;
  rate: number;
  onChangeRate: (v: number) => void;
  gender: VoiceGender;
  onChangeGender: (v: VoiceGender) => void;
  /** 端末の右端からのオフセット（デフォルト 16）。右上 absolute 配置される */
  right?: number;
  /** セーフエリア考慮の上オフセット */
  top?: number;
}

/**
 * ⚙️ ボタンをタップすると、読み上げ設定メニューがモーダルで開く。
 * - 音声 ON/OFF
 * - 再生速度 0.8〜1.2
 * - Male / Female
 */
export default function VoiceSettingsMenu({
  enabled,
  onToggleEnabled,
  rate,
  onChangeRate,
  gender,
  onChangeGender,
  right = 16,
  top = 16,
}: Props) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <TouchableOpacity
        style={[styles.gearBtn, { right, top }]}
        onPress={() => setOpen(true)}
        activeOpacity={0.75}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        accessibilityLabel="音声設定"
      >
        <Text style={styles.gearIcon}>{'\u2699\uFE0F'}</Text>
      </TouchableOpacity>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        {/* 背景タップで閉じる層。ネストした Pressable の stopPropagation は
            RN の gesture system ではうまく動かないことがあるので、
            sheet 自体はただの View に変えて背景側 Pressable をそのまま単層で使う。 */}
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)} />
        <View
          style={[styles.sheet, { top: top + 44, right }]}
          pointerEvents="box-none"
        >
          <View style={styles.sheetInner}>
            {/* 音声 ON/OFF */}
            <View style={styles.row}>
              <Text style={styles.rowLabel}>音声</Text>
              <View style={styles.segWrap}>
                <SegButton
                  active={enabled}
                  onPress={() => onToggleEnabled(true)}
                  label="ON"
                />
                <SegButton
                  active={!enabled}
                  onPress={() => onToggleEnabled(false)}
                  label="OFF"
                />
              </View>
            </View>

            <View style={styles.divider} />

            {/* 速度 */}
            <View style={styles.row}>
              <Text style={styles.rowLabel}>速度</Text>
              <View style={styles.rateWrap}>
                {RATE_OPTIONS.map((r) => (
                  <TouchableOpacity
                    key={r}
                    style={[
                      styles.rateBtn,
                      r === rate && styles.rateBtnActive,
                      !enabled && styles.btnDisabled,
                    ]}
                    onPress={() => onChangeRate(r)}
                    disabled={!enabled}
                    activeOpacity={0.7}
                  >
                    <Text
                      style={[
                        styles.rateBtnText,
                        r === rate && styles.rateBtnTextActive,
                      ]}
                    >
                      {r.toFixed(1)}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            <View style={styles.divider} />

            {/* 性別 */}
            <View style={styles.row}>
              <Text style={styles.rowLabel}>声</Text>
              <View style={styles.segWrap}>
                <SegButton
                  active={gender === 'female'}
                  onPress={() => {
                    console.warn('[VoiceSettingsMenu] Female tapped, prev=', gender);
                    onChangeGender('female');
                  }}
                  label="Female"
                />
                <SegButton
                  active={gender === 'male'}
                  onPress={() => {
                    console.warn('[VoiceSettingsMenu] Male tapped, prev=', gender);
                    onChangeGender('male');
                  }}
                  label="Male"
                />
              </View>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

function SegButton({
  active,
  onPress,
  label,
  disabled,
}: {
  active: boolean;
  onPress: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <TouchableOpacity
      style={[
        styles.segBtn,
        active && styles.segBtnActive,
        disabled && styles.btnDisabled,
      ]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.7}
    >
      <Text style={[styles.segBtnText, active && styles.segBtnTextActive]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  gearBtn: {
    position: 'absolute',
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 50,
  },
  gearIcon: {
    fontSize: 16,
  },
  backdrop: {
    position: 'absolute',
    top: 0, bottom: 0, left: 0, right: 0,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  sheet: {
    position: 'absolute',
    width: 260,
  },
  sheetInner: {
    backgroundColor: '#F8FAFC',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    padding: 14,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  },
  row: {
    flexDirection: 'column',
    gap: 8,
  },
  rowLabel: {
    color: '#64748B',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  divider: {
    height: 1,
    backgroundColor: '#E2E8F0',
    marginVertical: 10,
  },
  segWrap: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    padding: 3,
    gap: 3,
  },
  segBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
  },
  segBtnActive: {
    backgroundColor: '#8B5CF6',
  },
  segBtnText: {
    color: '#64748B',
    fontSize: 13,
    fontWeight: '700',
  },
  segBtnTextActive: {
    color: '#FFFFFF',
  },
  rateWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  rateBtn: {
    minWidth: 42,
    paddingHorizontal: 8,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    alignItems: 'center',
  },
  rateBtnActive: {
    backgroundColor: '#8B5CF6',
    borderColor: '#8B5CF6',
  },
  rateBtnText: {
    color: '#64748B',
    fontSize: 12,
    fontWeight: '700',
  },
  rateBtnTextActive: {
    color: '#FFFFFF',
  },
  btnDisabled: {
    opacity: 0.4,
  },
});
