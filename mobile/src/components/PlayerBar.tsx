// Player do Echo — pilula embaixo + «Tocando agora» em tela cheia.
//
// A referencia continua a que o projeto ja' declarava em `theme.ts`: o mini
// player do Apple Music. O que faltava nao era desenho, era MOVIMENTO — o
// `react-native-reanimated` estava instalado e usado em zero arquivos.
//
// O que esta pilula faz que a anterior nao fazia:
//   · a barra de progresso ARRASTA (o livro inteiro, nao so' o trecho) e
//     engorda enquanto o dedo esta' nela, como no Apple Music;
//   · puxar a pilula para cima abre o player grande; puxar para baixo fecha;
//   · as folhas de voz e velocidade SOBEM do rodape' e fecham no arrasto,
//     em vez de piscar no meio da tela;
//   · todo botao responde ao toque com mola, nao com opacidade.
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, Dimensions, Modal, Pressable, StyleSheet, Text, View,
} from 'react-native';
import Animated, {
  Extrapolation, interpolate, runOnJS, useAnimatedStyle, useSharedValue,
  withSpring, withTiming,
} from 'react-native-reanimated';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { BlurView } from 'expo-blur';
import { Image } from 'expo-image';
import Svg, { Path } from 'react-native-svg';
import { colors } from '@/lib/theme';
import { Folha, LinhaFolha, ACENTO } from './Folha';
import { coverUrl } from '@/lib/api';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

const SUPERFICIE = 'rgba(20, 20, 22, 0.72)';
const SUPERFICIE_CHEIA = '#141416';

// Mola unica para tudo que e' resposta a dedo: firme, sem balancar.
const MOLA = { damping: 18, stiffness: 220, mass: 0.6 } as const;
// Mola do painel grande: percorre muito espaco, precisa de mais peso.
const MOLA_PAINEL = { damping: 22, stiffness: 180, mass: 0.9 } as const;

export const SPEED_OPTIONS = [0.75, 1, 1.25, 1.5, 2];

export type Voz = { name: string; label: string; aviso?: string };

export function fmt(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}:${String(m % 60).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  }
  return `${m}:${String(r).padStart(2, '0')}`;
}

// ── Botao com mola ────────────────────────────────────────────────────────
// 🚨 `Pressable` com `opacity` no press nao lê como resposta fisica; o que lê
//    e' a escala. Fica no thread da UI, entao nao engasga com o audio.
function Botao({ children, onPress, style, disabled, escala = 0.88, hitSlop = 8 }: {
  children: React.ReactNode; onPress: () => void; style?: any;
  disabled?: boolean; escala?: number; hitSlop?: number;
}) {
  const k = useSharedValue(1);
  const anim = useAnimatedStyle(() => ({ transform: [{ scale: k.value }] }));
  return (
    <Animated.View style={[style, anim]}>
      <Pressable
        onPressIn={() => { k.value = withSpring(escala, MOLA); }}
        onPressOut={() => { k.value = withSpring(1, MOLA); }}
        onPress={onPress}
        disabled={disabled}
        hitSlop={hitSlop}
        style={estilos.botaoInterior}
      >
        {children}
      </Pressable>
    </Animated.View>
  );
}

