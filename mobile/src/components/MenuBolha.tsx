// Menu flutuante em Liquid Glass — a gota.
//
// 🚨 Nao inventei o movimento. Ele foi MEDIDO no prototipo do Central Fleet
//    (`.docs/central-fleet/central-fleet-prototipo.html`, 23/08) e esta' aqui
//    quadro a quadro. O que separa «escalou» de «e' gelatina» e' a escala
//    horizontal e a vertical andarem FORA DE FASE — tres batidas: estica ao
//    chegar, recua ABAIXO do tamanho, assenta.
//
//        0%   translateY(-27) scale(.152, .184)  opacidade 0
//        30%  translateY(0)   scale(1.045, 1.10) opacidade 1
//        55%  translateY(0)   scale(.984, .960)
//        76%  translateY(0)   scale(1.006, 1.016)
//        100% translateY(0)   scale(1)
//        duracao .56s · cubic-bezier(.34, 1.14, .32, 1)
//
// 🚨 O menu NASCE DO BOTAO: comeca com a pegada dele (0,152 × 0,184) e sobe os
//    27 px que separam os dois topos. No prototipo tentou-se antes um PESCOCO,
//    uma gota esticando do botao ate' o menu — nao coube: o menu ENCOSTA no
//    botao, nao sobra vao, e a gota virava pastilha branca em cima dele. Sem
//    espaco entre as pecas, a fluidez tem de estar na peca que existe.
//
// 🚨 O conteudo entra 110 ms DEPOIS do corpo esticar. Texto dentro de caixa
//    sendo esmagada estica junto, e rotulo deformado nao lê como gel — lê como
//    defeito de desenho.
import { useEffect, useState } from 'react';
import { Dimensions, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing, useAnimatedStyle, useSharedValue, withDelay, withSequence, withTiming,
} from 'react-native-reanimated';
import Svg, { Path, Circle } from 'react-native-svg';
import { tipo, espaco, raio, useTema, type Paleta } from '@/lib/theme';
import { useMovimentoReduzido } from '@/lib/movimento';
import { Vidro } from './Vidro';

const { width: LARGURA } = Dimensions.get('window');

// A curva e as fatias da animacao medida, convertidas de porcentagem para ms.
const CURVA = Easing.bezier(0.34, 1.14, 0.32, 1);
const T = 560;
const F = [0.30, 0.25, 0.21, 0.24].map(x => Math.round(x * T)); // 168 · 140 · 118 · 134

const BOTAO = 56;
const MENU_L = 232;

// 🚨 A pegada de onde a gota nasce: o botao dentro do menu.
const NASCE_X = BOTAO / MENU_L;      // 0,241
const NASCE_Y = 0.184;               // medido no prototipo
const SOBE = 27;

export type ItemMenu = {
  chave: string;
  rotulo: string;
  dica?: string;
  icone: (cor: string) => React.ReactNode;
  onPress: () => void;
  destaque?: boolean;
  desabilitado?: boolean;
};

