// Area tocavel com resposta fisica e alvo garantido.
//
// 🚨 A Apple e' explicita em dois pontos que este arquivo resolve de uma vez:
//    «Always include a press state for a custom button» e, na acessibilidade,
//    «Offer sufficiently sized controls» com «Consider spacing between controls
//    as important as size». `opacity` no press nao lê como resposta fisica — o
//    que lê e' a escala, e ela roda no thread da UI, entao nao engasga.
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { TOQUE, FOLGA } from '@/lib/theme';
import { useMovimentoReduzido, anima } from '@/lib/movimento';

const MOLA = { damping: 18, stiffness: 220, mass: 0.6 } as const;

export function Toque({
  children, onPress, style, disabled, escala = 0.96, vibrar = false,
  rotulo, dica, alvoMinimo = true,
}: {
  children: React.ReactNode;
  onPress: () => void;
  style?: any;
  disabled?: boolean;
  escala?: number;
  vibrar?: boolean;
  rotulo: string;              // 🚨 obrigatorio: «accessibilityLabel on every interactive element»
  dica?: string;
  alvoMinimo?: boolean;
}) {
  const reduzido = useMovimentoReduzido();
  // 🚨 Com movimento reduzido a escala nao some — encolhe menos. Zerar o
  //    retorno do toque seria tirar a resposta, nao o incomodo.
  const alvo = reduzido ? 1 - (1 - escala) * 0.35 : escala;
  const k = useSharedValue(1);
  const anim = useAnimatedStyle(() => ({ transform: [{ scale: k.value }] }));

  return (
    <Animated.View style={[anim, style]}>
      <Pressable
        onPressIn={() => { k.value = anima(alvo, MOLA, reduzido); }}
        onPressOut={() => { k.value = anima(1, MOLA, reduzido); }}
        onPress={() => {
          if (vibrar) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
          onPress();
        }}
        disabled={disabled}
        hitSlop={FOLGA}
        accessibilityRole="button"
        accessibilityLabel={rotulo}
        accessibilityHint={dica}
        accessibilityState={{ disabled: !!disabled }}
        style={[estilos.interior, alvoMinimo && estilos.alvo]}
      >
        {children}
      </Pressable>
    </Animated.View>
  );
}

/** Barra fina de progresso — usada nos cartoes da biblioteca. */
export function Progresso({ fracao, cor, fundo, altura = 3 }: {
  fracao: number; cor: string; fundo: string; altura?: number;
}) {
  const f = Math.min(1, Math.max(0, fracao));
  return (
    <View style={[estilos.trilho, { height: altura, borderRadius: altura / 2, backgroundColor: fundo }]}>
      <View style={{ width: `${f * 100}%`, height: '100%', borderRadius: altura / 2, backgroundColor: cor }} />
    </View>
  );
}

const estilos = StyleSheet.create({
  interior: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' },
  alvo: { minWidth: TOQUE, minHeight: TOQUE },
  trilho: { width: '100%', overflow: 'hidden' },
});
