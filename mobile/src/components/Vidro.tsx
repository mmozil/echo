// Liquid Glass — o material do iOS 26, nativo, com recuo seguro.
//
// Ate' aqui o app tinha UM `BlurView` (a pilula) e mais nada: material
// CLASSICO, nao Liquid Glass. Este arquivo troca pelo de verdade —
// `expo-glass-effect` embrulha o `UIVisualEffectView` do sistema, entao quem
// desenha e' o iOS, nao nos.
//
// 🚨 Onde ele PODE entrar, pela documentacao da Apple (`.docs/apple-hig.md`):
//   · «Liquid Glass forms a distinct FUNCTIONAL LAYER for controls and
//     navigation elements — like tab bars and sidebars — that floats above the
//     content layer.»  → a pilula do player e a barra de navegacao do leitor.
//   · «**Don't use Liquid Glass in the content layer.**» → as folhas de voz,
//     velocidade e capitulos sao LISTA, isto e', conteudo. Ficam solidas.
//   · «**Use Liquid Glass effects sparingly.**» → dois lugares, nao dez.
//   · «Only use clear Liquid Glass for components that appear over visually
//     rich backgrounds.» → `clear` so' onde passa a pagina do livro por baixo.
//
// 🚨 Duas armadilhas documentadas pela Expo:
//   1. «Setting opacity to 0 on GlassView or any parent views causes the glass
//      effect to not render.» — nunca animar opacidade neste componente nem em
//      pai dele; animar escala ou deslocamento.
//   2. Algumas betas do iOS 26 NAO TEM a API e o app quebra. Por isso
//      `isGlassEffectAPIAvailable()` decide, em tempo de execucao, entre vidro
//      e o desfoque antigo.
import { Platform, StyleSheet, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';

/** Verdadeiro so' quando o iOS realmente entrega o material — checado uma vez. */
export const TEM_VIDRO = (() => {
  if (Platform.OS !== 'ios') return false;
  try { return isLiquidGlassAvailable() && isGlassEffectAPIAvailable(); } catch { return false; }
})();

export function Vidro({
  children, style, variante = 'regular', tom, escuro = true, intensidadeAntiga = 45,
}: {
  children?: React.ReactNode;
  style?: any;
  /** `regular` e' o padrao da Apple; `clear` so' sobre fundo visualmente rico. */
  variante?: 'regular' | 'clear';
  tom?: string;
  escuro?: boolean;
  /** Usado so' no recuo para `expo-blur`, onde nao ha' Liquid Glass. */
  intensidadeAntiga?: number;
}) {
  if (TEM_VIDRO) {
    return (
      <GlassView
        style={style}
        glassEffectStyle={variante}
        tintColor={tom}
        colorScheme={escuro ? 'dark' : 'light'}
      >
        {children}
      </GlassView>
    );
  }

  // Recuo: iOS anterior ao 26, Android, ou beta sem a API.
  // 🚨 Aqui o fundo semitransparente E' necessario — o desfoque sozinho nao
  //    segura o contraste do texto branco. No caminho do vidro ele NAO entra,
  //    porque cobriria o material que o sistema desenha.
  if (Platform.OS === 'ios') {
    return (
      <BlurView intensity={intensidadeAntiga} tint={escuro ? 'dark' : 'light'} style={style}>
        <View style={[StyleSheet.absoluteFill, { backgroundColor: escuro ? 'rgba(20,20,22,0.55)' : 'rgba(255,255,255,0.6)' }]} />
        {children}
      </BlurView>
    );
  }
  return (
    <View style={[style, { backgroundColor: escuro ? 'rgba(20,20,22,0.92)' : 'rgba(255,255,255,0.94)' }]}>
      {children}
    </View>
  );
}