// ── Barra de progresso arrastavel ─────────────────────────────────────────
// 🚨 Durante o arrasto a barra deixa de seguir o audio: senao o dedo e o
//    relogio disputam a mesma posicao e o polegar «escorrega» sozinho.
function Barra({ pct, largura, alturaRepouso, alturaArrasto, onSeek, mostrarTempos, elapsed, total }: {
  pct: number; largura: number; alturaRepouso: number; alturaArrasto: number;
  onSeek: (fracao: number) => void;
  mostrarTempos?: boolean; elapsed?: number; total?: number;
}) {
  const arrastando = useSharedValue(0);
  const fracaoDedo = useSharedValue(0);
  // 🚨 `runOnJS` a cada quadro do arrasto = ~60 `setState`/s e a barra
  //    engasga. So' avisa o JS quando o dedo andou o bastante para mudar
  //    o relogio na tela.
  const ultimoAviso = useSharedValue(-1);
  const [previa, setPrevia] = useState<number | null>(null);

  const fim = useCallback((f: number) => {
    onSeek(f);
    setPrevia(null);
  }, [onSeek]);

  const pan = Gesture.Pan()
    .minDistance(0)
    .onBegin((e) => {
      arrastando.value = withTiming(1, { duration: 120 });
      fracaoDedo.value = Math.min(1, Math.max(0, e.x / largura));
      ultimoAviso.value = fracaoDedo.value;
      runOnJS(setPrevia)(fracaoDedo.value);
    })
    .onUpdate((e) => {
      fracaoDedo.value = Math.min(1, Math.max(0, e.x / largura));
      if (Math.abs(fracaoDedo.value - ultimoAviso.value) > 0.004) {
        ultimoAviso.value = fracaoDedo.value;
        runOnJS(setPrevia)(fracaoDedo.value);
      }
    })
    .onEnd(() => {
      arrastando.value = withTiming(0, { duration: 160 });
      runOnJS(fim)(fracaoDedo.value);
    })
    .onFinalize(() => { arrastando.value = withTiming(0, { duration: 160 }); });

  const trilho = useAnimatedStyle(() => ({
    height: interpolate(arrastando.value, [0, 1], [alturaRepouso, alturaArrasto]),
    borderRadius: interpolate(arrastando.value, [0, 1], [0, alturaArrasto / 2]),
  }));

  const preenchido = useAnimatedStyle(() => {
    const f = arrastando.value > 0 ? fracaoDedo.value : pct / 100;
    return { width: `${Math.min(100, Math.max(0, f * 100))}%` };
  });

  const polegar = useAnimatedStyle(() => ({
    opacity: arrastando.value,
    transform: [
      { translateX: fracaoDedo.value * largura - 7 },
      { scale: interpolate(arrastando.value, [0, 1], [0.4, 1], Extrapolation.CLAMP) },
    ],
  }));

  const tempoMostrado = previa != null && total ? previa * total : elapsed;

  return (
    <View>
      <GestureDetector gesture={pan}>
        {/* a area de toque e' bem maior que o traco — 3px nao se acerta com o dedo */}
        <View style={[estilos.barraToque, { width: largura }]} hitSlop={10}>
          <Animated.View style={[estilos.barraTrilho, trilho]}>
            <Animated.View style={[estilos.barraCheia, preenchido]} />
          </Animated.View>
          <Animated.View style={[estilos.barraPolegar, polegar]} />
        </View>
      </GestureDetector>

      {mostrarTempos ? (
        <View style={[estilos.temposLinha, { width: largura }]}>
          <Text style={[estilos.tempo, previa != null && estilos.tempoAtivo]}>
            {fmt(tempoMostrado ?? 0)}
          </Text>
          <Text style={estilos.tempo}>−{fmt(Math.max(0, (total ?? 0) - (tempoMostrado ?? 0)))}</Text>
        </View>
      ) : null}
    </View>
  );
}