export function MenuBolha({ itens, margemInferior = 0 }: {
  itens: ItemMenu[];
  margemInferior?: number;
}) {
  const c = useTema();
  const reduzido = useMovimentoReduzido();
  const [aberto, setAberto] = useState(false);
  const estilos = criarEstilos(c);

  const ex = useSharedValue(NASCE_X);
  const ey = useSharedValue(NASCE_Y);
  const y = useSharedValue(-SOBE);
  const op = useSharedValue(0);
  const conteudo = useSharedValue(0);
  const giro = useSharedValue(0);

  useEffect(() => {
    if (aberto) {
      if (reduzido) {
        // 🚨 Quem liga «Reduzir movimento» nao perde o menu — perde o salto.
        //    Apagar tudo ja' fez uma tela parecer quebrada na vespera de uma
        //    apresentacao; aqui a gota so' aparece, sem esmagar.
        ex.value = withTiming(1, { duration: 130 });
        ey.value = withTiming(1, { duration: 130 });
        y.value = withTiming(0, { duration: 130 });
        op.value = withTiming(1, { duration: 130 });
        conteudo.value = withTiming(1, { duration: 130 });
      } else {
        op.value = withTiming(1, { duration: F[0], easing: CURVA });
        y.value = withTiming(0, { duration: F[0], easing: CURVA });
        // horizontal e vertical FORA DE FASE — e' isso que faz parecer liquido
        ex.value = withSequence(
          withTiming(1.045, { duration: F[0], easing: CURVA }),
          withTiming(0.984, { duration: F[1], easing: CURVA }),
          withTiming(1.006, { duration: F[2], easing: CURVA }),
          withTiming(1, { duration: F[3], easing: CURVA }),
        );
        ey.value = withSequence(
          withTiming(1.100, { duration: F[0], easing: CURVA }),
          withTiming(0.960, { duration: F[1], easing: CURVA }),
          withTiming(1.016, { duration: F[2], easing: CURVA }),
          withTiming(1, { duration: F[3], easing: CURVA }),
        );
        conteudo.value = withDelay(110, withTiming(1, { duration: 200 }));
      }
      giro.value = withTiming(1, { duration: reduzido ? 120 : 260, easing: CURVA });
    } else {
      const d = reduzido ? 110 : 170;
      op.value = withTiming(0, { duration: d });
      conteudo.value = withTiming(0, { duration: 90 });
      ex.value = withTiming(NASCE_X, { duration: d });
      ey.value = withTiming(NASCE_Y, { duration: d });
      y.value = withTiming(-SOBE, { duration: d });
      giro.value = withTiming(0, { duration: d });
    }
  }, [aberto, reduzido, ex, ey, y, op, conteudo, giro]);

  const animGota = useAnimatedStyle(() => ({
    opacity: op.value,
    transform: [{ translateY: y.value }, { scaleX: ex.value }, { scaleY: ey.value }],
  }));
  const animConteudo = useAnimatedStyle(() => ({ opacity: conteudo.value }));
  const animBotao = useAnimatedStyle(() => ({
    transform: [{ rotate: `${giro.value * 135}deg` }],
  }));

  return (
    <>
      {/* ── O botao ─────────────────────────────────────────────────────── */}
      <View style={[estilos.ancora, { bottom: margemInferior }]} pointerEvents="box-none">
        <Pressable
          onPress={() => setAberto(true)}
          accessibilityRole="button"
          accessibilityLabel="Abrir menu"
          accessibilityState={{ expanded: aberto }}
          hitSlop={10}
        >
          <Vidro style={estilos.botao} variante="regular" escuro>
            <Animated.View style={animBotao}>
              <Svg width={22} height={22} viewBox="0 0 24 24" fill="none"
                stroke="#FFFFFF" strokeWidth={2.4} strokeLinecap="round">
                <Path d="M12 5v14M5 12h14" />
              </Svg>
            </Animated.View>
          </Vidro>
        </Pressable>
      </View>

      {/* ── A gota ──────────────────────────────────────────────────────── */}
      <Modal visible={aberto} transparent animationType="none"
        onRequestClose={() => setAberto(false)} statusBarTranslucent>
        <Pressable style={estilos.fundo} onPress={() => setAberto(false)}
          accessibilityRole="button" accessibilityLabel="Fechar menu" />

        <View style={[estilos.ancora, { bottom: margemInferior }]} pointerEvents="box-none">
          {/* 🚨 A origem da transformacao fica no canto de baixo a' direita: e'
              o canto do botao, e e' de la' que a gota tem de brotar. */}
          <Animated.View style={[estilos.gotaCaixa, animGota]}>
            <Vidro style={estilos.gota} variante="regular" escuro>
              <Animated.View style={animConteudo}>
                {itens.map((it, i) => (
                  <Pressable
                    key={it.chave}
                    onPress={() => { setAberto(false); setTimeout(it.onPress, 140); }}
                    disabled={it.desabilitado}
                    accessibilityRole="menuitem"
                    accessibilityLabel={it.rotulo}
                    accessibilityHint={it.dica}
                    accessibilityState={{ disabled: !!it.desabilitado }}
                    style={({ pressed }) => [
                      estilos.item,
                      i > 0 && estilos.itemSeparado,
                      pressed && estilos.itemTocado,
                      it.desabilitado && estilos.itemMorto,
                    ]}
                  >
                    {it.icone(it.desabilitado ? 'rgba(255,255,255,0.32)'
                      : it.destaque ? '#7C8CFF' : 'rgba(255,255,255,0.96)')}
                    <View style={estilos.itemTexto}>
                      <Text style={[estilos.itemRotulo, it.destaque && estilos.itemRotuloDestaque,
                        it.desabilitado && estilos.itemMortoTexto]}>
                        {it.rotulo}
                      </Text>
                      {it.dica ? <Text numberOfLines={1} style={estilos.itemDica}>{it.dica}</Text> : null}
                    </View>
                  </Pressable>
                ))}
              </Animated.View>
            </Vidro>
          </Animated.View>

          {/* O botao continua visivel sob a gota, virando ✕ */}
          <Pressable
            onPress={() => setAberto(false)}
            accessibilityRole="button"
            accessibilityLabel="Fechar menu"
            hitSlop={10}
          >
            <Vidro style={estilos.botao} variante="regular" escuro>
              <Animated.View style={animBotao}>
                <Svg width={22} height={22} viewBox="0 0 24 24" fill="none"
                  stroke="#FFFFFF" strokeWidth={2.4} strokeLinecap="round">
                  <Path d="M12 5v14M5 12h14" />
                </Svg>
              </Animated.View>
            </Vidro>
          </Pressable>
        </View>
      </Modal>
    </>
  );
}

