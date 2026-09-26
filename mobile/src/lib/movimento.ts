// Respeito ao «Reduzir movimento» do iOS.
//
// 🚨 Por que existe: o app acabou de ganhar mola em todo botao, folha que sobe,
//    painel que desliza e barra que estica. Quem liga «Reduzir movimento» liga
//    porque movimento lhe faz mal — enjoo, vertigem, enxaqueca.
//
// 🚨 E o erro OPOSTO ja' nos custou uma vespera de apresentacao (protótipo do
//    Central Fleet, 21/08): uma regra universal com `!important` matou TODA
//    transicao, e a tela passou a parecer quebrada. O certo nao e' apagar o
//    movimento — e' trocar o que SALTA por algo que so' aparece:
//      · mola  -> tempo curto e linear (o objeto nao balanca, mas chega);
//      · voo   -> aparecer no lugar;
//      · escala do toque -> quase nada, mas nao zero (o toque ainda responde).
import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';
import { withSpring, withTiming, type WithSpringConfig } from 'react-native-reanimated';

export function useMovimentoReduzido(): boolean {
  const [reduzido, setReduzido] = useState(false);
  useEffect(() => {
    let vivo = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then(v => { if (vivo) setReduzido(!!v); })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', v => setReduzido(!!v));
    return () => { vivo = false; sub?.remove?.(); };
  }, []);
  return reduzido;
}

/**
 * Anima respeitando o ajuste. `reduzido` vem do hook, entao o componente
 * re-renderiza quando o ajuste muda e o worklet captura o valor novo.
 */
export function anima(valor: number, mola: WithSpringConfig, reduzido: boolean) {
  'worklet';
  return reduzido ? withTiming(valor, { duration: 130 }) : withSpring(valor, mola);
}