// ── O player ──────────────────────────────────────────────────────────────
export function Player(p: {
  coverId: string; titulo: string; chapter: string; page: number; totalPages: number;
  elapsed: number; total: number; pct: number;
  isPlaying: boolean; isLoading: boolean;
  onPlayPause: () => void; onSkip10: (dir: 1 | -1) => void;
  onChapterPress: () => void; onSeekFraction: (f: number) => void;
  speed: number; onSpeedChange: (s: number) => void;
  voice: string; voices: Voz[]; onVoiceChange: (v: string) => void;
}) {
  const [semCapa, setSemCapa] = useState(false);
  const [folhaVoz, setFolhaVoz] = useState(false);
  const [folhaVel, setFolhaVel] = useState(false);
  const [grandeAberto, setGrandeAberto] = useState(false);

  const rotuloVoz = p.voices.find(v => v.name === p.voice)?.label
    || p.voice.replace('pt-BR-', '').replace('Neural', '');
  const rotuloVel = `${p.speed}×`;

  // Puxar a pilula para CIMA abre o player grande.
  const puxar = Gesture.Pan()
    .activeOffsetY([-14, 999])
    .onEnd((e) => {
      if (e.translationY < -40 || e.velocityY < -600) runOnJS(setGrandeAberto)(true);
    });

  const capa = semCapa ? (
    <View style={[estilos.capa, estilos.capaVazia]}><Text style={estilos.capaLetra}>e</Text></View>
  ) : (
    <Image
      source={coverUrl(p.coverId)}
      style={estilos.capa}
      contentFit="cover"
      transition={200}
      onError={() => setSemCapa(true)}
    />
  );

  return (
    <>
      <GestureDetector gesture={puxar}>
        <BlurView intensity={45} tint="dark" style={estilos.pilula}>
          <Barra
            pct={p.pct}
            largura={SCREEN_W - 24}
            alturaRepouso={3}
            alturaArrasto={7}
            onSeek={p.onSeekFraction}
          />

          <View style={estilos.linhaPrincipal}>
            <Pressable onPress={() => setGrandeAberto(true)} hitSlop={4}>{capa}</Pressable>

            <Pressable style={estilos.colunaInfo} onPress={() => setGrandeAberto(true)} hitSlop={4}>
              <Text numberOfLines={1} style={estilos.capitulo}>{p.chapter}</Text>
              <Text numberOfLines={1} style={estilos.meta}>
                {fmt(p.elapsed)} · pág {p.page}/{p.totalPages} · {fmt(p.total)}
              </Text>
            </Pressable>

            <Botao onPress={() => p.onSkip10(-1)} style={estilos.pular}>
              <IconePular dir="back" /><Text style={estilos.pularNum}>10</Text>
            </Botao>

            <Botao onPress={p.onPlayPause} disabled={p.isLoading} style={estilos.tocar} escala={0.9}>
              {p.isLoading ? <ActivityIndicator color={colors.ink} size="small" />
                : p.isPlaying ? <IconePausa /> : <IconeTocar />}
            </Botao>

            <Botao onPress={() => p.onSkip10(1)} style={estilos.pular}>
              <IconePular dir="fwd" /><Text style={estilos.pularNum}>10</Text>
            </Botao>
          </View>
        </BlurView>
      </GestureDetector>

      <PlayerGrande
        {...p}
        aberto={grandeAberto}
        aoFechar={() => setGrandeAberto(false)}
        capa={capa}
        rotuloVoz={rotuloVoz}
        rotuloVel={rotuloVel}
        abrirVoz={() => setFolhaVoz(true)}
        abrirVel={() => setFolhaVel(true)}
      />

      <Folha aberta={folhaVoz} titulo="Voz" aoFechar={() => setFolhaVoz(false)}>
        {p.voices.map(v => (
          <LinhaFolha
            key={v.name}
            texto={v.label}
            aviso={v.aviso}
            ativo={p.voice === v.name}
            onPress={() => { p.onVoiceChange(v.name); setFolhaVoz(false); }}
          />
        ))}
      </Folha>

      <Folha aberta={folhaVel} titulo="Velocidade" aoFechar={() => setFolhaVel(false)}>
        {SPEED_OPTIONS.map(s => (
          <LinhaFolha
            key={s}
            texto={`${s}×`}
            ativo={p.speed === s}
            onPress={() => { p.onSpeedChange(s); setFolhaVel(false); }}
          />
        ))}
      </Folha>
    </>
  );
}

