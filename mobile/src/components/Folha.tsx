// Folha que sobe do rodape — usada pelo player (voz, velocidade) e pelo
// sumario do leitor.
//
// 🚨 Por que existe: as tres eram `Modal animationType="fade"` com a caixa
//    centrada. Apareciam do nada no meio da tela, sem deslize, e as linhas
//    tinham alvo de toque abaixo dos 44pt que a Apple pede. Aqui a folha
//    SOBE com mola, escurece o fundo junto, e FECHA NO ARRASTO para baixo.
import { useEffect } from 'react';
import { Dimensions, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming,
} from 'react-native-reanimated';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Svg, { Path } from 'react-native-svg';
import { colors } from '@/lib/theme';

const { height: SCREEN_H } = Dimensions.get('window');
export const ACENTO = '#8C9CFF';
const MOLA = { damping: 22, stiffness: 180, mass: 0.9 } as const;

export function Folha({ aberta, titulo, aoFechar, children }: {
  aberta: boolean; titulo: string; aoFechar: () => void; children: React.ReactNode;
}) {
  const y = useSharedValue(SCREEN_H);
  const fundo = useSharedValue(0);

  useEffect(() => {
    if (aberta) {
      y.value = withSpring(0, MOLA);
      fundo.value = withTiming(1, { duration: 220 });
    } else {
      y.value = withTiming(SCREEN_H, { duration: 180 });
      fundo.value = withTiming(0, { duration: 180 });
    }
  }, [aberta, y, fundo]);

  // 🚨 O arrasto vive SO' no cabecalho (puxador + titulo), nao na folha
  //    inteira. Se pegasse a folha toda, no sumario ele disputaria cada
  //    rolagem com o ScrollView — e perder a rolagem de uma lista de
  //    capitulos custa mais que ganhar o arrasto em qualquer ponto.
  const pan = Gesture.Pan()
    .onUpdate((e) => { y.value = Math.max(0, e.translationY); })
    .onEnd((e) => {
      // um flick curto tambem e' «fecha»; exigir distancia faz parecer travado
      if (e.translationY > 90 || e.velocityY > 800) runOnJS(aoFechar)();
      else y.value = withSpring(0, MOLA);
    });

  const animFolha = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));
  const animFundo = useAnimatedStyle(() => ({ opacity: fundo.value }));

  return (
    <Modal visible={aberta} transparent animationType="none" onRequestClose={aoFechar} statusBarTranslucent>
      <GestureHandlerRootView style={estilos.raiz}>
        <View style={estilos.coluna}>
          <Animated.View style={[StyleSheet.absoluteFill, estilos.fundo, animFundo]}>
            <Pressable style={estilos.raiz} onPress={aoFechar} />
          </Animated.View>
          <Animated.View style={[estilos.folha, animFolha]}>
            <GestureDetector gesture={pan}>
              <View style={estilos.cabecalho}>
                <View style={estilos.puxador} />
                <Text style={estilos.titulo}>{titulo}</Text>
              </View>
            </GestureDetector>
            {children}
          </Animated.View>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

export function LinhaFolha({ texto, aviso, direita, ativo, onPress, recuo = 0, subtitulo }: {
  texto: string; aviso?: string; direita?: string; ativo: boolean;
  onPress: () => void; recuo?: number; subtitulo?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [estilos.linha, { paddingLeft: 12 + recuo }, pressed && estilos.linhaTocada]}
    >
      <View style={estilos.linhaCorpo}>
        <Text
          numberOfLines={2}
          style={[estilos.linhaTexto, subtitulo && estilos.linhaTextoSub, ativo && estilos.linhaAtiva]}
        >
          {texto}
        </Text>
        {aviso ? <Text style={estilos.linhaAviso}>{aviso}</Text> : null}
      </View>
      {direita ? <Text style={[estilos.linhaDireita, ativo && estilos.linhaDireitaAtiva]}>{direita}</Text> : null}
      {ativo && !direita ? <Check /> : null}
    </Pressable>
  );
}

function Check() {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={ACENTO}
      strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M5 13 l4 4 L19 7" />
    </Svg>
  );
}

const estilos = StyleSheet.create({
  raiz: { flex: 1 },
  coluna: { flex: 1, justifyContent: 'flex-end' },
  fundo: { backgroundColor: 'rgba(0,0,0,0.5)' },
  folha: {
    backgroundColor: 'white',
    borderTopLeftRadius: 22, borderTopRightRadius: 22,
    paddingBottom: 34, paddingHorizontal: 8,
    maxHeight: SCREEN_H * 0.8,
  },
  cabecalho: { paddingBottom: 2 },
  puxador: {
    alignSelf: 'center', width: 38, height: 5, borderRadius: 3,
    backgroundColor: 'rgba(0,0,0,0.18)', marginTop: 9, marginBottom: 4,
  },
  titulo: {
    fontSize: 13, fontWeight: '700', color: colors.slate,
    letterSpacing: 0.4, textTransform: 'uppercase',
    paddingHorizontal: 12, paddingTop: 8, paddingBottom: 6,
  },
  // 🚨 56 de altura: a Apple pede 44pt de alvo e a linha anterior nao chegava la'.
  linha: {
    minHeight: 56, flexDirection: 'row', alignItems: 'center',
    paddingRight: 12, borderRadius: 14, gap: 10,
  },
  linhaTocada: { backgroundColor: 'rgba(0,0,0,0.05)' },
  linhaCorpo: { flex: 1, minWidth: 0 },
  linhaTexto: { fontSize: 17, color: colors.ink },
  linhaTextoSub: { fontSize: 15, color: colors.slate },
  linhaAtiva: { fontWeight: '700', color: ACENTO },
  linhaAviso: { fontSize: 12, color: colors.slate, marginTop: 2 },
  linhaDireita: { fontSize: 14, color: colors.mist, fontVariant: ['tabular-nums'] },
  linhaDireitaAtiva: { color: ACENTO, fontWeight: '700' },
});
