// Area tocavel com resposta fisica e alvo garantido.
//
// 🚨 A VERSAO ANTERIOR DESTE ARQUIVO QUEBROU O APP INTEIRO. Ela era assim:
//
//      <Animated.View style={[anim, style]}>
//        <Pressable style={{ width:'100%', height:'100%',
//                            alignItems:'center', justifyContent:'center' }}>
//          {children}
//
//    Ou seja: TODO filho de `Toque` era forcado a 100% de altura e centrado.
//    Onde o pai tem tamanho fixo (os botoes do player, 44x44) isso funciona —
//    e foi por isso que o player continuou de pe' enquanto o resto ruia. Mas
//    os cartoes da biblioteca sao `flex: 1`, sem altura definida: ali
//    `height: '100%'` nao resolve para nada, e o `center` desmonta qualquer
//    layout alinhado a' esquerda. Capa, titulo e progresso viraram pilha
//    centrada de altura imprevisivel, e cartao sem altura nao se toca.
//
//    A licao: **componente tocavel nao decide layout do filho.** Quem decide
//    e' quem chama. Agora e' UM elemento so' — `Animated.Pressable` — e o
//    `style` recebido e' o unico que manda.
import { Pressable, StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { TOQUE, FOLGA } from '@/lib/theme';
import { useMovimentoReduzido, anima } from '@/lib/movimento';

const MOLA = { damping: 18, stiffness: 220, mass: 0.6 } as const;
const PressavelAnimado = Animated.createAnimatedComponent(Pressable);

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
    <PressavelAnimado
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
      // 🚨 `alvoMinimo` so' garante o minimo de 44pt da Apple. NAO centra,
      //    NAO estica: quem manda no desenho e' o `style` de quem chama.
      style={[alvoMinimo && estilos.alvo, style, anim]}
    >
      {children}
    </PressavelAnimado>
  );
}

/** Barra fina de progresso — usada nos cartoes da biblioteca. */
export function Progresso({ fracao, cor, fundo, altura = 3 }: {
  fracao: number; cor: string; fundo: string; altura?: number;
}) {
  const f = Math.min(1, Math.max(0, fracao));
  return (
    <Animated.View style={[estilos.trilho, { height: altura, borderRadius: altura / 2, backgroundColor: fundo }]}>
      <Animated.View style={{ width: `${f * 100}%`, height: '100%', borderRadius: altura / 2, backgroundColor: cor }} />
    </Animated.View>
  );
}

const estilos = StyleSheet.create({
  alvo: { minWidth: TOQUE, minHeight: TOQUE },
  trilho: { width: '100%', overflow: 'hidden' },
});