// ── «Tocando agora» ───────────────────────────────────────────────────────
// 🚨 Este painel existe por causa do «está muito pequeno»: na pilula o alvo
//    de toque do play tem 44pt e divide a linha com mais seis coisas. Aqui o
//    play tem 76 e a barra ocupa a largura da tela.
function PlayerGrande(p: any) {
  const y = useSharedValue(SCREEN_H);

  useEffect(() => {
    y.value = p.aberto ? withSpring(0, MOLA_PAINEL) : withTiming(SCREEN_H, { duration: 200 });
  }, [p.aberto, y]);

  const pan = Gesture.Pan()
    .onUpdate((e) => { y.value = Math.max(0, e.translationY); })
    .onEnd((e) => {
      if (e.translationY > 120 || e.velocityY > 900) runOnJS(p.aoFechar)();
      else y.value = withSpring(0, MOLA_PAINEL);
    });

  const anim = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));

  return (
    <Modal visible={p.aberto} transparent animationType="none" onRequestClose={p.aoFechar} statusBarTranslucent>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <Animated.View style={[estilos.grande, anim]}>
          <GestureDetector gesture={pan}>
            <View style={estilos.grandeTopo}>
              <View style={estilos.puxadorClaro} />
            </View>
          </GestureDetector>

          <View style={estilos.grandeCapaCaixa}>{p.capa ? <CapaGrande capaId={p.coverId} /> : null}</View>

          <View style={estilos.grandeTexto}>
            <Text numberOfLines={2} style={estilos.grandeTitulo}>{p.titulo}</Text>
            <Pressable onPress={() => { p.aoFechar(); p.onChapterPress(); }} hitSlop={8}>
              <Text numberOfLines={1} style={estilos.grandeCapitulo}>{p.chapter}</Text>
            </Pressable>
          </View>

          <View style={estilos.grandeBarra}>
            <Barra
              pct={p.pct}
              largura={SCREEN_W - 48}
              alturaRepouso={5}
              alturaArrasto={11}
              onSeek={p.onSeekFraction}
              mostrarTempos
              elapsed={p.elapsed}
              total={p.total}
            />
          </View>

          <View style={estilos.grandeControles}>
            <Botao onPress={() => p.onSkip10(-1)} style={estilos.pularGrande}>
              <IconePular dir="back" tamanho={30} /><Text style={estilos.pularNumGrande}>10</Text>
            </Botao>
            <Botao onPress={p.onPlayPause} disabled={p.isLoading} style={estilos.tocarGrande} escala={0.92}>
              {p.isLoading ? <ActivityIndicator color={colors.ink} />
                : p.isPlaying ? <IconePausa tamanho={30} /> : <IconeTocar tamanho={30} />}
            </Botao>
            <Botao onPress={() => p.onSkip10(1)} style={estilos.pularGrande}>
              <IconePular dir="fwd" tamanho={30} /><Text style={estilos.pularNumGrande}>10</Text>
            </Botao>
          </View>

          <View style={estilos.grandeRodape}>
            <Pressable onPress={p.abrirVoz} style={estilos.grandePastilha}>
              <Text style={estilos.grandePastilhaRotulo}>Voz</Text>
              <Text numberOfLines={1} style={estilos.grandePastilhaValor}>{p.rotuloVoz}</Text>
            </Pressable>
            <Pressable onPress={p.abrirVel} style={estilos.grandePastilha}>
              <Text style={estilos.grandePastilhaRotulo}>Velocidade</Text>
              <Text style={estilos.grandePastilhaValor}>{p.rotuloVel}</Text>
            </Pressable>
          </View>
        </Animated.View>
      </GestureHandlerRootView>
    </Modal>
  );
}

function CapaGrande({ capaId }: { capaId: string }) {
  const [falhou, setFalhou] = useState(false);
  if (falhou) {
    return <View style={[estilos.grandeCapa, estilos.capaVazia]}><Text style={estilos.capaLetraGrande}>e</Text></View>;
  }
  return (
    <Image
      source={coverUrl(capaId)}
      style={estilos.grandeCapa}
      contentFit="cover"
      transition={250}
      onError={() => setFalhou(true)}
    />
  );
}

// ── Icones ────────────────────────────────────────────────────────────────
function IconeTocar({ tamanho = 20 }: { tamanho?: number }) {
  return <Svg width={tamanho} height={tamanho} viewBox="0 0 24 24" fill={colors.ink}><Path d="M8 5 L20 12 L8 19 Z" /></Svg>;
}
function IconePausa({ tamanho = 20 }: { tamanho?: number }) {
  return (
    <Svg width={tamanho} height={tamanho} viewBox="0 0 24 24" fill={colors.ink}>
      <Path d="M7 5 h3.5 v14 H7 Z" /><Path d="M13.5 5 H17 v14 h-3.5 Z" />
    </Svg>
  );
}
function IconePular({ dir, tamanho = 22 }: { dir: 'back' | 'fwd'; tamanho?: number }) {
  const d = dir === 'back'
    ? 'M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z'
    : 'M12 5V2l5 4-5 4V7a5 5 0 1 0 5 5h2a7 7 0 1 1-7-7z';
  return <Svg width={tamanho} height={tamanho} viewBox="0 0 24 24" fill="rgba(255,255,255,0.92)"><Path d={d} /></Svg>;
}

