import { useState } from 'react';
import { View, Text, TextInput, Pressable, ActivityIndicator, KeyboardAvoidingView, Platform, Alert, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { login } from '@/lib/api';
import { EchoLogo } from '@/components/EchoLogo';
import { colors, tipo, espaco, raio } from '@/lib/theme';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  async function onSubmit() {
    if (!email || !password) return;
    setLoading(true);
    try {
      await login(email.trim(), password);
      router.replace('/');
    } catch (e: any) {
      Alert.alert('Erro', e?.response?.data?.detail || 'Email ou senha incorretos');
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.container}>
      <View style={styles.inner}>
        <View style={styles.logoRow}>
          <EchoLogo size="lg" />
        </View>

        <Text style={styles.title}>Entrar</Text>
        <Text style={styles.subtitle}>Sua biblioteca persiste entre web e celular</Text>

        <Text style={styles.label}>Email</Text>
        <TextInput
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          autoComplete="email"
          placeholder="seu@email.com"
          placeholderTextColor={colors.mist}
          style={styles.input}
        />

        <Text style={styles.label}>Senha</Text>
        <TextInput
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="password"
          placeholder="••••••••"
          placeholderTextColor={colors.mist}
          style={styles.input}
          onSubmitEditing={onSubmit}
        />

        <Pressable
          onPress={onSubmit}
          disabled={loading}
          style={({ pressed }) => [styles.btn, { opacity: pressed || loading ? 0.85 : 1 }]}
        >
          {loading ? <ActivityIndicator color={colors.snow} /> : (
            <Text style={styles.btnText}>Continuar</Text>
          )}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.snow },
  // 🚨 24 e' a grade; 28 nao era multiplo de 4 nem de 8.
  inner: { flex: 1, justifyContent: 'center', padding: espaco.ar },
  logoRow: { marginBottom: espaco.heroi },
  // 🚨 26pt nao existe na escala da Apple. Title 1 = 28/34.
  title: { ...tipo.titulo1, color: colors.ink, letterSpacing: -0.5, marginBottom: espaco.micro },
  subtitle: { ...tipo.nota, color: colors.slate, marginBottom: espaco.ar },
  label: { ...tipo.legenda, fontWeight: '600', color: colors.charcoal, marginBottom: espaco.micro },
  input: {
    backgroundColor: colors.white,
    color: colors.ink,
    // 🚨 Corpo e' 17pt: o padrao de leitura do iOS. 15 obrigava a apertar os
    //    olhos justamente onde se digita e-mail e senha.
    ...tipo.corpo,
    paddingHorizontal: espaco.padrao, paddingVertical: espaco.medio,
    borderRadius: raio.medio,
    marginBottom: espaco.padrao,
    borderWidth: 1, borderColor: colors.border,
  },
  btn: {
    backgroundColor: colors.ink,
    minHeight: 50,
    borderRadius: raio.medio,
    alignItems: 'center', justifyContent: 'center',
    marginTop: espaco.pequeno,
  },
  btnText: { ...tipo.destaque, color: colors.snow },
});
