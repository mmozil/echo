import { useState } from 'react';
import { View, Text, TextInput, Pressable, ActivityIndicator, KeyboardAvoidingView, Platform, Alert, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { login } from '@/lib/api';
import { EchoLogo } from '@/components/EchoLogo';
import { colors, fonts } from '@/lib/theme';

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
  inner: { flex: 1, justifyContent: 'center', padding: 28 },
  logoRow: { marginBottom: 48 },
  title: { color: colors.ink, fontSize: 26, fontWeight: '700', fontFamily: fonts.display, letterSpacing: -0.5, marginBottom: 4 },
  subtitle: { color: colors.slate, fontSize: 13, marginBottom: 28 },
  label: { color: colors.charcoal, fontSize: 12, fontWeight: '500', marginBottom: 6, letterSpacing: 0.2 },
  input: {
    backgroundColor: colors.white,
    color: colors.ink,
    paddingHorizontal: 14, paddingVertical: 13,
    borderRadius: 10, fontSize: 15,
    marginBottom: 16,
    borderWidth: 1, borderColor: colors.border,
  },
  btn: {
    backgroundColor: colors.ink,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 8,
  },
  btnText: { color: colors.snow, fontWeight: '600', fontSize: 15, letterSpacing: -0.1, fontFamily: fonts.body },
});