const estilos = StyleSheet.create({
  botaoInterior: { alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%' },

  // pilula
  pilula: {
    backgroundColor: SUPERFICIE,
    borderRadius: 20,
    overflow: 'hidden',
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.1)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.25,
    shadowRadius: 20,
    elevation: 12,
  },
  linhaPrincipal: { flexDirection: 'row', alignItems: 'center', paddingVertical: 11, paddingHorizontal: 12, gap: 10 },
  capa: { width: 40, height: 40, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.08)' },
  capaVazia: { alignItems: 'center', justifyContent: 'center' },
  capaLetra: { color: 'rgba(255,255,255,0.6)', fontSize: 20, fontWeight: '700' },
  capaLetraGrande: { color: 'rgba(255,255,255,0.5)', fontSize: 64, fontWeight: '700' },
  colunaInfo: { flex: 1, minWidth: 0 },
  capitulo: { color: 'white', fontSize: 14, fontWeight: '600' },
  meta: { color: 'rgba(255,255,255,0.55)', fontSize: 11, marginTop: 2 },
  pular: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  pularNum: { position: 'absolute', color: 'rgba(255,255,255,0.92)', fontSize: 8, fontWeight: '700', marginTop: 1 },
  tocar: { width: 46, height: 46, borderRadius: 23, backgroundColor: 'white' },

  // barra
  barraToque: { height: 22, justifyContent: 'center' },
  barraTrilho: { backgroundColor: 'rgba(255,255,255,0.14)', overflow: 'hidden', width: '100%' },
  barraCheia: { height: '100%', backgroundColor: ACENTO },
  barraPolegar: {
    position: 'absolute', left: 0, width: 14, height: 14, borderRadius: 7,
    backgroundColor: 'white',
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 4, shadowOffset: { width: 0, height: 1 },
  },
  temposLinha: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 2 },
  tempo: { color: 'rgba(255,255,255,0.5)', fontSize: 11, fontVariant: ['tabular-nums'] },
  tempoAtivo: { color: 'white', fontWeight: '600' },

  // folha
  // 🚨 56 de altura: a Apple pede 44pt de alvo e a linha anterior nao chegava la'.

  // tocando agora
  grande: { flex: 1, backgroundColor: SUPERFICIE_CHEIA, paddingHorizontal: 24 },
  grandeTopo: { paddingTop: 12, paddingBottom: 8, alignItems: 'center' },
  puxadorClaro: { width: 38, height: 5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.28)' },
  grandeCapaCaixa: { alignItems: 'center', marginTop: SCREEN_H > 800 ? 28 : 12 },
  grandeCapa: {
    width: Math.min(SCREEN_W - 96, 300), height: Math.min(SCREEN_W - 96, 300),
    borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.08)',
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 28, shadowOffset: { width: 0, height: 14 },
  },
  grandeTexto: { marginTop: 30 },
  grandeTitulo: { color: 'white', fontSize: 21, fontWeight: '700', letterSpacing: -0.3 },
  grandeCapitulo: { color: 'rgba(255,255,255,0.55)', fontSize: 15, marginTop: 5 },
  grandeBarra: { marginTop: 26, alignItems: 'center' },
  grandeControles: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 34, marginTop: 26 },
  pularGrande: { width: 58, height: 58, alignItems: 'center', justifyContent: 'center' },
  pularNumGrande: { position: 'absolute', color: 'rgba(255,255,255,0.92)', fontSize: 10, fontWeight: '700', marginTop: 1 },
  tocarGrande: { width: 76, height: 76, borderRadius: 38, backgroundColor: 'white' },
  grandeRodape: { flexDirection: 'row', gap: 12, marginTop: 'auto', marginBottom: 38 },
  grandePastilha: { flex: 1, backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 16, paddingVertical: 12, paddingHorizontal: 14 },
  grandePastilhaRotulo: { color: 'rgba(255,255,255,0.45)', fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.4 },
  grandePastilhaValor: { color: 'white', fontSize: 16, fontWeight: '600', marginTop: 3 },
});
