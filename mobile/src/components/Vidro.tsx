// Liquid Glass — o material do iOS 26, como FUNDO, nunca como embrulho.
//
// 🚨 A primeira versao disto punha os filhos DENTRO do `GlassView`:
//
//      <GlassView>{children}</GlassView>
//
//    `GlassView` e' uma view NATIVA. Se ela nao desenhar os filhos no
//    aparelho — e nao ha' como eu garantir isso sem um iPhone na mao — o
//    conteudo inteiro do player some. Nao e' «o vidro ficou feio»: e' a
//    pilula vazia, que de fora lê como app quebrado.
//
//    Agora o material vai numa camada ABSOLUTA atras, e os filhos ficam num
//    `View` normal do React Native. Se o vidro falhar, o pior caso e' a
//    pilula sem material — com todos os botoes no lugar.
//
// 🚨 E a deteccao saiu do escopo do MODULO. Antes ela rodava na importacao,
//    antes do React existir: qualquer tropeco ali e' tela branca, sem pista.
//    Agora e' preguicosa e memorizada.
//
// Regras da Apple que mandam aqui (`.docs/apple-hig.md`):
//   · «Liquid Glass forms a distinct FUNCTIONAL LAYER for controls and
//     navigation… that floats above the content layer.»
//   · «Don't use Liquid Glass in the content layer.»
//   · «Use Liquid Glass effects sparingly.»
import { Platform, StyleSheet, View } from 'react-native';
import { BlurView } from 'expo-blur';

/** Resolvido na PRIMEIRA chamada, ja' dentro do ciclo do React. */
let cache: boolean | null = null;
export function temVidro(): boolean {
  if (cache !== null) return cache;
  cache = false;
  if (Platform.OS === 'ios') {
    try {
      const m = require('expo-glass-effect');
      cache = !!(m?.isLiquidGlassAvailable?.() && m?.isGlassEffectAPIAvailable?.());
    } catch {
      cache = false;
    }
  }
  return cache;
}

function CamadaVidro({ variante, tom, escuro }: {
  variante: 'regular' | 'clear'; tom?: string; escuro: boolean;
}) {
  try {
    const { GlassView } = require('expo-glass-effect');
    return (
      <GlassView
        style={StyleSheet.absoluteFill}
        glassEffectStyle={variante}
        tintColor={tom}
        colorScheme={escuro ? 'dark' : 'light'}
        pointerEvents="none"
      />
    );
  } catch {
    return null;
  }
}

export function Vidro({
  children, style, variante = 'regular', tom, escuro = true, intensidadeAntiga = 45,
}: {
  children?: React.ReactNode;
  style?: any;
  /** `regular` e' o padrao; `clear` so' sobre fundo visualmente rico. */
  variante?: 'regular' | 'clear';
  tom?: string;
  escuro?: boolean;
  intensidadeAntiga?: number;
}) {
  const veu = escuro ? 'rgba(20,22,26,0.55)' : 'rgba(255,255,255,0.6)';

  if (temVidro()) {
    return (
      <View style={style}>
        <CamadaVidro variante={variante} tom={tom} escuro={escuro} />
        {children}
      </View>
    );
  }

  // Recuo: iOS anterior ao 26, Android, ou beta sem a API.
  // 🚨 Aqui o veu semitransparente E' necessario — o desfoque sozinho nao
  //    segura o contraste do texto branco. No caminho do vidro ele nao entra.
  if (Platform.OS === 'ios') {
    return (
      <View style={style}>
        <BlurView intensity={intensidadeAntiga} tint={escuro ? 'dark' : 'light'} style={StyleSheet.absoluteFill} />
        <View style={[StyleSheet.absoluteFill, { backgroundColor: veu }]} pointerEvents="none" />
        {children}
      </View>
    );
  }

  return (
    <View style={[style, { backgroundColor: escuro ? 'rgba(20,20,22,0.94)' : 'rgba(255,255,255,0.96)' }]}>
      {children}
    </View>
  );
}