// ── Icones dos quatro itens ───────────────────────────────────────────────
export const IconeInicio = (cor: string) => (
  <Svg width={21} height={21} viewBox="0 0 24 24" fill="none" stroke={cor}
    strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
    <Path d="M3 10.5 12 3l9 7.5" /><Path d="M5.5 9.5V20h13V9.5" />
  </Svg>
);
export const IconeBuscar = (cor: string) => (
  <Svg width={21} height={21} viewBox="0 0 24 24" fill="none" stroke={cor}
    strokeWidth={1.9} strokeLinecap="round">
    <Circle cx={11} cy={11} r={7} /><Path d="M16.5 16.5 21 21" />
  </Svg>
);
export const IconeContinuar = (cor: string) => (
  <Svg width={21} height={21} viewBox="0 0 24 24" fill={cor}>
    <Path d="M8 5 L19 12 L8 19 Z" />
  </Svg>
);
export const IconeAjustes = (cor: string) => (
  <Svg width={21} height={21} viewBox="0 0 24 24" fill="none" stroke={cor}
    strokeWidth={1.9} strokeLinecap="round">
    <Path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
    <Circle cx={16} cy={7} r={2.2} /><Circle cx={10} cy={17} r={2.2} />
  </Svg>
);

const criarEstilos = (c: Paleta) => StyleSheet.create({
  ancora: { position: 'absolute', right: espaco.padrao, alignItems: 'flex-end' },

  botao: {
    width: BOTAO, height: BOTAO, borderRadius: BOTAO / 2,
    alignItems: 'center', justifyContent: 'center',
    overflow: 'hidden',
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.18)',
    shadowColor: '#000', shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3, shadowRadius: 16, elevation: 10,
  },

  gotaCaixa: {
    width: MENU_L,
    marginBottom: espaco.medio,
    // 🚨 A gota brota do CANTO do botao, nao do meio do menu.
    transformOrigin: 'right bottom',
  },
  gota: {
    borderRadius: raio.cartao,
    overflow: 'hidden',
    paddingVertical: espaco.pequeno,
    borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.16)',
    shadowColor: '#000', shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.34, shadowRadius: 26, elevation: 14,
  },

  fundo: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.22)' },

  // 🚨 52 de altura: a Apple pede 44 de alvo e a linha precisa de folga.
  item: {
    minHeight: 52, flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: espaco.padrao, gap: espaco.medio,
  },
  itemSeparado: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,255,255,0.12)' },
  itemTocado: { backgroundColor: 'rgba(255,255,255,0.10)' },
  itemMorto: { opacity: 0.55 },
  itemTexto: { flex: 1, minWidth: 0 },
  itemRotulo: { ...tipo.chamada, fontWeight: '600', color: 'rgba(255,255,255,0.96)' },
  itemRotuloDestaque: { color: '#7C8CFF' },
  itemMortoTexto: { color: 'rgba(255,255,255,0.4)' },
  itemDica: { ...tipo.legenda2, color: 'rgba(255,255,255,0.5)', marginTop: 1 },
});
